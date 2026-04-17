/**
 * inference-cloud-openai — Cloud provider worker for OpenAI models.
 * One process, one Unix socket, same protocol as local inference workers.
 */
import OpenAI from "openai";
import { join, resolve } from "path";
import { startProviderServer, type TurnRequest, type TurnResponse } from "../inference-cloud/server";

const socketPath = resolve(process.env.INFERENCE_CLOUD_OPENAI_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/openai.sock"));
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("[inference-cloud-openai] OPENAI_API_KEY is required");
  process.exit(1);
}

const client = new OpenAI({ apiKey });

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
      source: "openai",
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

    // Parse rate limit headers from response
    const headers = (response as any)._headers ?? (response as any).headers;
    if (headers) {
      const resetAt = headers["x-ratelimit-reset-requests"];
      if (resetAt) rateLimitResetAt = new Date(resetAt).getTime();
    }

    return {
      content,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
      stop_reason: choice?.finish_reason ?? "stop",
      source: "openai",
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
        source: "openai",
        error: `Rate limited (429). Retry after ${Math.ceil(retryMs / 1000)}s.`,
      };
    }

    if (error instanceof OpenAI.APIError) {
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        model: request.model,
        stop_reason: "error",
        source: "openai",
        error: `API error ${error.status}: ${error.message}`,
      };
    }

    throw error;
  }
}

startProviderServer(socketPath, handleTurn, "inference-cloud-openai");
