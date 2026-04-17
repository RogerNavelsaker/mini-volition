import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Agent State Health Projection", () => {
  const tempDir = join(process.cwd(), ".tmp-health-state-test");
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

  test("health-set updates projected health status without clobbering runtime status", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts set test-agent thinking current-task wake-reason "" "" ""`,
    );

    const result = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts health-set test-agent latent`,
      ).toString("utf-8"),
    ) as { status: string; health_status: string; health_updated_at: string | null };

    expect(result.status).toBe("thinking");
    expect(result.health_status).toBe("latent");
    expect(result.health_updated_at).toBeString();
  });
});
