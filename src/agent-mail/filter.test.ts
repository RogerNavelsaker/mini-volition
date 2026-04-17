import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Agent Mail Filters", () => {
  const tempDir = join(process.cwd(), ".tmp-mail-filter-test");
  const mailDbPath = join(tempDir, "runtime/agent-mail.db");
  const stateDbPath = join(tempDir, "runtime/agent-state.db");
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

  test("unsubscribed chat:general suppresses public broadcast bursts but not private mail", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${stateDbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts subscription-set test-agent chat:general unsubscribed 2099-04-18T10:00:00Z focus-window`,
    );

    execSync(
      `AGENT_MAIL_DB=${mailDbPath} META_REPO_ROOT=${tempDir} AGENT_NAME=peer bun run src/agent-mail/main.ts send all public "hello general"`,
    );
    execSync(
      `AGENT_MAIL_DB=${mailDbPath} META_REPO_ROOT=${tempDir} AGENT_NAME=peer bun run src/agent-mail/main.ts send test-agent private "direct ping"`,
    );

    const burst = JSON.parse(
      execSync(
        `AGENT_MAIL_DB=${mailDbPath} AGENT_STATE_DB=${stateDbPath} META_REPO_ROOT=${tempDir} AGENT_NAME=test-agent bun run src/agent-mail/main.ts peek-burst 6 300`,
      ).toString("utf-8"),
    ) as { primary: { layer: string; recipient: string; body: string } };

    expect(burst.primary.layer).toBe("private");
    expect(burst.primary.recipient).toBe("test-agent");
    expect(burst.primary.body).toBe("direct ping");
  });

  test("expired unsubscribe resumes chat:general delivery", () => {
    resetTempDir();
    execSync(
      `AGENT_STATE_DB=${stateDbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts subscription-set resumed-agent chat:general unsubscribed 2000-01-01T00:00:00Z expired-window`,
    );
    execSync(
      `AGENT_MAIL_DB=${mailDbPath} META_REPO_ROOT=${tempDir} AGENT_NAME=peer bun run src/agent-mail/main.ts send all public "welcome back"`,
    );

    const burst = JSON.parse(
      execSync(
        `AGENT_MAIL_DB=${mailDbPath} AGENT_STATE_DB=${stateDbPath} META_REPO_ROOT=${tempDir} AGENT_NAME=resumed-agent bun run src/agent-mail/main.ts peek-burst 6 300`,
      ).toString("utf-8"),
    ) as { primary: { layer: string; recipient: string; body: string } };

    expect(burst.primary.layer).toBe("public");
    expect(burst.primary.recipient).toBe("all");
    expect(burst.primary.body).toBe("welcome back");
  });
});
