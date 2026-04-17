import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

describe("Agent State Subscriptions", () => {
  const tempDir = join(process.cwd(), ".tmp-subscription-test");
  const dbPath = join(tempDir, "runtime/agent-state.db");
  const runtimeDir = join(tempDir, "state/runtime");

  beforeAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("subscription-set persists and lists subscription state", () => {
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts subscription-set test-agent chat:general unsubscribed 2026-04-18T10:00:00Z focus-window`,
      { stdio: "inherit" },
    );

    const record = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts subscription-get test-agent chat:general`,
      ).toString("utf-8"),
    ) as { status: string; resume_at: string | null; note: string | null };

    expect(record.status).toBe("unsubscribed");
    expect(record.resume_at).toBe("2026-04-18T10:00:00Z");
    expect(record.note).toBe("focus-window");

    const records = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts subscription-list test-agent`,
      ).toString("utf-8"),
    ) as Array<{ channel: string }>;

    expect(records).toHaveLength(1);
    expect(records[0]?.channel).toBe("chat:general");
    expect(readdirSync(runtimeDir).includes("test-agent.jsonl")).toBe(true);
  });
});
