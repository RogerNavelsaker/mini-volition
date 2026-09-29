import { Database } from "bun:sqlite";
import { spawnSync } from "bun";
import { spawn as nodeSpawn } from "child_process";
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
  openSync,
  closeSync,
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

const claudeBin = process.env.FLEET_CLAUDE_BIN || "cc";
const geminiBin = process.env.FLEET_GEMINI_BIN || "gemini";
const codexBin = process.env.FLEET_CODEX_BIN || "cod";

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

type ServiceDefinition = {
  name: string;
  bin: string;
  env: Record<string, string>;
};

function providerModels() {
  const config = loadConfig();
  const providerMap = new Map(config.agents.map((agent) => [agent.name, agent.model]));
  return {
    config,
    anthropicModel: process.env.INFERENCE_CLOUD_ANTHROPIC_MODEL || providerMap.get("claude") || "",
    googleModel: process.env.INFERENCE_CLOUD_GOOGLE_MODEL || providerMap.get("gemini") || "",
    openaiModel: process.env.INFERENCE_CLOUD_OPENAI_MODEL || providerMap.get("codex") || "",
    openrouterModel: process.env.INFERENCE_CLOUD_OPENROUTER_MODEL || "",
  };
}

function serviceBaseEnv() {
  const onnxLibDir = join(fleetRoot, "lib", "onnxruntime", "linux", "x64");
  const ldLibraryPath = process.env.LD_LIBRARY_PATH
    ? `${onnxLibDir}:${process.env.LD_LIBRARY_PATH}`
    : onnxLibDir;
  return {
    AGENT_MAIL_DB: resolve(mailDb),
    AGENT_JOBS_DB: resolve(jobsDb),
    AGENT_MEMORY_DB: resolve(memoryDb),
    AGENT_STATE_DB: resolve(stateDb),
    FLEET_LIBRARIAN_DB: resolve(librarianDb),
    INFERENCE_LOCAL_EMBED_SOCKET: resolve(embedSocket),
    INFERENCE_LOCAL_RERANK_SOCKET: resolve(rerankSocket),
    INFERENCE_LOCAL_SMALL_SOCKET: resolve(lightSocket),
    INFERENCE_LOCAL_MEDIUM_SOCKET: resolve(heavySocket),
    INFERENCE_CLOUD_ANTHROPIC_SOCKET: resolve(runtimeDir, "claude.sock"),
    INFERENCE_CLOUD_GOOGLE_SOCKET: resolve(runtimeDir, "gemini.sock"),
    INFERENCE_CLOUD_OPENAI_SOCKET: resolve(runtimeDir, "openai.sock"),
    INFERENCE_CLOUD_OPENROUTER_SOCKET: resolve(runtimeDir, "openrouter.sock"),
    LD_LIBRARY_PATH: ldLibraryPath,
    META_REPO_ROOT: fleetRoot,
  };
}

function operatorConsoleEnv() {
  return {
    ...process.env,
    AGENT_MAIL_DB: resolve(mailDb),
    AGENT_JOBS_DB: resolve(jobsDb),
    AGENT_MEMORY_DB: resolve(memoryDb),
    AGENT_STATE_DB: resolve(stateDb),
    META_REPO_ROOT: fleetRoot,
  };
}

