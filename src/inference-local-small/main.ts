import { join, resolve, dirname } from "path";
import {
  AutoProcessor,
  AutoModelForImageTextToText,
  env,
} from "@huggingface/transformers";
import { startInferenceServer } from "../inference-local/server";

const socketPath = resolve(process.env.INFERENCE_LOCAL_SMALL_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/light.sock"));
const modelId = process.env.INFERENCE_LOCAL_SMALL_MODEL || "onnx-community/gemma-4-E2B-it-ONNX";
const modelDType = process.env.INFERENCE_LOCAL_SMALL_DTYPE || "q4f16";
const maxNewTokens = Number(process.env.INFERENCE_LOCAL_SMALL_MAX_TOKENS || "160");
const cacheDir = process.env.INFERENCE_LOCAL_CACHE_DIR || `${dirname(socketPath)}/.cache/transformers`;

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
      console.log(`[LIGHT] Loading model ${modelId} with dtype=${modelDType}`);
      const processor = await AutoProcessor.from_pretrained(modelId);
      const model = await AutoModelForImageTextToText.from_pretrained(modelId, {
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

type FleetMessage = {
  id: number;
  layer: string;
  recipient: string;
  sender: string;
  body: string;
  created_at: string;
};

function buildSummarizePrompt(messages: FleetMessage[]) {
  const transcript = messages
    .map((m) => `- ${m.created_at} ${m.sender}${m.recipient.toLowerCase() === "all" ? "" : ` -> ${m.recipient}`} [${m.layer}]: ${m.body}`)
    .join("\n");

  return `You are the inference backend for a shared fleet service in a persistent multi-agent system.
Summarize this public chat burst for sleeping agents.
Return strict JSON with keys:
- summary: one sentence, under 220 characters
- decisions: array of up to 3 short strings

Transcript:
${transcript}`;
}

function buildRetrievalModePrompt(request: { source: string; layer: string; text: string }) {
  return `You are the inference backend for a persistent multi-agent runtime.
Choose the best retrieval mode for this turn.
Return strict JSON with keys:
- mode: one of "local", "global", "mix"
- reason: one short sentence

Guidance:
- local: exact, urgent, private, narrow, debugging, file-level, immediate task resolution
- global: planning, overview, architecture, broad status, synthesis across sessions
- mix: both immediate and broader context likely matter

Wake source: ${request.source}
Primary layer: ${request.layer}
Turn text:
${request.text.slice(0, 2000)}`;
}

function buildTurnProfilePrompt(request: { source: string; layer: string; text: string }) {
  return `You are the inference backend for a persistent multi-agent runtime.
Choose the best execution profile for this turn.
Return strict JSON with keys:
- profile: one of "light", "full", "max"
- reason: one short sentence

Guidance:
- light: cheap acknowledgement, simple status, low-risk triage, no deep reasoning needed
- full: standard problem solving, normal private turns, most internal jobs
- max: urgent, critical, escalation-prone, or unusually high-stakes turns

Wake source: ${request.source}
Primary layer: ${request.layer}
Turn text:
${request.text.slice(0, 2000)}`;
}

async function handleRequest(request: any) {
  switch (request.type) {
    case "summarize": {
      if (!Array.isArray(request.messages)) throw new Error("summarize requires messages[]");
      const raw = await generate(buildSummarizePrompt(request.messages));
      const parsed = JSON.parse(raw) as { summary?: string; decisions?: string[] };
      if (!parsed.summary || !Array.isArray(parsed.decisions)) {
        throw new Error(`Model returned malformed JSON: ${raw}`);
      }
      return {
        summary: parsed.summary.replace(/\s+/g, " ").trim(),
        decisions: parsed.decisions.map((entry) => entry.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3),
        source: modelId,
      };
    }
    case "choose_retrieval_mode": {
      if (typeof request.text !== "string" || typeof request.layer !== "string" || typeof request.source !== "string") {
        throw new Error("choose_retrieval_mode requires source, layer, and text");
      }
      const raw = await generate(buildRetrievalModePrompt(request), 80);
      const parsed = JSON.parse(raw) as { mode?: string; reason?: string };
      const mode = parsed.mode === "local" || parsed.mode === "global" || parsed.mode === "mix" ? parsed.mode : null;
      if (!mode || typeof parsed.reason !== "string") {
        throw new Error(`Model returned malformed JSON: ${raw}`);
      }
      return { mode, reason: parsed.reason.replace(/\s+/g, " ").trim(), source: modelId };
    }
    case "choose_turn_profile": {
      if (typeof request.text !== "string" || typeof request.layer !== "string" || typeof request.source !== "string") {
        throw new Error("choose_turn_profile requires source, layer, and text");
      }
      const raw = await generate(buildTurnProfilePrompt(request), 80);
      const parsed = JSON.parse(raw) as { profile?: string; reason?: string };
      const profile = parsed.profile === "light" || parsed.profile === "full" || parsed.profile === "max" ? parsed.profile : null;
      if (!profile || typeof parsed.reason !== "string") {
        throw new Error(`Model returned malformed JSON: ${raw}`);
      }
      return { profile, reason: parsed.reason.replace(/\s+/g, " ").trim(), source: modelId };
    }
    case "decompose_keywords": {
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (!text) throw new Error("decompose_keywords requires non-empty text");
      const prompt = `You are the inference backend for a persistent multi-agent runtime.
Decompose this query into high-level (thematic, conceptual) and low-level (specific, entity-level) keywords for dual retrieval.
Return strict JSON with keys:
- high_level: array of 1-4 thematic keywords or short phrases
- low_level: array of 1-4 specific entity names, identifiers, or technical terms

Query:
${text.slice(0, 1800)}`;
      const raw = await generate(prompt, 120);
      const parsed = JSON.parse(raw) as { high_level?: string[]; low_level?: string[] };
      if (!Array.isArray(parsed.high_level) || !Array.isArray(parsed.low_level)) {
        throw new Error(`Model returned malformed JSON: ${raw}`);
      }
      return {
        high_level: parsed.high_level.map((k) => String(k).trim()).filter(Boolean).slice(0, 4),
        low_level: parsed.low_level.map((k) => String(k).trim()).filter(Boolean).slice(0, 4),
        source: modelId,
      };
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
      throw new Error(`Unsupported request type: ${request.type}. This worker handles 'summarize', 'choose_retrieval_mode', 'choose_turn_profile', 'decompose_keywords', and 'scribe'.`);
  }
}

startInferenceServer(socketPath, handleRequest, "LIGHT");
