import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Agent Mail Notification Routing", () => {
  const tempDir = join(process.cwd(), ".tmp-mail-notify-test");
  const mailDbPath = join(tempDir, "runtime/agent-mail.db");
  const stateDbPath = join(tempDir, "runtime/agent-state.db");

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(join(tempDir, "state", "mail"), { recursive: true });
    mkdirSync(join(tempDir, "state", "runtime"), { recursive: true });
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("notify resolves a configured route into a standard mail send", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${stateDbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts notification-set operator health-alerts chat:general public "health feed"`,
    );

    execSync(
      `AGENT_MAIL_DB=${mailDbPath} AGENT_STATE_DB=${stateDbPath} META_REPO_ROOT=${tempDir} AGENT_NAME=fleet bun run src/agent-mail/main.ts notify operator health-alerts "worker stalled"`,
    );

    const rows = JSON.parse(
      execSync(
        `AGENT_MAIL_DB=${mailDbPath} META_REPO_ROOT=${tempDir} bun run src/agent-mail/main.ts sql "SELECT recipient, layer, sender, body FROM fleet_comms ORDER BY id ASC"`,
      ).toString("utf-8"),
    ) as Array<{ recipient: string; layer: string; sender: string; body: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient).toBe("chat:general");
    expect(rows[0]?.layer).toBe("public");
    expect(rows[0]?.sender).toBe("fleet");
    expect(rows[0]?.body).toBe("worker stalled");
  });
});
