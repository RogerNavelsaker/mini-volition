import { join, resolve, dirname } from "path";
import {
  AutoProcessor,
  AutoModelForImageTextToText,
  env,
} from "@huggingface/transformers";
import { resolveLocalDevice } from "../inference-local/device";
import { startInferenceServer } from "../inference-local/server";
import { buildScribePrompt } from "../inference-local/scribe-prompts";

const socketPath = resolve(process.env.INFERENCE_LOCAL_MEDIUM_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/heavy.sock"));
const modelId = process.env.INFERENCE_LOCAL_MEDIUM_MODEL || "onnx-community/gemma-4-E4B-it-ONNX";
const modelDType = process.env.INFERENCE_LOCAL_MEDIUM_DTYPE || "q4f16";
const maxNewTokens = Number(process.env.INFERENCE_LOCAL_MEDIUM_MAX_TOKENS || "320");
const cacheDir = process.env.INFERENCE_LOCAL_CACHE_DIR || `${dirname(socketPath)}/.cache/transformers`;
const deviceConfig = resolveLocalDevice("medium");

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.useFSCache = true;
env.cacheDir = cacheDir;

let modelPromise: Promise<{
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForImageTextToText.from_pretrained>>;
}> | null = null;

async function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      console.log(`[MEDIUM] Loading model ${modelId} with dtype=${modelDType} device=${deviceConfig.device} source=${deviceConfig.source}`);
      const processor = await AutoProcessor.from_pretrained(modelId);
      const model = await AutoModelForImageTextToText.from_pretrained(modelId, {
        dtype: modelDType as any,
        device: deviceConfig.device as any,
      });
      return { processor, model };
    })();
  }
  return modelPromise;
}

async function generate(promptText: string, tokens?: number): Promise<string> {
  const { processor, model } = await getModel();
  const prompt = processor.apply_chat_template(
    [{ role: "user", content: [{ type: "text", text: promptText }] }],
    { enable_thinking: false, add_generation_prompt: true },
  );
  const inputs = await processor(prompt, { add_special_tokens: false } as any);
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: tokens ?? maxNewTokens,
    do_sample: false,
  });
  const promptLength = inputs.input_ids.dims.at(-1) || 0;
  const decoded = processor.batch_decode(outputs.slice(null, [promptLength, null]), {
    skip_special_tokens: true,
  });
  const raw = decoded[0]?.trim();
  if (!raw) throw new Error("Model produced empty output");
  return raw;
}

function buildCompactionPrompt(entries: string[], goal?: string) {
  return `You are the inference backend for a persistent multi-agent runtime.
Compress the following memory fragments into one durable archival lesson.
Goal: ${goal?.trim() || "Preserve stable lessons, decisions, or recurring patterns."}
Return strict JSON with keys:
- summary: one compact paragraph under 280 characters
- lessons: array of 1 to 3 short durable lessons
- facts: array of up to 3 stable facts
- decisions: array of up to 3 durable decisions
- patterns: array of up to 3 recurring patterns
- open_risks: array of up to 3 unresolved risks

Entries:
${entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`;
}

function buildEntityExtractionPrompt(text: string) {
  return `You are the inference backend for a persistent multi-agent runtime.
Extract typed entity-relation tuples from the following text.
Return strict JSON with key:
- entities: array of objects, each with keys: subject, predicate, object, description
Each tuple captures a factual relationship. Maximum 10 tuples.

Text:
${text.slice(0, 2400)}`;
}

async function handleRequest(request: any) {
  switch (request.type) {
    case "compact": {
      const entries = (request.entries || []).map((entry: string) => entry.trim()).filter(Boolean).slice(0, 8);
      if (entries.length === 0) throw new Error("compact requires at least one non-empty entry");
      const raw = await generate(buildCompactionPrompt(entries, request.goal));
      const parsed = JSON.parse(raw) as {
        summary?: string;
        lessons?: string[];
        facts?: string[];
        decisions?: string[];
        patterns?: string[];
        open_risks?: string[];
      };
      if (!parsed.summary || !Array.isArray(parsed.lessons)) {
        throw new Error(`Model returned malformed JSON: ${raw}`);
      }
      return {
        summary: parsed.summary.replace(/\s+/g, " ").trim(),
        lessons: parsed.lessons.map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
        facts: (parsed.facts ?? []).map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
        decisions: (parsed.decisions ?? []).map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
        patterns: (parsed.patterns ?? []).map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
        open_risks: (parsed.open_risks ?? []).map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
        source: modelId,
      };
    }
    case "extract_entities": {
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (!text) throw new Error("extract_entities requires non-empty text");
      const raw = await generate(buildEntityExtractionPrompt(text));
      const parsed = JSON.parse(raw) as {
        entities?: Array<{ subject?: string; predicate?: string; object?: string; description?: string }>;
      };
      if (!Array.isArray(parsed.entities)) {
        throw new Error(`Model returned malformed JSON: ${raw}`);
      }
      return {
        entities: parsed.entities
          .filter((e) => e.subject && e.predicate && e.object)
          .slice(0, 10)
          .map((e) => ({
            subject: String(e.subject).trim(),
            predicate: String(e.predicate).trim(),
            object: String(e.object).trim(),
            description: String(e.description ?? "").trim(),
          })),
        source: modelId,
      };
    }
    case "hyde": {
      const query = typeof request.query === "string" ? request.query.trim() : "";
      if (!query) throw new Error("hyde requires a non-empty query string");
      const prompt = `You are a memory retrieval assistant in a persistent multi-agent runtime.
Given this search query, write a short hypothetical document (under 200 words) that would perfectly answer it.
Write as if you are stating known facts, not asking questions. Be specific and concrete.

Query:
${query.slice(0, 1200)}`;
      const hypothesis = await generate(prompt, 200);
      return { hypothesis, source: modelId };
    }
    case "scribe": {
      if (typeof request.task !== "string" || !request.task.trim()) {
        throw new Error("scribe requires a non-empty task string");
      }
      const scribeName = typeof request.name === "string" ? request.name.trim() : "scribe";
      const prompt = buildScribePrompt(scribeName, request.task);
      const result = await generate(prompt);
      return { result, source: modelId };
    }
    default:
      throw new Error(`Unsupported request type: ${request.type}. This worker handles 'compact', 'extract_entities', 'hyde', and 'scribe'.`);
  }
}

startInferenceServer(socketPath, handleRequest, "MEDIUM");
