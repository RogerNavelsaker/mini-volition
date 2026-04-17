import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createConnection } from "net";
import { startInferenceServer } from "./server";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

function request(socketPath: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket request timed out"));
    }, 1000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline).trim()));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("inference-local server", () => {
  test("responds to heartbeat requests on the unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-volition-local-heartbeat-"));
    cleanup.push(dir);
    const socketPath = join(dir, "local.sock");
    const server = startInferenceServer(socketPath, async () => ({ ok: true }), "LOCAL-TEST");

    try {
      const response = await request(socketPath, { type: "heartbeat" });
      expect(response.ok).toBe(true);
      expect(response.type).toBe("heartbeat");
      expect(response.label).toBe("LOCAL-TEST");
      expect(typeof response.pid).toBe("number");
      expect(typeof response.uptime_ms).toBe("number");
      expect(typeof response.now).toBe("string");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
