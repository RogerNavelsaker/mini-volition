import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Agent State Ghost", () => {
  const tempDir = join(process.cwd(), ".tmp-ghost-state-test");
  const dbPath = join(tempDir, "runtime/agent-state.db");

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(join(tempDir, "state", "runtime"), { recursive: true });
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("ghost-set stores deadman diagnostics and ghost-clear removes them", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts record-action test-agent reply 1 started "replying" 42 manual_review duplicate-risk`,
    );
    const ghost = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts ghost-set test-agent turn-1 mail_burst mail:private:42 deadman 42 "turn timed out after 30000ms" prompt_built`,
      ).toString("utf-8"),
    ) as { failure_kind: string; message_id: number };

    expect(ghost.failure_kind).toBe("deadman");
    expect(ghost.message_id).toBe(42);

    const fetched = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts ghost-get test-agent`,
      ).toString("utf-8"),
    ) as { failure_kind: string; last_action: { action_type: string; phase: string } | null };

    expect(fetched.failure_kind).toBe("deadman");
    expect(fetched.last_action?.action_type).toBe("reply");
    expect(fetched.last_action?.phase).toBe("started");

    const cleared = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts ghost-clear test-agent`,
      ).toString("utf-8"),
    ) as { cleared: boolean };

    expect(cleared.cleared).toBe(true);

    const after = execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts ghost-get test-agent`,
    ).toString("utf-8").trim();

    expect(after).toBe("null");
  });
});
