import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { Database } from "bun:sqlite";
import { defaultRetentionPolicy, getRetentionPolicy, upsertRetentionPolicy } from "./retention";
import { ensureSchema } from "./schema";

describe("retention policy helpers", () => {
  test("returns built-in defaults when no row exists", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    const policy = getRetentionPolicy(db, "codex", "verbatim", {});

    expect(policy.agent_name).toBe("codex");
    expect(policy.source_kind).toBe("verbatim");
    expect(policy.min_importance).toBe("normal");
    expect(policy.max_age_days).toBe(14);
    expect(policy.prune_after_days).toBe(21);
  });

  test("prefers persisted overrides over defaults", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    upsertRetentionPolicy(db, "codex", "episodic", "high", 45, 99, 5, 10, 90, 1);

    const policy = getRetentionPolicy(db, "codex", "episodic", {});

    expect(policy.min_importance).toBe("high");
    expect(policy.max_age_days).toBe(45);
    expect(policy.max_items).toBe(99);
    expect(policy.archive_after_days).toBe(10);
  });

  test("allows env defaults to override built-ins", () => {
    const policy = defaultRetentionPolicy("claude", "digest", {
      FLEET_MEMORY_RETENTION_DIGEST_MIN_IMPORTANCE: "high",
      FLEET_MEMORY_RETENTION_DIGEST_MAX_ITEMS: "12",
      FLEET_MEMORY_RETENTION_DIGEST_ENABLED: "0",
    });

    expect(policy.min_importance).toBe("high");
    expect(policy.max_items).toBe(12);
    expect(policy.enabled).toBe(0);
  });
});

describe("agent-memory retention CLI", () => {
  const tempDir = join(process.cwd(), ".tmp-retention-policy-test");
  const dbPath = join(tempDir, "runtime/agent-memory.db");

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(join(tempDir, "state", "memory"), { recursive: true });
    mkdirSync(join(tempDir, "state", "memory-source", "digests"), { recursive: true });
    mkdirSync(join(tempDir, "state", "memory-source", "working"), { recursive: true });
    mkdirSync(join(tempDir, "state", "memory-source", "episodic"), { recursive: true });
    mkdirSync(join(tempDir, "state", "memory-source", "archival"), { recursive: true });
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists retention policy overrides through rebuild and verify", () => {
    resetTempDir();

    execSync(
      `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts retention-set codex verbatim high 9 42 2 5 12 1`,
    );

    const policy = JSON.parse(
      execSync(
        `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts retention-get codex verbatim`,
      ).toString("utf-8"),
    ) as {
      min_importance: string;
      max_age_days: number | null;
      max_items: number | null;
      compact_after_days: number | null;
      archive_after_days: number | null;
      prune_after_days: number | null;
    };
    expect(policy.min_importance).toBe("high");
    expect(policy.max_age_days).toBe(9);
    expect(policy.max_items).toBe(42);
    expect(policy.prune_after_days).toBe(12);

    const verifyBefore = JSON.parse(
      execSync(
        `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts verify codex`,
      ).toString("utf-8"),
    ) as { verified: Array<{ ok: boolean }> };
    expect(verifyBefore.verified[0]?.ok).toBe(true);

    execSync(
      `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts rebuild codex`,
    );

    const verifyAfter = JSON.parse(
      execSync(
        `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts verify codex`,
      ).toString("utf-8"),
    ) as { verified: Array<{ ok: boolean; actual: { retention: number } }> };
    const rebuiltPolicy = JSON.parse(
      execSync(
        `AGENT_MEMORY_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-memory/main.ts retention-get codex verbatim`,
      ).toString("utf-8"),
    ) as { max_items: number | null };

    expect(verifyAfter.verified[0]?.ok).toBe(true);
    expect(verifyAfter.verified[0]?.actual.retention).toBe(1);
    expect(rebuiltPolicy.max_items).toBe(42);
  });
});
