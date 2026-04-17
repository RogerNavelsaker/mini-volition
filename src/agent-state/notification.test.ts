import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Agent State Notification Channels", () => {
  const tempDir = join(process.cwd(), ".tmp-notification-state-test");
  const dbPath = join(tempDir, "runtime/agent-state.db");
  const runtimeDir = join(tempDir, "state/runtime");

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("notification-set persists and lists channel routing", () => {
    resetTempDir();
    const route = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts notification-set operator health-alerts chat:general public "fleet health updates"`,
      ).toString("utf-8"),
    ) as { recipient: string; layer: string; note: string | null };

    expect(route.recipient).toBe("chat:general");
    expect(route.layer).toBe("public");
    expect(route.note).toBe("fleet health updates");

    const fetched = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts notification-get operator health-alerts`,
      ).toString("utf-8"),
    ) as { recipient: string; layer: string; note: string | null };

    expect(fetched.recipient).toBe("chat:general");
    expect(fetched.layer).toBe("public");
    expect(fetched.note).toBe("fleet health updates");

    const listed = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts notification-list operator`,
      ).toString("utf-8"),
    ) as Array<{ channel_name: string }>;

    expect(listed).toHaveLength(1);
    expect(listed[0]?.channel_name).toBe("health-alerts");
    expect(readdirSync(runtimeDir).includes("operator.jsonl")).toBe(true);
  });
});
