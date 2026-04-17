import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

describe("Agent Jobs Local Events", () => {
  const tempDir = join(process.cwd(), ".tmp-event-test");
  const dbPath = join(tempDir, "runtime/agent-jobs.db");

  beforeAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("event-publish, event-claim, and event-complete persist local event lifecycle", () => {
    const published = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts event-publish test-agent TaskCompleted agent-runtime \"child process finished\"`,
      ).toString("utf-8"),
    ) as { id: number; event_type: string; status: string };

    expect(published.event_type).toBe("TaskCompleted");
    expect(published.status).toBe("queued");

    const peeked = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts event-peek test-agent`,
      ).toString("utf-8"),
    ) as { id: number };

    expect(peeked.id).toBe(published.id);

    const claimed = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts event-claim test-agent`,
      ).toString("utf-8"),
    ) as { id: number; status: string; claimed_by: string };

    expect(claimed.id).toBe(published.id);
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimed_by).toBe("test-agent");

    const completed = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts event-complete ${published.id} test-agent`,
      ).toString("utf-8"),
    ) as { status: string };

    expect(completed.status).toBe("completed");
  });
});