function serviceDefinitions(): ServiceDefinition[] {
  const base = serviceBaseEnv();
  const { config, anthropicModel, googleModel, openaiModel, openrouterModel } = providerModels();
  return [
    { name: "inference-cloud-anthropic", bin: join(binDir, "inference-cloud-anthropic"), env: { ...base } },
    { name: "inference-cloud-google", bin: join(binDir, "inference-cloud-google"), env: { ...base } },
    { name: "inference-cloud-openai", bin: join(binDir, "inference-cloud-openai"), env: { ...base } },
    { name: "inference-cloud-openrouter", bin: join(binDir, "inference-cloud-openrouter"), env: { ...base } },
    { name: "inference-local-embed", bin: embedBin, env: { ...base } },
    { name: "inference-local-rerank", bin: rerankBin, env: { ...base } },
    { name: "inference-local-small", bin: lightBin, env: { ...base } },
    { name: "inference-local-medium", bin: heavyBin, env: { ...base } },
    ...config.agents.map((agent): ServiceDefinition => ({
      name: `agent-${agent.name}`,
      bin: harnessBin,
      env: {
        ...base,
        AGENT_NAME: agent.name,
        AGENT_PROMPT_MODE: "provider",
        INFERENCE_CLOUD_SOCKET: resolve(runtimeDir, agent.socket),
        INFERENCE_CLOUD_MODEL: agent.model,
        INFERENCE_CLOUD_ANTHROPIC_MODEL: anthropicModel,
        INFERENCE_CLOUD_GOOGLE_MODEL: googleModel,
        INFERENCE_CLOUD_OPENAI_MODEL: openaiModel,
        INFERENCE_CLOUD_OPENROUTER_MODEL: openrouterModel,
        AGENT_MAIL_BIN: "agent-mail",
      },
    })),
    { name: "fleet-reporter", bin: digestBin, env: { ...base } },
    { name: "fleet-librarian", bin: librarianBin, env: { ...base } },
  ];
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
  ensureServiceDirs();

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

function isCommandAvailable(command: string): boolean {
  if (command.includes("/")) return isExecutable(command);
  return spawnSync(["which", command]).exitCode === 0;
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

function serviceDir(...parts: string[]) {
  return join(runtimeDir, "services", ...parts);
}

function ensureServiceDirs() {
  mkdirSync(serviceDir("pids"), { recursive: true });
  mkdirSync(serviceDir("logs"), { recursive: true });
}

function pidPath(name: string) {
  return serviceDir("pids", `${name}.pid`);
}

function logPath(name: string) {
  return serviceDir("logs", `${name}.log`);
}

function readPid(name: string): number | null {
  const file = pidPath(name);
  if (!existsSync(file)) return null;
  const value = Number.parseInt(readFileSync(file, "utf-8").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serviceState(service: ServiceDefinition) {
  const pid = readPid(service.name);
  const running = pidAlive(pid);
  if (!running && existsSync(pidPath(service.name))) {
    try {
      unlinkSync(pidPath(service.name));
    } catch {}
  }
  return { pid, running };
}

function sessionExists(): boolean {
  return serviceDefinitions().some((service) => readPid(service.name) !== null || existsSync(pidPath(service.name)));
}

function sessionRunning(): boolean {
  return serviceDefinitions().some((service) => serviceState(service).running);
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
  for (const command of [claudeBin, geminiBin, codexBin]) {
    if (!isCommandAvailable(command)) {
      console.error(`missing agent binary: ${command}`);
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
  ensureRuntimeDir();
  ensureServiceDirs();
  const services = serviceDefinitions();
  const started: string[] = [];
  for (const service of services) {
    if (serviceState(service).running) continue;
    const stdoutFd = openSync(logPath(service.name), "a");
    const stderrFd = openSync(logPath(service.name), "a");
    const child = nodeSpawn(service.bin, [], {
      cwd: fleetRoot,
      env: { ...process.env, ...service.env },
      stdio: ["ignore", stdoutFd, stderrFd],
      detached: true,
    });
    closeSync(stdoutFd);
    closeSync(stderrFd);
    child.unref();
    writeFileSync(pidPath(service.name), `${child.pid}\n`);
    started.push(service.name);
  }
  const running = services.filter((service) => serviceState(service).running).length;
  console.log(`fleet services running ${running}/${services.length}${started.length ? ` started=${started.join(",")}` : ""}`);
}

function attachSession() {
  const result = spawnSync([operatorBin], {
    cwd: fleetRoot,
    env: operatorConsoleEnv(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(result.exitCode);
}

function detachSession() {
  console.log("fleet detach is a no-op without a multiplexer; use operator-console directly");
}

function stopSession() {
  const services = serviceDefinitions();
  const stopped: string[] = [];
  for (const service of services) {
    const pid = readPid(service.name);
    if (!pidAlive(pid)) {
      if (existsSync(pidPath(service.name))) {
        try {
          unlinkSync(pidPath(service.name));
        } catch {}
      }
      continue;
    }
    try {
      process.kill(pid!, "SIGTERM");
      stopped.push(service.name);
    } catch {}
  }
  Bun.sleepSync(300);
  for (const service of services) {
    const pid = readPid(service.name);
    if (!pidAlive(pid)) {
      if (existsSync(pidPath(service.name))) {
        try {
          unlinkSync(pidPath(service.name));
        } catch {}
      }
      continue;
    }
    try {
      process.kill(pid!, "SIGKILL");
    } catch {}
    if (existsSync(pidPath(service.name))) {
      try {
        unlinkSync(pidPath(service.name));
      } catch {}
    }
  }
  console.log(`fleet services stopped${stopped.length ? ` ${stopped.join(",")}` : ""}`);
}

async function showStatus() {
  ensureRuntimeDir();
  ensureStateDir();
  ensureServiceDirs();
  const services = serviceDefinitions();
  const runningServices = services.filter((service) => serviceState(service).running);
  console.log(`fleet: ${runningServices.length > 0 ? "running" : sessionExists() ? "partial" : "stopped"} (${runningServices.length}/${services.length} services)`);

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
  console.log(`claude-bin: ${isCommandAvailable(claudeBin) ? "ready" : "missing"} ${claudeBin}`);
  console.log(`gemini-bin: ${isCommandAvailable(geminiBin) ? "ready" : "missing"} ${geminiBin}`);
  console.log(`codex-bin: ${isCommandAvailable(codexBin) ? "ready" : "missing"} ${codexBin}`);
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
  for (const service of services) {
    const state = serviceState(service);
    console.log(`service-${service.name}: ${state.running ? `running pid=${state.pid}` : "stopped"} log=${logPath(service.name)}`);
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
