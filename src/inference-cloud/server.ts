/**
 * Shared server factory for cloud provider workers.
 * Same Unix socket + newline-JSON protocol as local inference workers.
 *
 * Each provider worker (inference-cloud-anthropic, inference-cloud-google, inference-cloud-openai, inference-cloud-openrouter)
 * imports this and supplies a provider-specific handler.
 */
import { unlinkSync } from "fs";
import { createServer, type Socket } from "net";

export type TurnRequest = {
  type: "turn";
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens?: number;
  temperature?: number;
};

export type TurnResponse = {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  stop_reason: string;
  source: string;
  error?: string;
};

export type ProviderHandler = (request: TurnRequest) => Promise<TurnResponse>;

export function startProviderServer(socketPath: string, handler: ProviderHandler, label: string) {
  try {
    unlinkSync(socketPath);
  } catch {}

  const server = createServer((connection: Socket) => {
    let buffer = "";

    connection.on("data", async (chunk) => {
      buffer += chunk.toString("utf-8");

      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;

        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        try {
          const request = JSON.parse(line) as TurnRequest;
          if (request.type !== "turn") {
            connection.write(`${JSON.stringify({ error: `Unknown request type: ${request.type}` })}\n`);
            continue;
          }
          const response = await handler(request);
          connection.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          connection.write(`${JSON.stringify({ error: errorMsg, content: "", usage: { input_tokens: 0, output_tokens: 0 }, model: "unknown", stop_reason: "error", source: label })}\n`);
        }
      }
    });
  });

  server.listen(socketPath, () => {
    console.log(`[${label}] Listening on ${socketPath}`);
  });

  return server;
}
