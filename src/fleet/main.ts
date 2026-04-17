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
  readFileSync,
  existsSync,
} from "fs";
import { resolve, join, dirname } from "path";
import { createConnection } from "net";
import { appendFleetArtifact } from "../state-artifacts/lib";

// When compiled, import.meta.dir points into /$bunfs. When running from source, use the real repository root.
const fleetRoot = process.env.META_REPO_ROOT
  ? resolve(process.env.META_REPO_ROOT)
  : (import.meta.dir.includes("/$bunfs/")
    ? resolve(dirname(process.execPath), "..")
    : resolve(import.meta.dir, "../.."));

const srcDir = join(fleetRoot, "src");
const binDir = join(fleetRoot, "bin");
const configDir = join(fleetRoot, "config");
const runtimeDir = resolve(process.env.FLEET_RUNTIME_DIR || join(fleetRoot, "runtime"));
const stateDir = resolve(process.env.FLEET_STATE_DIR || join(fleetRoot, "state"));

const sessionName = process.env.FLEET_SESSION_NAME || "fleet";
const layoutPath = join(configDir, "fleet.kdl");

interface AgentConfig {
  name: string;
  model: string;
  socket: string;
}

const DEFAULT_AGENTS: AgentConfig[] = [
  { name: "claude", model: "claude-sonnet-4-20250514", socket: "claude.sock" },
  { name: "gemini", model: "gemini-2.5-pro", socket: "gemini.sock" },
  { name: "codex", model: "o3", socket: "openai.sock" },
];

function loadConfig(): { agents: AgentConfig[] } {
  const configPath = process.env.FLEET_CONFIG || join(configDir, "fleet.json");
  let agents = [...DEFAULT_AGENTS];

  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8"));
      if (Array.isArray(data.agents)) {
        agents = data.agents;
      }
    } catch (e) {
      console.error(`Warning: Failed to load config from ${configPath}: ${e}`);
    }
  }

  // Allow environment variable overrides: INFERENCE_CLOUD_<NAME>_MODEL
  return {
    agents: agents.map(a => ({
      ...a,
      model: process.env[`INFERENCE_CLOUD_${a.name.toUpperCase()}_MODEL`] || a.model,
    }))
  };
}

const mailDb = join(runtimeDir, "agent-mail.db");
const jobsDb = join(runtimeDir, "agent-jobs.db");
const memoryDb = join(runtimeDir, "agent-memory.db");
const stateDb = join(runtimeDir, "agent-state.db");
const fleetDb = join(runtimeDir, "fleet.db");
const librarianDb = join(runtimeDir, "fleet-librarian.db");
const embedSocket = join(runtimeDir, "embed.sock");
const rerankSocket = join(runtimeDir, "rerank.sock");
const lightSocket = join(runtimeDir, "light.sock");
const heavySocket = join(runtimeDir, "heavy.sock");

const claudeBin = "/home/rona/.flox/run/x86_64-linux.default.run/bin/cc";
const geminiBin = "/home/rona/.flox/run/x86_64-linux.default.run/bin/gmi";
const codexBin = "/home/rona/.flox/run/x86_64-linux.default.run/bin/cod";

const mailBin = join(binDir, "agent-mail");
const harnessBin = join(binDir, "agent-runtime");
const operatorBin = join(binDir, "operator-console");
const agentStateBin = join(binDir, "agent-state");
const agentJobsBin = join(binDir, "agent-jobs");
const agentMemoryBin = join(binDir, "agent-memory");
const digestBin = join(binDir, "fleet-reporter");
const librarianBin = join(binDir, "fleet-librarian");
const embedBin = join(binDir, "inference-local-embed");
const rerankBin = join(binDir, "inference-local-rerank");
const lightBin = join(binDir, "inference-local-small");
const heavyBin = join(binDir, "inference-local-medium");

