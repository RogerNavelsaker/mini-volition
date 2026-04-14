import { Database } from "bun:sqlite";
import { spawnSync, spawn } from "bun";
import {
  mkdirSync,
  unlinkSync,
  accessSync,
  constants,
  writeFileSync,
  chmodSync,
  rmSync,
} from "fs";
import { resolve, join, dirname } from "path";
import { appendFleetArtifact } from "../state-artifacts/lib";

// When compiled, import.meta.dir points into /$bunfs. When running from source, use the real .fleet directory.
const fleetRoot = import.meta.dir.includes("/$bunfs/")
  ? resolve(dirname(process.execPath), "..")
  : resolve(import.meta.dir, "../..");
const repoRoot = resolve(fleetRoot, "..");
const srcDir = join(fleetRoot, "src");
const buildDir = join(fleetRoot, "build");
const configDir = join(fleetRoot, "config");
const runtimeDir = join(fleetRoot, "runtime");
const stateDir = join(fleetRoot, "state");

const sessionName = process.env.FLEET_SESSION_NAME || "fleet";
const layoutPath = join(configDir, "fleet.kdl");
const binDir = join(fleetRoot, "bin");

const mailSrc = join(srcDir, "agent-mail", "main.ts");
const harnessSrc = join(srcDir, "agent-harness", "main.ts");
const operatorSrc = join(srcDir, "operator-harness", "main.ts");
const digestSrc = join(srcDir, "fleet-digest", "main.ts");
const librarianSrc = join(srcDir, "fleet-librarian", "main.ts");
const agentStateSrc = join(srcDir, "agent-state", "main.ts");
const agentJobsSrc = join(srcDir, "agent-jobs", "main.ts");
const agentMemorySrc = join(srcDir, "agent-memory", "main.ts");
const embedSrc = join(srcDir, "fleet-embed", "main.ts");
const rerankSrc = join(srcDir, "fleet-rerank", "main.ts");
const e2bSrc = join(srcDir, "fleet-e2b", "main.ts");
const claudeProviderSrc = join(srcDir, "fleet-claude", "main.ts");
const geminiProviderSrc = join(srcDir, "fleet-gemini", "main.ts");
const openaiProviderSrc = join(srcDir, "fleet-openai", "main.ts");
const openrouterProviderSrc = join(srcDir, "fleet-openrouter", "main.ts");
const e4bSrc = join(srcDir, "fleet-e4b", "main.ts");
const mailBin = join(binDir, "agent-mail");
const fleetBin = join(binDir, "fleet");
const harnessBin = join(binDir, "agent-harness");
const operatorBin = join(binDir, "operator-harness");
const digestBin = join(binDir, "fleet-digest");
const librarianBin = join(binDir, "fleet-librarian");
const agentJobsBin = join(binDir, "agent-jobs");
const embedBundle = join(buildDir, "fleet-embed.mjs");
const rerankBundle = join(buildDir, "fleet-rerank.mjs");
const e2bBundle = join(buildDir, "fleet-e2b.mjs");
const e4bBundle = join(buildDir, "fleet-e4b.mjs");
const agentStateBin = join(binDir, "agent-state");
const agentMemoryBin = join(binDir, "agent-memory");
const embedBin = join(binDir, "fleet-embed");
const rerankBin = join(binDir, "fleet-rerank");
const e2bBin = join(binDir, "fleet-e2b");
const e4bBin = join(binDir, "fleet-e4b");
const claudeProviderBin = join(binDir, "fleet-claude");
const geminiProviderBin = join(binDir, "fleet-gemini");
const openaiProviderBin = join(binDir, "fleet-openai");
const openrouterProviderBin = join(binDir, "fleet-openrouter");
const claudeProviderBundle = join(buildDir, "fleet-claude.mjs");
const geminiProviderBundle = join(buildDir, "fleet-gemini.mjs");
const openaiProviderBundle = join(buildDir, "fleet-openai.mjs");
const openrouterProviderBundle = join(buildDir, "fleet-openrouter.mjs");
const mailDb = join(runtimeDir, "agent-mail.db");
const jobsDb = join(runtimeDir, "agent-jobs.db");
const memoryDb = join(runtimeDir, "agent-memory.db");
const stateDb = join(runtimeDir, "agent-state.db");
const fleetDb = join(runtimeDir, "fleet.db");
const librarianDb = join(runtimeDir, "fleet-librarian.db");
const embedSocket = join(runtimeDir, "embed.sock");
const rerankSocket = join(runtimeDir, "rerank.sock");
const e2bSocket = join(runtimeDir, "e2b.sock");
const e4bSocket = join(runtimeDir, "e4b.sock");

