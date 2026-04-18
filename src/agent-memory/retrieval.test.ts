import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { estimateTokenCost, selectBudgetedRows } from "./retrieval";
import { ensureSchema } from "./schema";

describe("retrieval budgeting", () => {
  test("estimates non-zero token cost", () => {
    expect(estimateTokenCost("tiny")).toBeGreaterThan(0);
  });

  test("packs rows until the token budget is exhausted", () => {
    const rows = [
      { id: 1, content: "a".repeat(80) },
      { id: 2, content: "b".repeat(80) },
      { id: 3, content: "c".repeat(80) },
    ];

    const result = selectBudgetedRows(rows, 70);
    expect(result.rows.map((row) => row.id)).toEqual([1, 2]);
    expect(result.tokensUsed).toBeLessThanOrEqual(70);
    expect(result.dropped).toBe(1);
  });

  test("still returns the top row when it alone exceeds the budget", () => {
    const rows = [
      { id: 1, content: "a".repeat(400) },
      { id: 2, content: "b".repeat(20) },
    ];

    const result = selectBudgetedRows(rows, 32);
    expect(result.rows.map((row) => row.id)).toEqual([1]);
    expect(result.dropped).toBe(1);
  });
});

describe("raw retrieval mode", () => {
  const tempDir = join(process.cwd(), ".tmp-memory-raw-test");
  const dbPath = join(tempDir, "runtime/agent-memory.db");

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns direct raw rows without enriched memory sections", () => {
    resetTempDir();
    const db = new Database(dbPath);
    ensureSchema(db);
    db.run(
      `INSERT INTO agent_memory_search_index (record_kind, record_id, agent_name, source_kind, content, embedding_json, updated_at)
       VALUES ('artifact', 1, 'codex', 'verbatim', 'Exact raw wording for the incident report.', NULL, CURRENT_TIMESTAMP)`,
    );
    db.run(
      `INSERT INTO agent_memory_artifacts (
         id, agent_name, source_kind, source_table, source_id, content, content_hash, embedding_json, embedding_model,
         importance, strength, recall_count, decay_score, status, created_at, updated_at
       ) VALUES (1, 'codex', 'verbatim', 'tier0_verbatim', 1, 'Exact raw wording for the incident report.', 'h1', NULL, NULL, 'normal', 1.0, 0, 1.0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    db.run(
      `INSERT INTO agent_memory_refresh_state (agent_name, last_refresh_at, last_status, last_error, artifact_count, source, error_streak, updated_at)
       VALUES ('codex', CURRENT_TIMESTAMP, 'ready', NULL, 1, 'test', 0, CURRENT_TIMESTAMP)`,
    );
    db.close();

    const payload = JSON.parse(
      execSync(`AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts lookup codex "incident report" 3 raw`).toString("utf-8"),
    ) as {
      retrievalMode: string;
      memorySelection: string;
      recentDigests: unknown[];
      rawResults: Array<{ source_kind: string; content: string }>;
    };

    expect(payload.retrievalMode).toBe("raw");
    expect(payload.memorySelection).toContain("raw direct retrieval");
    expect(payload.recentDigests).toHaveLength(0);
    expect(payload.rawResults).toHaveLength(1);
    expect(payload.rawResults[0]?.source_kind).toBe("verbatim");
    expect(payload.rawResults[0]?.content).toContain("Exact raw wording");
  });
});