function generateKdl(): string {
  const config = loadConfig();
  const mailDbPath = resolve(mailDb);
  const jobsDbPath = resolve(jobsDb);
  const memoryDbPath = resolve(memoryDb);
  const stateDbPath = resolve(stateDb);
  const libDbPath = resolve(librarianDb);
  const embedSock = resolve(embedSocket);
  const rerankSock = resolve(rerankSocket);
  const lightSock = resolve(lightSocket);
  const heavySock = resolve(heavySocket);
  const providerModels = new Map(config.agents.map((agent) => [agent.name, agent.model]));
  const anthropicModel = process.env.INFERENCE_CLOUD_ANTHROPIC_MODEL || providerModels.get("claude") || "";
  const googleModel = process.env.INFERENCE_CLOUD_GOOGLE_MODEL || providerModels.get("gemini") || "";
  const openaiModel = process.env.INFERENCE_CLOUD_OPENAI_MODEL || providerModels.get("codex") || "";
  const openrouterModel = process.env.INFERENCE_CLOUD_OPENROUTER_MODEL || "";

  const agentPanes = config.agents.map(a => `
                pane name="${a.name.toUpperCase()}" command="bash" {
                    args "-lc" "AGENT_NAME=${a.name} AGENT_PROMPT_MODE=provider INFERENCE_CLOUD_SOCKET='${resolve(runtimeDir, a.socket)}' INFERENCE_CLOUD_MODEL='${a.model}' INFERENCE_CLOUD_ANTHROPIC_SOCKET='${resolve(runtimeDir, "claude.sock")}' INFERENCE_CLOUD_GOOGLE_SOCKET='${resolve(runtimeDir, "gemini.sock")}' INFERENCE_CLOUD_OPENAI_SOCKET='${resolve(runtimeDir, "openai.sock")}' INFERENCE_CLOUD_OPENROUTER_SOCKET='${resolve(runtimeDir, "openrouter.sock")}' INFERENCE_CLOUD_ANTHROPIC_MODEL='${anthropicModel}' INFERENCE_CLOUD_GOOGLE_MODEL='${googleModel}' INFERENCE_CLOUD_OPENAI_MODEL='${openaiModel}' INFERENCE_CLOUD_OPENROUTER_MODEL='${openrouterModel}' AGENT_MAIL_BIN='agent-mail' AGENT_MAIL_DB='${mailDbPath}' AGENT_JOBS_DB='${jobsDbPath}' AGENT_MEMORY_DB='${memoryDbPath}' AGENT_STATE_DB='${stateDbPath}' FLEET_LIBRARIAN_DB='${libDbPath}' INFERENCE_LOCAL_EMBED_SOCKET='${embedSock}' INFERENCE_LOCAL_SMALL_SOCKET='${lightSock}' INFERENCE_LOCAL_MEDIUM_SOCKET='${heavySock}' agent-runtime < /dev/null"
                }`).join("");

  return `layout {
    default_tab_template {
        children
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
    }

    tab name="agents" {
        pane split_direction="horizontal" {
            pane split_direction="vertical" {${agentPanes}
            }
            pane split_direction="vertical" {
                pane name="TOWN SQUARE" command="bash" {
                    args "-lc" "AGENT_MAIL_DB='${mailDbPath}' agent-mail tail public < /dev/null"
                }
                pane name="DIGEST" command="bash" {
                    args "-lc" "AGENT_MAIL_DB='${mailDbPath}' AGENT_MEMORY_DB='${memoryDbPath}' AGENT_STATE_DB='${stateDbPath}' AGENT_MAIL_BIN='agent-mail' INFERENCE_LOCAL_SMALL_SOCKET='${lightSock}' fleet-reporter < /dev/null"
                }
                pane name="MEMORY" command="bash" {
                    args "-lc" "AGENT_JOBS_DB='${jobsDbPath}' AGENT_MEMORY_DB='${memoryDbPath}' AGENT_STATE_DB='${stateDbPath}' FLEET_LIBRARIAN_DB='${libDbPath}' AGENT_MEMORY_BIN='agent-memory' fleet-librarian < /dev/null"
                }
                pane name="OPERATOR" focus=true command="bash" {
                    args "-lc" "AGENT_MAIL_DB='${mailDbPath}' operator-console"
                }
            }
        }
    }

    tab name="providers" {
        pane split_direction="horizontal" {
            pane split_direction="vertical" {
                pane name="CLAUDE-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_ANTHROPIC_SOCKET='${resolve(runtimeDir, "claude.sock")}' inference-cloud-anthropic < /dev/null"
                }
                pane name="GEMINI-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_GOOGLE_SOCKET='${resolve(runtimeDir, "gemini.sock")}' inference-cloud-google < /dev/null"
                }
            }
            pane split_direction="vertical" {
                pane name="OPENAI-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_OPENAI_SOCKET='${resolve(runtimeDir, "openai.sock")}' inference-cloud-openai < /dev/null"
                }
                pane name="OPENROUTER-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_OPENROUTER_SOCKET='${resolve(runtimeDir, "openrouter.sock")}' inference-cloud-openrouter < /dev/null"
                }
            }
        }
    }

    tab name="inference" {
        pane split_direction="horizontal" {
            pane split_direction="vertical" {
                pane name="EMBED" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_EMBED_SOCKET='${embedSock}' inference-local-embed < /dev/null"
                }
                pane name="RERANK" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_RERANK_SOCKET='${rerankSock}' inference-local-rerank < /dev/null"
                }
            }
            pane split_direction="vertical" {
                pane name="LIGHT" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_SMALL_SOCKET='${lightSock}' inference-local-small < /dev/null"
                }
                pane name="HEAVY" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_MEDIUM_SOCKET='${heavySock}' inference-local-medium < /dev/null"
                }
            }
        }
    }
}
`;
}

