import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";

describe("Verbatim Fragments", () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `test-verbatim-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "agent-memory.db");
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("should ingest verbatim fragment through the CLI", () => {
    const agentName = "test-agent";
    const source = "test-source";
    const content = "This is a raw verbatim fragment content.";

    execSync(
      `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts push-verbatim ${agentName} ${source} "${content}"`,
      { cwd: process.cwd() },
    );

    const db = new Database(dbPath);
    const row = db.prepare("SELECT * FROM tier0_verbatim WHERE agent_name = ?").get(agentName) as any;
    db.close();

    expect(row).toBeDefined();
    expect(row.agent_name).toBe(agentName);
    expect(row.source).toBe(source);
    expect(row.content).toBe(content);
    expect(row.timestamp).toBeDefined();
  });
});
