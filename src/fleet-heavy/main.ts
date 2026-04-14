import { join, resolve, dirname } from "path";
import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  env,
} from "@huggingface/transformers";
import { startInferenceServer } from "../fleet-inference/server";

const socketPath = resolve(process.env.FLEET_HEAVY_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/heavy.sock"));
const modelId = process.env.FLEET_HEAVY_MODEL || "onnx-community/gemma-4-E4B-it-ONNX";
const modelDType = process.env.FLEET_HEAVY_DTYPE || "q4f16";
const maxNewTokens = Number(process.env.FLEET_HEAVY_MAX_TOKENS || "320");
const cacheDir = process.env.FLEET_INFERENCE_CACHE_DIR || `${dirname(socketPath)}/.cache/transformers`;

env.allowRemoteModels = true;
env.allowLocalModels = true;
env.useFSCache = true;
env.cacheDir = cacheDir;

let modelPromise: Promise<{
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof Gemma4ForConditionalGeneration.from_pretrained>>;
}> | null = null;

async function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      console.log(`[HEAVY] Loading model ${modelId} with dtype=${modelDType}`);
      const processor = await AutoProcessor.from_pretrained(modelId);
      const model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
        dtype: modelDType as any,
        device: "cpu",
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
      const prompt = `You are ${scribeName}, a local scribe in a persistent multi-agent runtime. You have been delegated the following task by a cloud agent. Complete it concisely and return your result as plain text.\n\nTask:\n${request.task.trim().slice(0, 2400)}`;
      const result = await generate(prompt);
      return { result, source: modelId };
    }
    default:
      throw new Error(`Unsupported request type: ${request.type}. This worker handles 'compact', 'extract_entities', 'hyde', and 'scribe'.`);
  }
}

startInferenceServer(socketPath, handleRequest, "HEAVY");
