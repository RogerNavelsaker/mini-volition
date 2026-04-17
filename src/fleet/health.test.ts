import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Fleet Heartbeat Monitor", () => {
  const repoRoot = process.cwd();
  const tempDir = join(repoRoot, ".tmp-fleet-health-test");
  const runtimeDir = join(tempDir, "runtime");
  const configDir = join(tempDir, "config");
  const binDir = join(tempDir, "bin");
  const stateDbPath = join(runtimeDir, "agent-state.db");
  const mailDbPath = join(runtimeDir, "agent-mail.db");

  const writeWrapper = (name: string, sourceMain: string) => {
    const path = join(binDir, name);
    writeFileSync(
      path,
      `#!/usr/bin/env bash\nexec bun run "${join(repoRoot, sourceMain)}" "$@"\n`,
      "utf-8",
    );
    chmodSync(path, 0o755);
  };

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeWrapper("agent-state", "src/agent-state/main.ts");
    writeWrapper("agent-mail", "src/agent-mail/main.ts");
    writeFileSync(
      join(configDir, "fleet.json"),
      JSON.stringify({ agents: [{ name: "test-agent", model: "test-model", socket: "test.sock" }] }),
      "utf-8",
    );
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("heartbeat-check marks stale agents dead and sends one alert", () => {
    resetTempDir();
    execSync(
      `META_REPO_ROOT=${tempDir} AGENT_STATE_DB=${stateDbPath} bun run src/agent-state/main.ts notification-set operator health-alerts operator urgent "health feed"`,
    );
    execSync(
      `META_REPO_ROOT=${tempDir} AGENT_STATE_DB=${stateDbPath} bun run src/agent-state/main.ts set test-agent thinking current-task wake-reason "" "" ""`,
    );
    execSync(
      `bun -e "import { Database } from 'bun:sqlite'; const db = new Database('${stateDbPath}'); db.run(\\"UPDATE fleet_agent_state SET updated_at = ? WHERE agent_name = ?\\", ['2000-01-01T00:00:00Z', 'test-agent']); db.close();"`,
      { cwd: repoRoot },
    );

    const result = JSON.parse(
      execSync(
        `META_REPO_ROOT=${tempDir} FLEET_CONFIG=${join(configDir, "fleet.json")} bun run src/fleet/main.ts heartbeat-check 60 300 operator health-alerts`,
        { cwd: repoRoot },
      ).toString("utf-8"),
    ) as { agents: Array<{ agent_name: string; health_status: string; alert_sent: boolean }> };

    expect(result.agents[0]?.agent_name).toBe("test-agent");
    expect(result.agents[0]?.health_status).toBe("dead");
    expect(result.agents[0]?.alert_sent).toBe(true);

    const stateRow = JSON.parse(
      execSync(
        `META_REPO_ROOT=${tempDir} AGENT_STATE_DB=${stateDbPath} bun run src/agent-state/main.ts get test-agent`,
      ).toString("utf-8"),
    ) as { health_status: string };
    expect(stateRow.health_status).toBe("dead");

    const messages = JSON.parse(
      execSync(
        `META_REPO_ROOT=${tempDir} AGENT_MAIL_DB=${mailDbPath} bun run src/agent-mail/main.ts sql "SELECT recipient, layer, body FROM fleet_comms ORDER BY id ASC"`,
      ).toString("utf-8"),
    ) as Array<{ recipient: string; layer: string; body: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.recipient).toBe("operator");
    expect(messages[0]?.layer).toBe("urgent");
    expect(messages[0]?.body).toContain("test-agent is dead");
  });
});
