import { join, resolve, dirname } from "path";
import { env, pipeline } from "@huggingface/transformers";
import { startInferenceServer } from "../inference-local/server";

const socketPath = resolve(process.env.INFERENCE_LOCAL_EMBED_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/embed.sock"));
const modelId = process.env.INFERENCE_LOCAL_EMBED_MODEL || "Xenova/bge-m3";
const modelDType = process.env.INFERENCE_LOCAL_EMBED_DTYPE || "q8";
const cacheDir = process.env.INFERENCE_LOCAL_CACHE_DIR || `${dirname(socketPath)}/.cache/transformers`;

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.useFSCache = true;
env.cacheDir = cacheDir;

let embedderPromise: Promise<any> | null = null;

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      console.log(`[EMBED] Loading model ${modelId} with dtype=${modelDType}`);
      return pipeline("feature-extraction", modelId, {
        dtype: modelDType as any,
        device: "cpu",
      });
    })();
  }
  return embedderPromise;
}

type EmbedRequest = {
  type: "embed";
  texts: string[] | string;
  normalize?: boolean;
  pooling?: "none" | "mean" | "cls" | "first_token" | "eos" | "last_token";
};

async function handleRequest(request: any) {
  if (request.type !== "embed") {
    throw new Error(`Unsupported request type: ${request.type}. This worker only handles 'embed'.`);
  }

  const texts = (Array.isArray(request.texts) ? request.texts : [request.texts])
    .map((entry: string) => entry.trim())
    .filter(Boolean);
  if (texts.length === 0) throw new Error("embed requires at least one non-empty text");

  const embedder = await getEmbedder();
  const pooling = request.pooling ?? "mean";
  const normalized = request.normalize ?? true;
  const tensor = await embedder(texts, { pooling, normalize: normalized });
  const raw = tensor.tolist() as number[] | number[][];
  const embeddings = Array.isArray(raw[0]) ? raw as number[][] : [raw as number[]];

  return {
    embeddings,
    dims: embeddings[0]?.length ?? 0,
    normalized,
    pooling,
    source: modelId,
  };
}

startInferenceServer(socketPath, handleRequest, "EMBED");
