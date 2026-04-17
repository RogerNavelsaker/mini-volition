import { unlinkSync } from "fs";
import { createServer, type Socket } from "net";

export type RequestHandler = (request: any) => Promise<any>;

export function startInferenceServer(socketPath: string, handler: RequestHandler, label: string) {
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
          const request = JSON.parse(line);
          const response = await handler(request);
          connection.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          connection.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      }
    });
  });

  server.listen(socketPath, () => {
    console.log(`[${label}] Listening on ${socketPath}`);
  });

  return server;
}
