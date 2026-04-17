import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

describe("Agent State Recovery", () => {
  const tempDir = join(process.cwd(), ".tmp-recovery-test");
  const metaRepoRoot = tempDir;
  const dbPath = join(tempDir, "runtime/agent-state.db");
  const actionsDir = join(tempDir, "state/actions");
  const runtimeDir = join(tempDir, "state/runtime");
  const turnsDir = join(tempDir, "state/turns");
  
  beforeAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(actionsDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(turnsDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rebuildState recovers data from jsonl", () => {
    // Write mock data to jsonl files
    writeFileSync(join(actionsDir, "test-agent.jsonl"), JSON.stringify({ record_type: "action", agent_name: "test-agent", action_type: "tool", phase: "execution", detail: "tested", created_at: new Date().toISOString() }) + "\n");
    writeFileSync(join(runtimeDir, "test-agent.jsonl"), JSON.stringify({ record_type: "runtime_state", agent_name: "test-agent", status: "active", current_task: "test-task" }) + "\n");
    
    // Run rebuildState via CLI
    execSync(`AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${metaRepoRoot} bun run src/agent-state/main.ts rebuild test-agent`, { stdio: 'inherit' });
    
    // Verify DB
    const db = new Database(dbPath);
    const actionCount = db.prepare("SELECT COUNT(*) as count FROM fleet_agent_action_journal WHERE agent_name = 'test-agent'").get() as { count: number };
    expect(actionCount.count).toBe(1);
    const stateCount = db.prepare("SELECT COUNT(*) as count FROM fleet_agent_state WHERE agent_name = 'test-agent'").get() as { count: number };
    expect(stateCount.count).toBe(1);
    db.close();
  });
});