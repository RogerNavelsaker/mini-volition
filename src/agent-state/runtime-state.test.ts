import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

type RuntimeStateResult = {
  status: string;
  cooldown_until: string | null;
  last_error: string | null;
  transition_hash: string | null;
};

function getState(tempDir: string, dbPath: string, agent = "test-agent"): RuntimeStateResult {
  return JSON.parse(
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts get ${agent}`,
    ).toString("utf-8"),
  ) as RuntimeStateResult;
}

describe("Agent State Runtime Transitions", () => {
  const tempDir = join(process.cwd(), ".tmp-runtime-state-test");
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

  test("allows normal turn lifecycle transitions", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent idle awaiting_message startup`,
    );
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent thinking job:1 wake:job`,
    );
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent cooldown refractory_window scheduler "" 2099-01-01T00:00:00Z 1`,
    );
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent idle awaiting_message completed:1`,
    );

    const state = getState(tempDir, dbPath);

    expect(state.status).toBe("idle");
    expect(state.cooldown_until).toBeNull();
    expect(state.last_error).toBeNull();
    expect(state.transition_hash).toHaveLength(64);
  });

  test("rejects impossible direct transition from idle to sleeping", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent idle awaiting_message startup`,
    );

    expect(() =>
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent sleeping task sleep_until "" 2099-01-01T00:00:00Z`,
      ),
    ).toThrow();
  });

  test("normalizes incompatible fields for thinking and error states", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent idle awaiting_message startup`,
    );
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent thinking job:9 wake:job stale-error 2099-01-01T00:00:00Z 9`,
    );
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent error job:9 provider_error boom 2099-01-01T00:00:00Z 9`,
    );

    const state = getState(tempDir, dbPath);

    expect(state.status).toBe("error");
    expect(state.last_error).toBe("boom");
    expect(state.cooldown_until).toBeNull();
    expect(state.transition_hash).toHaveLength(64);
  });

  test("chains transition hashes across runtime updates and rebuilds", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent idle awaiting_message startup`,
    );
    const idleState = getState(tempDir, dbPath);
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent thinking job:3 wake:mail`,
    );
    const thinkingState = getState(tempDir, dbPath);

    expect(idleState.transition_hash).toHaveLength(64);
    expect(thinkingState.transition_hash).toHaveLength(64);
    expect(thinkingState.transition_hash).not.toBe(idleState.transition_hash);

    const verifyBefore = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts verify test-agent`,
      ).toString("utf-8"),
    ) as { verified: Array<{ ok: boolean; runtime_drift_detail: Record<string, unknown> | null }> };
    expect(verifyBefore.verified[0]?.ok).toBe(true);

    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts rebuild test-agent`,
    );
    const rebuiltState = getState(tempDir, dbPath);
    const verifyAfter = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts verify test-agent`,
      ).toString("utf-8"),
    ) as { verified: Array<{ ok: boolean; runtime_drift_detail: Record<string, unknown> | null }> };

    expect(rebuiltState.transition_hash).toBe(thinkingState.transition_hash);
    expect(verifyAfter.verified[0]?.ok).toBe(true);
  });
});