function usage(): never {
  console.error("Usage: bin/fleet <genesis|start|attach|detach|stop|terminus|up|down|restart|status|heartbeat-check|governor-status|governor-bump|governor-force|rebuild-governor|verify-governor>");
  process.exit(64);
}

function genesisSession() {
  console.log("== genesis: initializing workspace ==");
  ensureBinDir();
  ensureConfigDir();
  ensureRuntimeDir();
  ensureStateDir();
  
  requireCmd("bun");
  requireCmd("zellij");

  if (!verifyAgentBins()) {
    console.error("Genesis failed: Missing agent binaries.");
    process.exit(1);
  }
  console.log("Genesis complete. Workspace ready.");
}

function terminusSession() {
  console.log("== terminus: cleaning up runtime data ==");
  for (const base of [mailDb, jobsDb, memoryDb, stateDb, fleetDb, librarianDb]) {
    for (const f of [base, `${base}-wal`, `${base}-shm`]) {
      try {
        if (accessSafe(f)) unlinkSync(f);
      } catch {}
    }
  }
  for (const sock of [embedSocket, rerankSocket, lightSocket, heavySocket, 
                     join(runtimeDir, "claude.sock"), join(runtimeDir, "gemini.sock"),
                     join(runtimeDir, "openai.sock"), join(runtimeDir, "openrouter.sock")]) {
    try {
      if (accessSafe(sock)) unlinkSync(sock);
    } catch {}
  }
  console.log("Terminus complete. Databases and sockets removed.");
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

type SocketHeartbeat = {
  ok: true;
  type: "heartbeat";
  label: string;
  pid: number;
  uptime_ms: number;
  now: string;
};

type HealthStatus = "active" | "latent" | "dead";

type AgentHealthSnapshot = {
  agent_name: string;
  runtime_status: string | null;
  runtime_updated_at: string | null;
  health_status: HealthStatus;
  stale_ms: number | null;
  alert_sent: boolean;
};

function requestSocketHeartbeat(socketPath: string, timeoutMs = 750): Promise<SocketHeartbeat | null> {
  return new Promise((resolve) => {
    if (!accessSafe(socketPath)) {
      resolve(null);
      return;
    }
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: SocketHeartbeat | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "heartbeat" })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim()) as Partial<SocketHeartbeat>;
        if (parsed?.type === "heartbeat" && parsed?.ok === true && typeof parsed.label === "string") {
          finish(parsed as SocketHeartbeat);
          return;
        }
      } catch {}
      finish(null);
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
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
  const buildDir = join(fleetRoot, "build");
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
  db.run(`CREATE TABLE IF NOT EXISTS fleet_health_alerts (
    agent_name TEXT PRIMARY KEY,
    health_status TEXT NOT NULL,
    runtime_updated_at DATETIME,
    last_alerted_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function withStateDb<T>(fn: (db: Database) => T): T {
  const db = new Database(stateDb);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function isoAfterSeconds(seconds: number): string {
  // ISO date after N seconds
  return new Date(Date.now() + (seconds * 1000)).toISOString();
}

function classifyHealthStatus(updatedAt: string | null, activeMs: number, latentMs: number): { status: HealthStatus; staleMs: number | null } {
  if (!updatedAt) return { status: "dead", staleMs: null };
  const updatedAtMs = new Date(updatedAt.endsWith("Z") ? updatedAt : `${updatedAt}Z`).getTime();
  if (!Number.isFinite(updatedAtMs)) return { status: "dead", staleMs: null };
  const staleMs = Math.max(0, Date.now() - updatedAtMs);
  if (staleMs <= activeMs) return { status: "active", staleMs };
  if (staleMs <= latentMs) return { status: "latent", staleMs };
  return { status: "dead", staleMs };
}

function sendHealthAlert(notificationAgent: string, channelName: string, snapshot: AgentHealthSnapshot) {
  const body = `[HEALTH ALERT] ${snapshot.agent_name} is ${snapshot.health_status}; last_runtime_at=${snapshot.runtime_updated_at ?? "never"}${snapshot.stale_ms == null ? "" : ` stale_ms=${snapshot.stale_ms}`}${snapshot.runtime_status ? ` runtime_status=${snapshot.runtime_status}` : ""}`;
  const env = {
    ...process.env,
    META_REPO_ROOT: fleetRoot,
    AGENT_MAIL_DB: mailDb,
    AGENT_STATE_DB: stateDb,
    AGENT_NAME: "fleet",
  };
  const notifyResult = spawnSync([mailBin, "notify", notificationAgent, channelName, body], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (notifyResult.exitCode === 0) return;
  spawnSync([mailBin, "send", notificationAgent, "urgent", body], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
}

function heartbeatCheck(activeSec: number, latentSec: number, notificationAgent: string, channelName: string) {
  const activeMs = Math.max(1, activeSec) * 1000;
  const latentMs = Math.max(activeMs, latentSec * 1000);
  const agents = loadConfig().agents.map((agent) => agent.name);
  const baseSnapshots = withStateDb((db) => agents.map((agentName) => {
    const row = db.prepare(
      "SELECT agent_name, status, updated_at FROM fleet_agent_state WHERE agent_name = ? LIMIT 1",
    ).get(agentName) as { agent_name: string; status: string | null; updated_at: string | null } | null;
    const health = classifyHealthStatus(row?.updated_at ?? null, activeMs, latentMs);
    return {
      agent_name: agentName,
      runtime_status: row?.status ?? null,
      runtime_updated_at: row?.updated_at ?? null,
      health_status: health.status,
      stale_ms: health.staleMs,
      alert_sent: false,
    } satisfies AgentHealthSnapshot;
  }));

  for (const snapshot of baseSnapshots) {
    spawnSync([agentStateBin, "health-set", snapshot.agent_name, snapshot.health_status], {
      env: { ...process.env, META_REPO_ROOT: fleetRoot, AGENT_STATE_DB: stateDb },
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  return withDb((db) => {
    const snapshots = baseSnapshots.map((snapshot) => {
      const previous = db.prepare(
        "SELECT health_status FROM fleet_health_alerts WHERE agent_name = ? LIMIT 1",
      ).get(snapshot.agent_name) as { health_status: string } | null;
      const shouldAlert = snapshot.health_status === "dead" && previous?.health_status !== "dead";
      if (shouldAlert) sendHealthAlert(notificationAgent, channelName, snapshot);
      db.run(
        `INSERT INTO fleet_health_alerts (agent_name, health_status, runtime_updated_at, last_alerted_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(agent_name) DO UPDATE SET
           health_status = excluded.health_status,
           runtime_updated_at = excluded.runtime_updated_at,
           last_alerted_at = COALESCE(excluded.last_alerted_at, fleet_health_alerts.last_alerted_at),
           updated_at = CURRENT_TIMESTAMP`,
        [snapshot.agent_name, snapshot.health_status, snapshot.runtime_updated_at, shouldAlert ? new Date().toISOString() : null],
      );
      return { ...snapshot, alert_sent: shouldAlert };
    });
    return { checked_at: new Date().toISOString(), active_sec: activeSec, latent_sec: latentSec, agents: snapshots };
  });
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
    const elapsedMs = now - windowStartedMs;
    const windowMs = windowSec * 1000;
    const windowExpired = !windowStartedMs || elapsedMs > windowMs;

    if (windowExpired && rec) {
      // Sliding window approximation: linearly decay turn_count based on elapsed time.
      // If we are past one window, we reset. Otherwise, we decay.
      const decayRatio = Math.max(0, 1 - (elapsedMs / windowMs));
      const decayedCount = Math.floor((rec.turn_count || 0) * decayRatio);
      
      db.run(
        "UPDATE fleet_governor SET window_started_at = CURRENT_TIMESTAMP, turn_count = ?, forced_cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE agent_name = ?",
        [decayedCount, agent],
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

  if (sessionRunning()) {
    console.log(`fleet session '${sessionName}' is already running`);
    return;
  }

  if (sessionExists()) {
    spawnSync(["zellij", "delete-session", sessionName]);
  }

  const kdl = generateKdl();
  const tmpLayout = join(runtimeDir, "fleet-dynamic.kdl");
  ensureRuntimeDir();
  writeFileSync(tmpLayout, kdl);

  const child = spawn(
    ["zellij", "--new-session-with-layout", tmpLayout, "--session", sessionName],
    { cwd: fleetRoot, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
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

function detachSession() {
  requireCmd("zellij");
  if (!sessionRunning()) {
    console.log(`fleet session '${sessionName}' is not running`);
    return;
  }
  spawnSync(["zellij", "action", "--session", sessionName, "detach"]);
  console.log(`fleet session '${sessionName}' detached`);
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

async function showStatus() {
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
  console.log(`agent-runtime-bin: ${isExecutable(harnessBin) ? "ready" : "missing"} ${harnessBin}`);
  console.log(`agent-state-bin: ${isExecutable(agentStateBin) ? "ready" : "missing"} ${agentStateBin}`);
  console.log(`agent-jobs-bin: ${isExecutable(agentJobsBin) ? "ready" : "missing"} ${agentJobsBin}`);
  console.log(`agent-memory-bin: ${isExecutable(agentMemoryBin) ? "ready" : "missing"} ${agentMemoryBin}`);
  console.log(`operator-console-bin: ${isExecutable(operatorBin) ? "ready" : "missing"} ${operatorBin}`);
  console.log(`fleet-reporter-bin: ${isExecutable(digestBin) ? "ready" : "missing"} ${digestBin}`);
  console.log(`fleet-librarian-bin: ${isExecutable(librarianBin) ? "ready" : "missing"} ${librarianBin}`);
  console.log(`inference-local-embed-bin: ${isExecutable(embedBin) ? "ready" : "missing"} ${embedBin}`);
  console.log(`inference-local-rerank-bin: ${isExecutable(rerankBin) ? "ready" : "missing"} ${rerankBin}`);
  console.log(`inference-local-small-bin: ${isExecutable(lightBin) ? "ready" : "missing"} ${lightBin}`);
  console.log(`inference-local-medium-bin: ${isExecutable(heavyBin) ? "ready" : "missing"} ${heavyBin}`);
  console.log(`claude-bin: ${isExecutable(claudeBin) ? "ready" : "missing"} ${claudeBin}`);
  console.log(`gemini-bin: ${isExecutable(geminiBin) ? "ready" : "missing"} ${geminiBin}`);
  console.log(`codex-bin: ${isExecutable(codexBin) ? "ready" : "missing"} ${codexBin}`);
  console.log(`agent-mail-db: ${mailDb}`);
  console.log(`agent-jobs-db: ${jobsDb}`);
  console.log(`agent-memory-db: ${memoryDb}`);
  console.log(`agent-state-db: ${stateDb}`);
  console.log(`fleet-db: ${fleetDb}`);
  console.log(`fleet-librarian-db: ${librarianDb}`);
  const socketChecks = [
    { name: "embed-socket", path: embedSocket },
    { name: "rerank-socket", path: rerankSocket },
    { name: "light-socket", path: lightSocket },
    { name: "heavy-socket", path: heavySocket },
    { name: "anthropic-socket", path: join(runtimeDir, "claude.sock") },
    { name: "google-socket", path: join(runtimeDir, "gemini.sock") },
    { name: "openai-socket", path: join(runtimeDir, "openai.sock") },
    { name: "openrouter-socket", path: join(runtimeDir, "openrouter.sock") },
  ];
  const heartbeats = await Promise.all(socketChecks.map(async (entry) => ({ entry, heartbeat: await requestSocketHeartbeat(entry.path) })));
  for (const { entry, heartbeat } of heartbeats) {
    if (heartbeat) {
      console.log(`${entry.name}: healthy label=${heartbeat.label} pid=${heartbeat.pid} uptime_ms=${heartbeat.uptime_ms} path=${entry.path}`);
    } else {
      console.log(`${entry.name}: unavailable ${entry.path}`);
    }
  }
  console.log(`state-dir: ${stateDir}`);
}

switch (process.argv[2]) {
  case "genesis":
    genesisSession();
    break;
  case "start":
    startSession();
    break;
  case "attach":
    attachSession();
    break;
  case "detach":
    detachSession();
    break;
  case "stop":
    stopSession();
    break;
  case "terminus":
    terminusSession();
    break;
  case "down":
    stopSession();
    terminusSession();
    break;
  case "restart":
    stopSession();
    startSession();
    break;
  case "status":
    await showStatus();
    break;
  case "heartbeat-check":
    console.log(JSON.stringify(heartbeatCheck(
      Math.max(1, parseInt(process.argv[3] || "60", 10) || 60),
      Math.max(1, parseInt(process.argv[4] || "300", 10) || 300),
      process.argv[5] || "operator",
      process.argv[6] || "health-alerts",
    )));
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
    genesisSession();
    startSession();
    attachSession();
    break;
  default:
    usage();
}
