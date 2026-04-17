import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

describe("Agent Jobs Alarms", () => {
  const tempDir = join(process.cwd(), ".tmp-alarm-test");
  const dbPath = join(tempDir, "runtime/agent-jobs.db");

  beforeAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("alarm-set and alarm-cancel persist reminder rows", () => {
    const scheduled = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-set test-agent reminder "resubscribe to chat:general" 2026-04-18T10:00:00Z`,
      ).toString("utf-8"),
    ) as { id: number; kind: string; status: string };

    expect(scheduled.kind).toBe("reminder");
    expect(scheduled.status).toBe("pending");

    const listed = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-list test-agent`,
      ).toString("utf-8"),
    ) as Array<{ id: number }>;

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(scheduled.id);

    const cancelled = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-cancel ${scheduled.id} test-agent`,
      ).toString("utf-8"),
    ) as { status: string };

    expect(cancelled.status).toBe("cancelled");
  });

  test("alarm-peek, alarm-claim, and alarm-complete persist alarm lifecycle", () => {
    const scheduled = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-set test-agent alarm "wake up now" 2026-04-16T11:00:00Z`,
      ).toString("utf-8"),
    ) as { id: number; kind: string; status: string };

    expect(scheduled.kind).toBe("alarm");
    expect(scheduled.status).toBe("pending");

    const peeked = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-peek test-agent`,
      ).toString("utf-8"),
    ) as { id: number };

    expect(peeked.id).toBe(scheduled.id);

    const claimed = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-claim test-agent`,
      ).toString("utf-8"),
    ) as { id: number; status: string };

    expect(claimed.id).toBe(scheduled.id);
    expect(claimed.status).toBe("claimed");

    const completed = JSON.parse(
      execSync(
        `AGENT_JOBS_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-jobs/main.ts alarm-complete ${scheduled.id} test-agent`,
      ).toString("utf-8"),
    ) as { status: string };

    expect(completed.status).toBe("fired");
  });
});
