/**
 * inference-cloud-google — Cloud provider worker for Google Gemini models.
 * One process, one Unix socket, same protocol as local inference workers.
 */
import { GoogleGenAI } from "@google/genai";
import { join, resolve } from "path";
import { startProviderServer, type TurnRequest, type TurnResponse } from "../inference-cloud/server";

const socketPath = resolve(process.env.INFERENCE_CLOUD_GOOGLE_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/gemini.sock"));
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("[inference-cloud-google] GOOGLE_API_KEY or GEMINI_API_KEY is required");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

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
      source: "google",
      error: `Rate limited. Retry after ${waitSec}s.`,
    };
  }

  try {
    const response = await ai.models.generateContent({
      model: request.model,
      contents: [
        ...request.messages.map((m) => ({
          role: m.role === "assistant" ? "model" as const : "user" as const,
          parts: [{ text: m.content }],
        })),
      ],
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.max_tokens ?? 8192,
        temperature: request.temperature ?? 1.0,
        responseMimeType: "text/plain",
      },
    });

    const content = response.text ?? "";
    const usage = response.usageMetadata;

    return {
      content,
      usage: {
        input_tokens: usage?.promptTokenCount ?? 0,
        output_tokens: usage?.candidatesTokenCount ?? 0,
      },
      model: request.model,
      stop_reason: response.candidates?.[0]?.finishReason ?? "stop",
      source: "google",
    };
  } catch (error: any) {
    const status = error?.status ?? error?.code;
    if (status === 429) {
      const retryMs = 60_000;
      rateLimitResetAt = Date.now() + retryMs;
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        model: request.model,
        stop_reason: "rate_limited",
        source: "google",
        error: `Rate limited (429). Retry after ${Math.ceil(retryMs / 1000)}s.`,
      };
    }

    return {
      content: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      model: request.model,
      stop_reason: "error",
      source: "google",
      error: `API error: ${error?.message ?? String(error)}`,
    };
  }
}

startProviderServer(socketPath, handleTurn, "inference-cloud-google");
