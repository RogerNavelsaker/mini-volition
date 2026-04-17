/**
 * inference-cloud-openrouter — Cloud provider worker for OpenRouter API.
 * Uses OpenAI SDK with base URL override (OpenRouter is OpenAI-compatible).
 * One process, one Unix socket, same protocol as local inference workers.
 */
import OpenAI from "openai";
import { join, resolve } from "path";
import { startProviderServer, type TurnRequest, type TurnResponse } from "../inference-cloud/server";

const socketPath = resolve(process.env.INFERENCE_CLOUD_OPENROUTER_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/openrouter.sock"));
const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error("[inference-cloud-openrouter] OPENROUTER_API_KEY is required");
  process.exit(1);
}

const client = new OpenAI({
  apiKey,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/RogerNavelsaker/mini-volition",
    "X-Title": "mini-volition",
  },
});

// Rate limit state
let rateLimitResetAt = 0;

async function handleTurn(request: TurnRequest): Promise<TurnResponse> {
  const now = Date.now();
  if (rateLimitResetAt > now) {
    const waitSec = Math.ceil((rateLimitResetAt - now) / 1000);
    return {
      content: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      model: request.model,
      stop_reason: "rate_limited",
      source: "openrouter",
      error: `Rate limited. Retry after ${waitSec}s.`,
    };
  }

  try {
    const response = await client.chat.completions.create({
      model: request.model,
      max_tokens: request.max_tokens ?? 8192,
      temperature: request.temperature ?? 1.0,
      messages: [
        { role: "system", content: request.system },
        ...request.messages,
      ],
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";

    return {
      content,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
      stop_reason: choice?.finish_reason ?? "stop",
      source: "openrouter",
    };
  } catch (error: any) {
    if (error instanceof OpenAI.RateLimitError) {
      const retryAfter = error.headers?.["retry-after"];
      const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
      rateLimitResetAt = Date.now() + retryMs;
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        model: request.model,
        stop_reason: "rate_limited",
        source: "openrouter",
        error: `Rate limited (429). Retry after ${Math.ceil(retryMs / 1000)}s.`,
      };
    }

    if (error instanceof OpenAI.APIError) {
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        model: request.model,
        stop_reason: "error",
        source: "openrouter",
        error: `API error ${error.status}: ${error.message}`,
      };
    }

    throw error;
  }
}

startProviderServer(socketPath, handleTurn, "inference-cloud-openrouter");
