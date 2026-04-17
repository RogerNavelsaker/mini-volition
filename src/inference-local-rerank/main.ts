import { join, resolve, dirname } from "path";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
} from "@huggingface/transformers";
import { startInferenceServer } from "../inference-local/server";

const socketPath = resolve(process.env.INFERENCE_LOCAL_RERANK_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/rerank.sock"));
const modelId = process.env.INFERENCE_LOCAL_RERANK_MODEL || "onnx-community/bge-reranker-v2-m3-ONNX";
const modelDType = process.env.INFERENCE_LOCAL_RERANK_DTYPE || "q4";
const cacheDir = process.env.INFERENCE_LOCAL_CACHE_DIR || `${dirname(socketPath)}/.cache/transformers`;

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.useFSCache = true;
env.cacheDir = cacheDir;

let rerankerPromise: Promise<{
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
}> | null = null;

async function getReranker() {
  if (!rerankerPromise) {
    rerankerPromise = (async () => {
      console.log(`[RERANK] Loading model ${modelId} with dtype=${modelDType}`);
      const tokenizer = await AutoTokenizer.from_pretrained(modelId);
      const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
        dtype: modelDType as any,
        device: "cpu",
      });
      return { tokenizer, model };
    })();
  }
  return rerankerPromise;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

async function handleRequest(request: any) {
  if (request.type !== "rerank") {
    throw new Error(`Unsupported request type: ${request.type}. This worker only handles 'rerank'.`);
  }

  const query = request.query?.trim();
  const passages = (request.passages || []).map((entry: string) => entry.trim()).filter(Boolean);
  if (!query) throw new Error("rerank requires a non-empty query");
  if (passages.length === 0) throw new Error("rerank requires at least one non-empty passage");

  const { tokenizer, model } = await getReranker();
  const modelInputs = tokenizer(Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
  });
  const outputs = await model(modelInputs);
  const rawLogits = (outputs.logits as any).tolist() as number[] | number[][];
  const logits = Array.isArray(rawLogits[0])
    ? (rawLogits as number[][]).map((row) => Number(row[0] ?? 0))
    : (rawLogits as number[]).map((value) => Number(value));
  const normalized = request.normalize ?? true;

  const results = passages
    .map((text: string, index: number) => ({
      index,
      text,
      score: normalized ? sigmoid(logits[index] ?? 0) : (logits[index] ?? 0),
    }))
    .sort((left: any, right: any) => right.score - left.score);

  const topK = request.top_k == null ? null : Math.max(1, request.top_k);
  return {
    results: topK === null ? results : results.slice(0, topK),
    normalized,
    source: modelId,
  };
}

startInferenceServer(socketPath, handleRequest, "RERANK");
