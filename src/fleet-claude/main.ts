/**
 * fleet-claude — Cloud provider worker for Anthropic Claude models.
 * One process, one Unix socket, same protocol as local inference workers.
 * Manages per-provider rate limits and retry logic.
 */
import Anthropic from "@anthropic-ai/sdk";
import { join, resolve } from "path";
import { startProviderServer, type TurnRequest, type TurnResponse } from "../fleet-provider/server";

const socketPath = resolve(process.env.FLEET_CLAUDE_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/claude.sock"));
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error("[fleet-claude] ANTHROPIC_API_KEY is required");
  process.exit(1);
}

const client = new Anthropic({ apiKey });

// Rate limit state
let rateLimitResetAt = 0;
let requestsRemaining: number | null = null;

async function handleTurn(request: TurnRequest): Promise<TurnResponse> {
  // Check rate limit backoff
  const now = Date.now();
  if (rateLimitResetAt > now) {
    const waitSec = Math.ceil((rateLimitResetAt - now) / 1000);
    return {
      content: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      model: request.model,
      stop_reason: "rate_limited",
      source: "anthropic",
      error: `Rate limited. Retry after ${waitSec}s (resets at ${new Date(rateLimitResetAt).toISOString()})`,
    };
  }

  try {
    const response = await client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens ?? 8192,
      temperature: request.temperature ?? 1.0,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    // Extract rate limit headers from response headers if available
    // The SDK exposes these via response._request_id and headers
    const headers = (response as any)._headers;
    if (headers) {
      const remaining = headers["anthropic-ratelimit-requests-remaining"];
      const resetAt = headers["anthropic-ratelimit-requests-reset"];
      if (remaining !== undefined) requestsRemaining = parseInt(remaining, 10);
      if (resetAt) rateLimitResetAt = new Date(resetAt).getTime();
    }

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      content,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      model: response.model,
      stop_reason: response.stop_reason ?? "end_turn",
      source: "anthropic",
    };
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      // Extract retry-after from error response
      const retryAfter = (error as any).headers?.["retry-after"];
      const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
      rateLimitResetAt = Date.now() + retryMs;
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        model: request.model,
        stop_reason: "rate_limited",
        source: "anthropic",
        error: `Rate limited (429). Retry after ${Math.ceil(retryMs / 1000)}s.`,
      };
    }

    if (error instanceof Anthropic.APIError) {
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        model: request.model,
        stop_reason: "error",
        source: "anthropic",
        error: `API error ${error.status}: ${error.message}`,
      };
    }

    throw error;
  }
}

startProviderServer(socketPath, handleTurn, "fleet-claude");