const claudeBin = "/home/rona/.flox/run/x86_64-linux.default.run/bin/cc";
const geminiBin = "/home/rona/.flox/run/x86_64-linux.default.run/bin/gmi";
const codexBin = "/home/rona/.flox/run/x86_64-linux.default.run/bin/cod";

function usage(): never {
  console.error("Usage: bin/fleet <build|start|attach|stop|down|restart|status|up|governor-status|governor-bump|governor-force|rebuild-governor|verify-governor>");
  process.exit(64);
}

function governorArtifactPath() {
  return join(stateDir, "fleet", "governor.jsonl");
}

function rebuildGovernor() {
  ensureStateDir();
  const path = governorArtifactPath();
  if (!accessSafe(path)) {
    withDb((db) => db.exec("DELETE FROM fleet_governor;"));
    console.log(JSON.stringify({ rebuilt: { events: 0, agents: 0 } }));
    return;
  }
  const events = Bun.file(path).text().then((text) =>
    text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as any),
  );
  return events.then((rows) => withDb((db) => {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("DELETE FROM fleet_governor;");
      const latest = new Map<string, any>();
      for (const row of rows) latest.set(String(row.agent_name), row);
      const insert = db.prepare(
        `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of latest.values()) {
        insert.run(
          row.agent_name,
          row.recorded_at ?? new Date().toISOString(),
          row.turn_count ?? 0,
          row.forced_cooldown_until ?? row.cooldown_until ?? null,
          row.reason ?? null,
          row.recorded_at ?? new Date().toISOString(),
        );
      }
      db.exec("COMMIT;");
      console.log(JSON.stringify({ rebuilt: { events: rows.length, agents: latest.size } }));
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }));
}

async function verifyGovernor() {
  ensureStateDir();
  const path = governorArtifactPath();
  const rows = accessSafe(path)
    ? (await Bun.file(path).text()).split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as any)
    : [];
  const expected = new Map<string, any>();
  for (const row of rows) expected.set(String(row.agent_name), row);
  const actualRows = withDb((db) => db.prepare("SELECT agent_name, turn_count, forced_cooldown_until, last_reason FROM fleet_governor ORDER BY agent_name ASC").all() as any[]);
  const actual = new Map(actualRows.map((row) => [String(row.agent_name), row]));
  const missing = [...expected.keys()].filter((agent) => !actual.has(agent));
  const extra = [...actual.keys()].filter((agent) => !expected.has(agent));
  const mismatched = [...expected.entries()]
    .filter(([agent, row]) => {
      const current = actual.get(agent);
      return current && (
        Number(current.turn_count ?? 0) !== Number(row.turn_count ?? 0)
        || (current.forced_cooldown_until ?? null) !== (row.forced_cooldown_until ?? row.cooldown_until ?? null)
        || (current.last_reason ?? null) !== (row.reason ?? null)
      );
    })
    .map(([agent]) => agent);
  const ok = missing.length === 0 && extra.length === 0 && mismatched.length === 0;
  const issues = [
    missing.length ? `missing governor agents: ${missing.join(",")}` : null,
    extra.length ? `extra governor agents: ${extra.join(",")}` : null,
    mismatched.length ? `mismatched governor agents: ${mismatched.join(",")}` : null,
  ].filter(Boolean);
  console.log(JSON.stringify({
    ok,
    expected_agents: expected.size,
    actual_agents: actual.size,
    missing_agents: missing,
    extra_agents: extra,
    mismatched_agents: mismatched,
    issues,
    repair: ok ? null : "fleet rebuild-governor",
  }));
}

function accessSafe(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function requireCmd(cmd: string) {
  const result = spawnSync(["which", cmd]);
  if (result.exitCode !== 0) {
    console.error(`Missing required command: ${cmd}`);
    process.exit(127);
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sessionLine(): string {
  const result = spawnSync(["zellij", "list-sessions"]);
  const output = result.stdout.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  return output.split("\n").find((line) => line.startsWith(sessionName)) || "";
}

function sessionExists(): boolean {
  return sessionLine().length > 0;
}

function sessionRunning(): boolean {
  const line = sessionLine();
  return line.length > 0 && !line.includes("(EXITED - attach to resurrect)");
}

function ensureBinDir() {
  mkdirSync(binDir, { recursive: true });
}

function ensureBuildDir() {
  mkdirSync(buildDir, { recursive: true });
}

function ensureConfigDir() {
  mkdirSync(configDir, { recursive: true });
}

function ensureRuntimeDir() {
  mkdirSync(runtimeDir, { recursive: true });
}

function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true });
}

function verifyAgentBins(): boolean {
  let ok = true;
  for (const path of [claudeBin, geminiBin, codexBin]) {
    if (!isExecutable(path)) {
      console.error(`missing agent binary: ${path}`);
      ok = false;
    }
  }
  return ok;
}

function runOrDie(cmd: string[]) {
  const result = spawnSync(cmd);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
}

function buildBinaries() {
  requireCmd("bun");
  ensureBinDir();
  ensureBuildDir();
  ensureConfigDir();
  ensureRuntimeDir();
  ensureStateDir();
  if (!verifyAgentBins()) process.exit(1);

  for (const stalePath of [
    join(fleetRoot, "fleet"),
    join(buildDir, "fleet"),
  ]) {
    try {
      unlinkSync(stalePath);
    } catch {}
  }

  for (const staleDir of [
    join(fleetRoot, "node_modules"),
  ]) {
    try {
      rmSync(staleDir, { recursive: true, force: true });
    } catch {}
  }

  runOrDie(["bun", "build", join(srcDir, "fleet", "main.ts"), "--compile", "--outfile", fleetBin]);
  runOrDie(["bun", "build", mailSrc, "--compile", "--outfile", mailBin]);
  runOrDie(["bun", "build", harnessSrc, "--compile", "--outfile", harnessBin]);
  runOrDie(["bun", "build", operatorSrc, "--compile", "--outfile", operatorBin]);
  runOrDie(["bun", "build", agentStateSrc, "--compile", "--outfile", agentStateBin]);
  runOrDie(["bun", "build", agentJobsSrc, "--compile", "--outfile", agentJobsBin]);
  runOrDie(["bun", "build", agentMemorySrc, "--compile", "--outfile", agentMemoryBin]);
  runOrDie(["bun", "build", digestSrc, "--compile", "--outfile", digestBin]);
  runOrDie(["bun", "build", librarianSrc, "--compile", "--outfile", librarianBin]);
  // Per-model inference workers (one process per model, one socket per process)
  // Workers cd to repo root (not build/) so relative socket paths resolve correctly.
  // NODE_PATH points to build/node_modules so onnxruntime-node can still be found.
  for (const [src, bundle, bin, name] of [
    [embedSrc, embedBundle, embedBin, "fleet-embed"],
    [rerankSrc, rerankBundle, rerankBin, "fleet-rerank"],
    [e2bSrc, e2bBundle, e2bBin, "fleet-e2b"],
    [e4bSrc, e4bBundle, e4bBin, "fleet-e4b"],
  ] as const) {
    runOrDie(["bun", "build", "--target=bun", "--packages=external", src, "--outfile", bundle]);
    writeFileSync(bin, `#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
export NODE_PATH="$repo_root/build/node_modules"
cd "$repo_root"
exec bun "$repo_root/build/${name}.mjs" "$@"
`, "utf-8");
    chmodSync(bin, 0o755);
  }
  // Cloud provider workers (one process per provider, one socket per process)
  // Same wrapper pattern as inference workers — NODE_PATH for SDK resolution.
  for (const [src, bundle, bin, name] of [
    [claudeProviderSrc, claudeProviderBundle, claudeProviderBin, "fleet-claude"],
    [geminiProviderSrc, geminiProviderBundle, geminiProviderBin, "fleet-gemini"],
    [openaiProviderSrc, openaiProviderBundle, openaiProviderBin, "fleet-openai"],
    [openrouterProviderSrc, openrouterProviderBundle, openrouterProviderBin, "fleet-openrouter"],
  ] as const) {
    runOrDie(["bun", "build", "--target=bun", "--packages=external", src, "--outfile", bundle]);
    writeFileSync(bin, `#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
export NODE_PATH="$repo_root/build/node_modules"
cd "$repo_root"
exec bun "$repo_root/build/${name}.mjs" "$@"
`, "utf-8");
    chmodSync(bin, 0o755);
  }
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = new Database(fleetDb);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_governor (
    agent_name TEXT PRIMARY KEY,
    window_started_at DATETIME,
    turn_count INTEGER DEFAULT 0,
    forced_cooldown_until DATETIME,
    last_reason TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function isoAfterSeconds(seconds: number): string {
  return new Date(Date.now() + (seconds * 1000)).toISOString();
}

function currentGovernor(db: Database, agent: string) {
  return (db.prepare("SELECT * FROM fleet_governor WHERE agent_name = ?").get(agent) as any) ?? null;
}

function governorStatus(agent: string, windowSec: number, turnLimit: number) {
  return withDb((db) => {
    const rec = currentGovernor(db, agent);
    const now = Date.now();
    const cooldownUntilMs = rec?.forced_cooldown_until ? new Date(rec.forced_cooldown_until.endsWith("Z") ? rec.forced_cooldown_until : `${rec.forced_cooldown_until}Z`).getTime() : 0;
    const allowedByCooldown = cooldownUntilMs <= now;
    const windowStartedMs = rec?.window_started_at ? new Date(rec.window_started_at.endsWith("Z") ? rec.window_started_at : `${rec.window_started_at}Z`).getTime() : 0;
    const windowExpired = !windowStartedMs || (now - windowStartedMs) > windowSec * 1000;

    if (windowExpired && rec) {
      db.run(
        "UPDATE fleet_governor SET window_started_at = CURRENT_TIMESTAMP, turn_count = 0, forced_cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE agent_name = ?",
        [agent],
      );
    }

    const current = currentGovernor(db, agent);
    return {
      allowed: allowedByCooldown,
      turn_count: current?.turn_count ?? 0,
      turn_limit: turnLimit,
      window_sec: windowSec,
      window_started_at: current?.window_started_at ?? null,
      forced_cooldown_until: current?.forced_cooldown_until ?? null,
      last_reason: current?.last_reason ?? null,
    };
  });
}

function governorForce(agent: string, cooldownSec: number, reason: string | null) {
  return withDb((db) => {
    const cooldownUntil = isoAfterSeconds(cooldownSec);
    db.run(
      `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, 0, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name) DO UPDATE SET
         forced_cooldown_until = excluded.forced_cooldown_until,
         last_reason = excluded.last_reason,
         updated_at = CURRENT_TIMESTAMP`,
      [agent, cooldownUntil, reason],
    );
    appendFleetArtifact("governor", {
      record_type: "governor",
      event: "forced_cooldown",
      agent_name: agent,
      cooldown_until: cooldownUntil,
      cooldown_seconds: cooldownSec,
      reason,
    });
    return governorStatus(agent, cooldownSec, 0);
  });
}

function governorBump(agent: string, windowSec: number, turnLimit: number, reason: string | null) {
  return withDb((db) => {
    const current = governorStatus(agent, windowSec, turnLimit);
    const nextTurnCount = current.turn_count + 1;
    let forcedCooldownUntil: string | null = current.forced_cooldown_until;
    if (nextTurnCount > turnLimit) {
      forcedCooldownUntil = isoAfterSeconds(windowSec);
    }

    db.run(
      `INSERT INTO fleet_governor (agent_name, window_started_at, turn_count, forced_cooldown_until, last_reason, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name) DO UPDATE SET
         turn_count = ?,
         forced_cooldown_until = ?,
         last_reason = ?,
         updated_at = CURRENT_TIMESTAMP`,
      [agent, nextTurnCount, forcedCooldownUntil, reason, nextTurnCount, forcedCooldownUntil, reason],
    );
    appendFleetArtifact("governor", {
      record_type: "governor",
      event: "bump",
      agent_name: agent,
      turn_count: nextTurnCount,
      turn_limit: turnLimit,
      window_sec: windowSec,
      forced_cooldown_until: forcedCooldownUntil,
      reason,
    });

    return governorStatus(agent, windowSec, turnLimit);
  });
}

function startSession() {
  requireCmd("zellij");
  buildBinaries();

  process.env.PATH = `${binDir}:${process.env.PATH}`;

  if (sessionRunning()) {
    console.log(`fleet session '${sessionName}' is already running`);
    return;
  }

  if (sessionExists()) {
    spawnSync(["zellij", "delete-session", sessionName]);
  }

  const child = spawn(
    ["zellij", "--new-session-with-layout", layoutPath, "--session", sessionName],
    { cwd: repoRoot, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  child.unref();

  for (let i = 0; i < 10; i++) {
    Bun.sleepSync(200);
    if (sessionRunning()) {
      spawnSync(["zellij", "action", "--session", sessionName, "switch-mode", "locked"]);
      console.log(`fleet session '${sessionName}' started`);
      return;
    }
  }

  console.error(`failed to start fleet session '${sessionName}'`);
  process.exit(1);
}

function attachSession() {
  requireCmd("zellij");
  if (!sessionRunning()) {
    console.error(`fleet session '${sessionName}' is not running`);
    process.exit(1);
  }
  const result = spawnSync(["zellij", "attach", sessionName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(result.exitCode);
}

function stopSession() {
  requireCmd("zellij");
  if (!sessionExists()) {
    console.log(`fleet session '${sessionName}' is not running`);
    return;
  }
  spawnSync(["zellij", "kill-session", sessionName]);
  spawnSync(["zellij", "delete-session", sessionName]);
  console.log(`fleet session '${sessionName}' stopped`);
}

function downSession() {
  stopSession();
  for (const base of [mailDb, jobsDb, memoryDb, stateDb, fleetDb, librarianDb]) {
    for (const f of [base, `${base}-wal`, `${base}-shm`]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
  for (const sock of [embedSocket, rerankSocket, e2bSocket, e4bSocket]) {
    try {
      unlinkSync(sock);
    } catch {}
  }
  console.log(`fleet databases removed`);
}

function showStatus() {
  ensureRuntimeDir();
  ensureStateDir();
  if (sessionRunning()) {
    console.log(`session: running (${sessionName})`);
  } else if (sessionExists()) {
    console.log(`session: exited (${sessionName})`);
  } else {
    console.log(`session: stopped (${sessionName})`);
  }

  console.log(`agent-mail-bin: ${isExecutable(mailBin) ? "ready" : "missing"} ${mailBin}`);
  console.log(`agent-harness-bin: ${isExecutable(harnessBin) ? "ready" : "missing"} ${harnessBin}`);
  console.log(`agent-state-bin: ${isExecutable(agentStateBin) ? "ready" : "missing"} ${agentStateBin}`);
  console.log(`agent-jobs-bin: ${isExecutable(agentJobsBin) ? "ready" : "missing"} ${agentJobsBin}`);
  console.log(`agent-memory-bin: ${isExecutable(agentMemoryBin) ? "ready" : "missing"} ${agentMemoryBin}`);
  console.log(`operator-harness-bin: ${isExecutable(operatorBin) ? "ready" : "missing"} ${operatorBin}`);
  console.log(`fleet-digest-bin: ${isExecutable(digestBin) ? "ready" : "missing"} ${digestBin}`);
  console.log(`fleet-librarian-bin: ${isExecutable(librarianBin) ? "ready" : "missing"} ${librarianBin}`);
  console.log(`fleet-embed-bin: ${isExecutable(embedBin) ? "ready" : "missing"} ${embedBin}`);
  console.log(`fleet-rerank-bin: ${isExecutable(rerankBin) ? "ready" : "missing"} ${rerankBin}`);
  console.log(`fleet-e2b-bin: ${isExecutable(e2bBin) ? "ready" : "missing"} ${e2bBin}`);
  console.log(`fleet-e4b-bin: ${isExecutable(e4bBin) ? "ready" : "missing"} ${e4bBin}`);
  console.log(`claude-bin: ${isExecutable(claudeBin) ? "ready" : "missing"} ${claudeBin}`);
  console.log(`gemini-bin: ${isExecutable(geminiBin) ? "ready" : "missing"} ${geminiBin}`);
  console.log(`codex-bin: ${isExecutable(codexBin) ? "ready" : "missing"} ${codexBin}`);
  console.log(`agent-mail-db: ${mailDb}`);
  console.log(`agent-jobs-db: ${jobsDb}`);
  console.log(`agent-memory-db: ${memoryDb}`);
  console.log(`agent-state-db: ${stateDb}`);
  console.log(`fleet-db: ${fleetDb}`);
  console.log(`fleet-librarian-db: ${librarianDb}`);
  console.log(`embed-socket: ${embedSocket}`);
  console.log(`rerank-socket: ${rerankSocket}`);
  console.log(`e2b-socket: ${e2bSocket}`);
  console.log(`e4b-socket: ${e4bSocket}`);
  console.log(`state-dir: ${stateDir}`);
}

switch (process.argv[2]) {
  case "build":
    buildBinaries();
    break;
  case "start":
    startSession();
    break;
  case "attach":
    attachSession();
    break;
  case "stop":
    stopSession();
    break;
  case "down":
    downSession();
    break;
  case "restart":
    stopSession();
    startSession();
    break;
  case "status":
    showStatus();
    break;
  case "governor-status":
    console.log(JSON.stringify(governorStatus(process.argv[3] || "", Math.max(1, parseInt(process.argv[4] || "120", 10) || 120), Math.max(1, parseInt(process.argv[5] || "4", 10) || 4))));
    break;
  case "governor-bump":
    console.log(JSON.stringify(governorBump(process.argv[3] || "", Math.max(1, parseInt(process.argv[4] || "120", 10) || 120), Math.max(1, parseInt(process.argv[5] || "4", 10) || 4), process.argv[6] ?? null)));
    break;
  case "governor-force":
    console.log(JSON.stringify(governorForce(process.argv[3] || "", Math.max(1, parseInt(process.argv[4] || "60", 10) || 60), process.argv[5] ?? null)));
    break;
  case "rebuild-governor":
    await rebuildGovernor();
    break;
  case "verify-governor":
    await verifyGovernor();
    break;
  case "up":
    startSession();
    attachSession();
    break;
  default:
    usage();
}
