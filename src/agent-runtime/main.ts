import { Database } from "bun:sqlite";
import { spawn } from "bun";
import { execFileSync, execSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createConnection } from "net";
import { join, dirname } from "path";
import { ensureSchema as ensureMemorySchema } from "../agent-memory/schema";
import { appendMemorySourceArtifact } from "../state-artifacts/lib";
import { buildProviderTargets, executeProviderTargets, type ProviderTurnTarget } from "./failover";
import { chooseRetrievalMode, chooseTurnProfile, classifySourceGroup, randomizedCooldownMs, refractoryCooldownMs, turnProfileConfig, wakeClassFor as schedulerWakeClassFor, type RetrievalMode, type TurnProfile, type WakeClass, type WakeSource, type WakeSourceGroup } from "./policy";
import { ensureTurnJournal, recoverInterruptedTurns, replayPolicyForAction, type TurnCheckpoint, type TurnPhase } from "./recovery";

const name = process.env.AGENT_NAME;
const command = process.env.AGENT_COMMAND?.split(" ") || [];
const promptMode = process.env.AGENT_PROMPT_MODE || "provider";
const providerSocket = process.env.INFERENCE_CLOUD_SOCKET || "";
const providerModel = process.env.INFERENCE_CLOUD_MODEL || "";
const mailBin = process.env.AGENT_MAIL_BIN || "agent-mail";
const memoryDbPath = process.env.AGENT_MEMORY_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-memory.db");
const stateDbPath = process.env.AGENT_STATE_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-state.db");
const librarianDbPath = process.env.FLEET_LIBRARIAN_DB || join(process.env.META_REPO_ROOT || ".", "runtime/fleet-librarian.db");
const mailClaimTtlMs = Math.max(30_000, parseInt(process.env.FLEET_MAIL_CLAIM_TTL_MS || "300000", 10) || 300000);
const jobsBin = process.env.AGENT_JOBS_BIN || "agent-jobs";
const jobClaimTtlMs = Math.max(30_000, parseInt(process.env.FLEET_JOB_CLAIM_TTL_MS || "300000", 10) || 300000);
const turnStaleMs = Math.max(30_000, parseInt(process.env.FLEET_TURN_STALE_MS || "300000", 10) || 300000);
const memoryBin = process.env.AGENT_MEMORY_BIN || "agent-memory";
const embedSocket = process.env.INFERENCE_LOCAL_EMBED_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/embed.sock");
const lightSocket = process.env.INFERENCE_LOCAL_SMALL_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/light.sock");
const heavySocket = process.env.INFERENCE_LOCAL_MEDIUM_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/heavy.sock");
const anthropicSocket = process.env.INFERENCE_CLOUD_ANTHROPIC_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/claude.sock");
const googleSocket = process.env.INFERENCE_CLOUD_GOOGLE_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/gemini.sock");
const openaiSocket = process.env.INFERENCE_CLOUD_OPENAI_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/openai.sock");
const openrouterSocket = process.env.INFERENCE_CLOUD_OPENROUTER_SOCKET || join(process.env.META_REPO_ROOT || ".", "runtime/openrouter.sock");
const memoryDb = new Database(memoryDbPath);
const stateDb = new Database(stateDbPath);
const librarianDb = new Database(librarianDbPath);
for (const db of [memoryDb, stateDb, librarianDb]) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}
ensureMemorySchema(memoryDb);

// --- Machete: hard output limit (volition-style) ---
const MACHETE_LIMIT = Math.max(1000, parseInt(process.env.FLEET_MACHETE_LIMIT || "20000", 10) || 20000);
const MACHETE_MARKER = "\n[TRUNCATED BY HARNESS — output exceeded budget]";

// --- Section budgets (priority-tiered context assembly) ---
// P1 (critical): inbound burst, action envelope — no cap
// P2 (high): working memory, archival — capped
// P3 (normal): episodic, digests — capped
const BUDGET_ARCHIVAL_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_ARCHIVAL || "3000", 10) || 3000);
const BUDGET_LINKED_ARCHIVAL_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_LINKED_ARCHIVAL || "1800", 10) || 1800);
const BUDGET_EPISODIC_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_EPISODIC || "2000", 10) || 2000);
const BUDGET_DIGEST_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_DIGEST || "1500", 10) || 1500);
const BUDGET_WORKING_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_WORKING || "3000", 10) || 3000);
const BUDGET_TRACE_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_TRACE || "1200", 10) || 1200);
const BUDGET_TIMELINE_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_TIMELINE || "1400", 10) || 1400);
const BUDGET_FACTS_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_FACTS || "1400", 10) || 1400);
const BUDGET_INVALIDATED_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_INVALIDATED || "1200", 10) || 1200);

// --- Output budget communicated to agent (CEP-inspired) ---
const OUTPUT_BUDGET_CHARS = Math.max(500, parseInt(process.env.FLEET_OUTPUT_BUDGET || "8000", 10) || 8000);

// --- Scratchpad (tier 1.5, volition clipboard equivalent) ---
const SCRATCHPAD_CAP = Math.max(500, parseInt(process.env.FLEET_SCRATCHPAD_CAP || "6000", 10) || 6000);
const SCRATCHPAD_WARN_RATIO = 0.8; // warn agent when scratchpad is 80% full
const BUDGET_SCRATCHPAD_CHARS = Math.max(200, parseInt(process.env.FLEET_BUDGET_SCRATCHPAD || "4000", 10) || 4000);

function applyMachete(text: string): { text: string; truncated: boolean } {
  if (text.length <= MACHETE_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, MACHETE_LIMIT) + MACHETE_MARKER, truncated: true };
}

function budgetSection(items: string[], budgetChars: number): string[] {
  const result: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.length > budgetChars) {
      const remaining = budgetChars - used;
      if (remaining > 80) result.push(item.slice(0, remaining) + "…");
      break;
    }
    result.push(item);
    used += item.length;
  }
  return result;
}

function toToonTable(rows: Array<Record<string, string>>, fields: string[]): string {
  if (rows.length === 0) return "";
  const header = `[${rows.length}]{${fields.join(",")}}:`;
  const body = rows.map((row) => fields.map((f) => {
    const v = row[f] ?? "";
    return /[,"\n\t{}[\]:]/.test(v) || v === "" ? `"${v.replace(/"/g, '\\"')}"` : v;
  }).join(",")).join("\n");
  return `${header}\n${body}`;
}

// --- Scratchpad file I/O (per-agent, canonical markdown file) ---
function scratchpadPath(agentName: string): string {
  return join(process.cwd(), ".fleet", "run", "scratchpads", `${agentName}.md`);
}

function readScratchpad(agentName: string): string {
  try {
    return readFileSync(scratchpadPath(agentName), "utf-8");
  } catch {
    return "";
  }
}

function writeScratchpad(agentName: string, content: string) {
  const path = scratchpadPath(agentName);
  mkdirSync(dirname(path), { recursive: true });
  const capped = content.length > SCRATCHPAD_CAP ? content.slice(0, SCRATCHPAD_CAP) : content;
  writeFileSync(path, capped, "utf-8");
}

function scratchpadStatus(content: string): { chars: number; cap: number; ratio: number; warning: string } {
  const chars = content.length;
  const ratio = chars / SCRATCHPAD_CAP;
  let warning = "";
  if (ratio >= 1.0) warning = "FULL — prune now or new writes will be truncated";
  else if (ratio >= SCRATCHPAD_WARN_RATIO) warning = `${Math.round(ratio * 100)}% full — consider pruning`;
  return { chars, cap: SCRATCHPAD_CAP, ratio, warning };
}

if (!name) {
  console.error("AGENT_NAME is required");
  process.exit(64);
}

if (promptMode === "provider") {
  if (!providerSocket) {
  console.error("INFERENCE_CLOUD_SOCKET is required in provider mode");
    process.exit(64);
  }
} else if (promptMode === "acp") {
  if (command.length === 0) {
    console.error("AGENT_COMMAND is required in ACP mode");
    process.exit(64);
  }
} else {
  console.error(`Unsupported AGENT_PROMPT_MODE '${promptMode}'. Supported: provider, acp`);
  process.exit(64);
}

function runMemoryQuery(query: string, ...args: any[]): any[] {
  try {
    return memoryDb.prepare(query).all(...args);
  } catch (e) {
    return [];
  }
}

function runStateQuery(query: string, ...args: any[]): any[] {
  try {
    return stateDb.prepare(query).all(...args);
  } catch (e) {
    return [];
  }
}

function runMemoryInsert(query: string, ...args: any[]) {
  try {
    memoryDb.prepare(query).run(...args);
  } catch (e) {
    console.error(`Failed to insert: ${query}`, e);
  }
}

function runStateInsert(query: string, ...args: any[]) {
  try {
    stateDb.prepare(query).run(...args);
  } catch (e) {
    console.error(`Failed state insert: ${query}`, e);
  }
}

function runLibrarianInsert(query: string, ...args: any[]) {
  try {
    librarianDb.prepare(query).run(...args);
  } catch (e) {
    console.error(`Failed librarian insert: ${query}`, e);
  }
}

function ensureMaintenanceJournal() {
  runLibrarianInsert(
    `CREATE TABLE IF NOT EXISTS fleet_maintenance_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      task TEXT NOT NULL,
      phase TEXT NOT NULL,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  );
}

function ensureRecoverySchema() {
  ensureTurnJournal(runStateInsert);
}

function promptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sendMessage(recipient: string, layer: string, body: string) {
  try {
    execFileSync(mailBin, ["send", recipient, layer, body], { stdio: "ignore" });
  } catch (e) {
    console.error(`Failed to send message to ${recipient} on ${layer}`, e);
  }
}

ensureMaintenanceJournal();
ensureRecoverySchema();

function runJsonCommand(bin: string, args: string[]): any | null {
  try {
    const output = execFileSync(bin, args, { encoding: "utf-8" }).trim();
    return output ? JSON.parse(output) : null;
  } catch (e) {
    console.error(`Failed to run ${bin} ${args.join(" ")}`, e);
    return null;
  }
}

function setRuntimeState(
  status: string,
  currentTask: string | null = null,
  wakeReason: string | null = null,
  lastError: string | null = null,
  cooldownUntil: string | null = null,
  lastMessageId: string | null = null,
) {
  try {
    execFileSync(
      "agent-state",
      ["set", name!, status, currentTask ?? "", wakeReason ?? "", lastError ?? "", cooldownUntil ?? "", lastMessageId ?? ""],
      { stdio: "ignore" },
    );
  } catch (e) {
    console.error(`Failed to set runtime state for ${name}`, e);
  }
}

function readGhostedTurn(): GhostedTurn | null {
  return (runJsonCommand("agent-state", ["ghost-get", name!]) ?? null) as GhostedTurn | null;
}

function recordGhostedTurn(
  turnKey: string,
  wake: WakeEvent,
  failureKind: string,
  detail: string,
  checkpointStatus: string | null = null,
) {
  try {
    execFileSync(
      "agent-state",
      [
        "ghost-set",
        name!,
        turnKey,
        wake.source,
        wake.wakeReason,
        failureKind,
        String(wake.burst.primary.id),
        detail,
        checkpointStatus ?? "",
      ],
      { stdio: "ignore" },
    );
  } catch (e) {
    console.error(`Failed to record ghosted turn for ${name}`, e);
  }
}

function clearGhostedTurn() {
  try {
    execFileSync("agent-state", ["ghost-clear", name!], { stdio: "ignore" });
  } catch (e) {
    console.error(`Failed to clear ghosted turn for ${name}`, e);
  }
}

function formatGhostOrientation(ghost: GhostedTurn): string {
  const lines = [
    `§ORIENTATION ! ALERT: AgentGhosted`,
    `- previous_turn=${ghost.turn_key}`,
    `- failure_kind=${ghost.failure_kind}`,
    `- wake_source=${ghost.wake_source}`,
    `- wake_reason=${ghost.wake_reason}`,
  ];
  if (ghost.message_id != null) lines.push(`- message_id=${ghost.message_id}`);
  if (ghost.checkpoint_status) lines.push(`- checkpoint_status=${ghost.checkpoint_status}`);
  if (ghost.last_action) {
    lines.push(`- last_action=${ghost.last_action.action_type} phase=${ghost.last_action.phase}${ghost.last_action.detail ? ` detail=${ghost.last_action.detail}` : ""}`);
  } else {
    lines.push(`- last_action=(none recorded before failure)`);
  }
  if (ghost.detail) lines.push(`- detail=${ghost.detail}`);
  lines.push(`Acknowledge this failure in your first reasoning block, then continue the turn.`);
  return lines.join("\n");
}

function readGovernor(windowSec = 120, turnLimit = 4): { allowed: boolean; forced_cooldown_until?: string | null } {
  return (runJsonCommand("fleet", ["governor-status", name!, String(windowSec), String(turnLimit)]) ?? { allowed: true }) as { allowed: boolean; forced_cooldown_until?: string | null };
}

function bumpGovernor(windowSec = 120, turnLimit = 4, reason = "turn_complete") {
  runJsonCommand("fleet", ["governor-bump", name!, String(windowSec), String(turnLimit), reason]);
}

function forceGovernor(cooldownSec: number, reason: string) {
  return runJsonCommand("fleet", ["governor-force", name!, String(cooldownSec), reason]) as { forced_cooldown_until?: string | null } | null;
}

type LimitState = "none" | "cancelled" | "quota_exhausted" | "transient_capacity";
type LimitWindow = {
  info: string;
  sleepMs: number;
  availableAt: string;
  extracted: boolean;
};
type IncomingMessage = { id: number; sender: string; body: string; layer: string; recipient?: string; created_at: string };
type IncomingBurst = { primary: IncomingMessage; messages: IncomingMessage[]; mergedCount: number; remainingUnread: number };
type ReplyAction = { type: "reply"; message: string; channel?: "same" };
type NoopAction = { type: "noop" };
type NoteAction = { type: "note"; message: string };
type SleepUntilAction = { type: "sleep_until"; until: string };
type QueueTaskAction = { type: "queue_task"; task: string; target_agent?: string; run_at?: string; priority?: "low" | "normal" | "high" | "urgent" };
type EscalateAction = { type: "escalate"; message: string; channel?: "private" | "urgent" };
type ScratchpadAction = { type: "scratchpad"; op: "append" | "replace" | "clear"; content?: string };
type SpawnScribeAction = { type: "spawn_scribe"; name: string; task: string };
type Action = ReplyAction | NoopAction | NoteAction | SleepUntilAction | QueueTaskAction | EscalateAction | ScratchpadAction | SpawnScribeAction;
type TurnExecutionProfile = {
  profile: TurnProfile;
  model: string | null;
  reasoning_effort: string | null;
  timeout_ms: number;
  source: "model" | "deterministic" | "rerun";
  reason: string;
};
type BufferedTurnPhaseRecord = {
  turn_key: string;
  wake_source: string;
  wake_reason: string;
  message_id?: number | null;
  phase: TurnPhase;
  detail?: string | null;
};
type BufferedTurnCheckpointRecord = Omit<TurnCheckpoint, "agent_name">;
type ActionEnvelope = {
  schema_version?: number;
  summary?: string;
  actions: Action[];
  state?: { current_task?: string };
};
type ValidatedEnvelope = { ok: true; envelope: ActionEnvelope } | { ok: false; error: string };
type TurnAssembly = {
  inboundBurstText: string;
  orientationAlert: string | null;
  sleepDeltaSeconds: number;
  recentDigests: Array<{ id?: number; summary: string }>;
  episodic: Array<{ id?: number; summary: string }>;
  archival: Array<{ id?: number; reflection: string }>;
  currentFacts: Array<{ id?: number; subject: string; predicate: string; object: string; valid_from: string | null }>;
  recentInvalidations: Array<{
    kind: "link" | "fact";
    relation?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    from_content?: string;
    to_content?: string;
    valid_to: string | null;
  }>;
  linkedArchival: Array<{ id?: number; relation: string; weight: number; reflection: string }>;
  timelineEvents: Array<{
    id: number;
    relation: string;
    weight: number;
    evidence: string | null;
    valid_from: string | null;
    valid_to: string | null;
    from: { id: number; kind: string; content: string };
    to: { id: number; kind: string; content: string };
  }>;
  retrievalTraces: Array<{
    id?: number;
    record_kind: string;
    source_kind: string;
    score: number;
    fused_score: number;
    top_bonus: number;
    lexical_score: number;
    link_boost: number;
    strength: number;
    decay_score: number;
  }>;
  workingLog: Array<{ role: string; content: string }>;
  memorySelection: string;
  recalledArtifactIds: number[];
  scratchpad: string;
  scratchpadStatus: { chars: number; cap: number; ratio: number; warning: string };
};
type GhostedTurn = {
  agent_name: string;
  turn_key: string;
  wake_source: string;
  wake_reason: string;
  message_id: number | null;
  failure_kind: string;
  detail: string | null;
  checkpoint_status: string | null;
  last_action?: {
    action_type: string;
    phase: string;
    detail: string | null;
    replay_disposition: string | null;
    replay_reason: string | null;
    created_at: string;
  } | null;
};
type InternalJob = {
  id: number;
  target_agent: string;
  sender: string;
  body: string;
  available_at: string | null;
  status: string;
  priority?: "low" | "normal" | "high" | "urgent";
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
type LocalEvent = {
  id: number;
  target_agent: string;
  event_type: string;
  source: string;
  content: string;
  available_at: string | null;
  status: string;
  claimed_at: string | null;
  claimed_by: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
type JobAlarm = {
  id: number;
  target_agent: string;
  kind: "alarm" | "reminder";
  message: string;
  due_at: string;
  status: string;
  source_job_id: number | null;
  fired_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};
type WakeCandidate = {
  source: WakeSource;
  sourceGroup: WakeSourceGroup;
  wakeReason: string;
  priority: number;
  wakeClass: WakeClass;
  burst: IncomingBurst;
  claimId: number;
  sourceLabel: string;
};
type WakeEvent = {
  source: WakeSource;
  sourceGroup: WakeSourceGroup;
  wakeReason: string;
  burst: IncomingBurst;
  priority: number;
  wakeClass: WakeClass;
};
type JobPriority = "low" | "normal" | "high" | "urgent";
type MemoryLookup = {
  recentDigests: Array<{ id?: number; summary: string }>;
  episodic: Array<{ id?: number; summary: string }>;
  archival: Array<{ id?: number; reflection: string }>;
  currentFacts?: Array<{ id?: number; subject: string; predicate: string; object: string; valid_from: string | null }>;
  recentInvalidations?: Array<{
    kind: "link" | "fact";
    relation?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    from_content?: string;
    to_content?: string;
    valid_to: string | null;
  }>;
  linkedArchival?: Array<{ id?: number; relation: string; weight: number; reflection: string }>;
  timelineEvents?: Array<{
    id: number;
    relation: string;
    weight: number;
    evidence: string | null;
    valid_from: string | null;
    valid_to: string | null;
    from: { id: number; kind: string; content: string };
    to: { id: number; kind: string; content: string };
  }>;
  traces?: Array<{
    id?: number;
    record_kind: string;
    source_kind: string;
    score: number;
    fused_score: number;
    top_bonus: number;
    lexical_score: number;
    link_boost: number;
    strength: number;
    decay_score: number;
  }>;
  retrievalMode?: RetrievalMode;
  memorySelection: string;
  freshness?: {
    stale: boolean;
    stale_after_seconds: number;
    last_refresh_at: string | null;
    last_status: string | null;
    last_error: string | null;
    artifact_count: number;
    source: string | null;
  };
};
const ACTION_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    schema_version: { type: "number", description: "Optional schema marker for the action envelope." },
    summary: { type: "string" },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        current_task: { type: "string" },
      },
    },
    actions: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "message"],
            properties: {
              type: { const: "reply" },
              message: { type: "string", minLength: 1 },
              channel: { const: "same" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: { const: "noop" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "message"],
            properties: {
              type: { const: "note" },
              message: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "until"],
            properties: {
              type: { const: "sleep_until" },
              until: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "task"],
            properties: {
              type: { const: "queue_task" },
              task: { type: "string", minLength: 1 },
              target_agent: { type: "string", minLength: 1 },
              run_at: { type: "string", minLength: 1 },
              priority: { enum: ["low", "normal", "high", "urgent"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "message"],
            properties: {
              type: { const: "escalate" },
              message: { type: "string", minLength: 1 },
              channel: { enum: ["private", "urgent"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "op"],
            properties: {
              type: { const: "scratchpad" },
              op: { enum: ["append", "replace", "clear"] },
              content: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "name", "task"],
            properties: {
              type: { const: "spawn_scribe" },
              name: { type: "string", minLength: 1 },
              task: { type: "string", minLength: 1 },
            },
          },
        ],
      },
    },
  },
} as const;

function formatSchemaError(reason: string): string {
  return `${reason} JSON schema: ${JSON.stringify(ACTION_ENVELOPE_SCHEMA)}`;
}

function classifyLimitState(output: string, exitCode: number): LimitState {
  if (!output.trim()) return "none";

  const normalized = output.toLowerCase();
  if (normalized.includes("operation cancelled") || normalized.includes("cancelled")) {
    return "cancelled";
  }

  const quotaPatterns = [
    /you'?ve hit your limit/i,
    /quota limit/i,
    /you have exhausted your capacity on this model/i,
    /your quota will reset after/i,
    /resource_exhausted/i,
  ];
  if (quotaPatterns.some((pattern) => pattern.test(output))) {
    return "quota_exhausted";
  }

  if (exitCode === 0) return "none";

  const transientPatterns = [
    /\b429\b/i,
    /model_capacity_exhausted/i,
    /no capacity available/i,
    /rate limit(?:ed|ing)?/i,
    /too many requests/i,
  ];
  if (transientPatterns.some((pattern) => pattern.test(output))) {
    return "transient_capacity";
  }

  return "none";
}

function extractLimitInfo(output: string): string {
  const matchers = [
    /you'?ve hit your limit.*?(?:resets\s+\d+(?:am|pm)\s*\([^)]+\)|$)/is,
    /you have exhausted your capacity on this model\..*?(?:your quota will reset after\s+[0-9hms]+\.?|$)/is,
    /retry after\s+.+$/im,
    /try again in\s+.+$/im,
    /available again in\s+.+$/im,
    /rate limit(?:ed|ing)?.*$/im,
    /quota limit:.*$/im,
  ];

  for (const matcher of matchers) {
    const match = output.match(matcher);
    if (match) return match[0].replace(/\s+/g, " ").trim();
  }

  return "Provider capacity is temporarily unavailable.";
}

function durationTextToMs(text: string): number | null {
  let totalSeconds = 0;
  for (const match of text.matchAll(/(\d+)\s*(h(?:ours?)?|hr|hrs|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/ig)) {
    const value = Number(match[1] || 0);
    const unit = match[2]?.toLowerCase() || "";
    if (unit.startsWith("h")) totalSeconds += value * 60 * 60;
    else if (unit.startsWith("m")) totalSeconds += value * 60;
    else if (unit.startsWith("s")) totalSeconds += value;
  }
  if (totalSeconds > 0) return totalSeconds * 1000;

  const compact = text.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!compact) return null;

  const hours = Number(compact[1] || 0);
  const minutes = Number(compact[2] || 0);
  const seconds = Number(compact[3] || 0);
  if (hours === 0 && minutes === 0 && seconds === 0) return null;

  return (((hours * 60) + minutes) * 60 + seconds) * 1000;
}

function extractRelativeLimitMs(limitInfo: string): number | null {
  const relativePatterns = [
    /reset after\s+([a-z0-9\s]+)/i,
    /retry after\s+([a-z0-9\s]+)/i,
    /try again in\s+([a-z0-9\s]+)/i,
    /available again in\s+([a-z0-9\s]+)/i,
    /resets in\s+([a-z0-9\s]+)/i,
  ];

  for (const pattern of relativePatterns) {
    const match = limitInfo.match(pattern);
    if (!match) continue;
    const durationMs = durationTextToMs(match[1]);
    if (durationMs !== null) return durationMs;
  }

  return null;
}

function extractAbsoluteLimitMs(limitInfo: string): number | null {
  const absoluteReset = limitInfo.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!absoluteReset) return null;

  let targetHour = parseInt(absoluteReset[1], 10);
  const targetMinute = parseInt(absoluteReset[2] || "0", 10);
  const isPm = absoluteReset[3].toLowerCase() === "pm";
  if (isPm && targetHour < 12) targetHour += 12;
  if (!isPm && targetHour === 12) targetHour = 0;

  const tz = absoluteReset[4];
  const now = new Date();
  let targetTime = new Date(now.getTime());
  targetTime.setMinutes(targetMinute);
  targetTime.setSeconds(0);
  targetTime.setMilliseconds(0);

  for (let i = 0; i < 48; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    } as any).formatToParts(targetTime);
    const hour = Number(parts.find((part) => part.type === "hour")?.value || "-1");
    const minute = Number(parts.find((part) => part.type === "minute")?.value || "-1");
    if (hour === targetHour && minute === targetMinute && targetTime > now) {
      return targetTime.getTime() - now.getTime();
    }
    targetTime = new Date(targetTime.getTime() + 60 * 1000);
  }

  return null;
}

function getLimitWindow(limitInfo: string, limitState: LimitState): LimitWindow {
  const relativeMs = extractRelativeLimitMs(limitInfo);
  const absoluteMs = extractAbsoluteLimitMs(limitInfo);
  const fallbackMs =
    limitState === "none" || limitState === "cancelled"
      ? 0
      : randomizedCooldownMs(limitState);
  const sleepMs = Math.max(0, relativeMs ?? absoluteMs ?? fallbackMs);

  return {
    info: limitInfo,
    sleepMs,
    availableAt: new Date(Date.now() + sleepMs).toISOString(),
    extracted: relativeMs !== null || absoluteMs !== null,
  };
}

function summarizeIncomingBurst(burst: IncomingBurst): string {
  const senders = [...new Set(burst.messages.map((msg) => msg.sender))];
  const merged = burst.mergedCount > 1 ? `${burst.mergedCount} queued messages` : "1 message";
  const queued = burst.remainingUnread > 0 ? ` ${burst.remainingUnread} unrelated unread messages remain queued.` : "";
  return `Woke to ${merged} on ${burst.primary.layer} from ${senders.join(", ")}.${queued}`;
}

function parseActionEnvelope(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  return null;
}

function validateAction(action: unknown): Action | null {
  if (!action || typeof action !== "object") return null;

  const value = action as Record<string, unknown>;
  if (value.type === "reply") {
    if (typeof value.message !== "string" || !value.message.trim()) return null;
    if (value.channel !== undefined && value.channel !== "same") return null;
    return { type: "reply", message: value.message, channel: "same" };
  }

  if (value.type === "noop") {
    return { type: "noop" };
  }

  if (value.type === "note") {
    if (typeof value.message !== "string" || !value.message.trim()) return null;
    return { type: "note", message: value.message };
  }

  if (value.type === "sleep_until") {
    if (typeof value.until !== "string" || !value.until.trim()) return null;
    const deadline = new Date(value.until.endsWith("Z") ? value.until : `${value.until}Z`);
    if (Number.isNaN(deadline.getTime())) return null;
    return { type: "sleep_until", until: deadline.toISOString() };
  }

  if (value.type === "queue_task") {
    if (typeof value.task !== "string" || !value.task.trim()) return null;
    let runAt: string | undefined;
    if (value.run_at !== undefined) {
      if (typeof value.run_at !== "string" || !value.run_at.trim()) return null;
      const runDate = new Date(value.run_at.endsWith("Z") ? value.run_at : `${value.run_at}Z`);
      if (Number.isNaN(runDate.getTime())) return null;
      runAt = runDate.toISOString();
    }
    if (value.target_agent !== undefined && (typeof value.target_agent !== "string" || !value.target_agent.trim())) return null;
    if (value.priority !== undefined && !["low", "normal", "high", "urgent"].includes(String(value.priority))) return null;
    return {
      type: "queue_task",
      task: value.task.trim(),
      target_agent: typeof value.target_agent === "string" ? value.target_agent.trim() : undefined,
      run_at: runAt,
      priority: typeof value.priority === "string" ? value.priority as QueueTaskAction["priority"] : undefined,
    };
  }

  if (value.type === "escalate") {
    if (typeof value.message !== "string" || !value.message.trim()) return null;
    if (value.channel !== undefined && value.channel !== "private" && value.channel !== "urgent") return null;
    return {
      type: "escalate",
      message: value.message.trim(),
      channel: value.channel === "urgent" ? "urgent" : "private",
    };
  }

  if (value.type === "scratchpad") {
    const op = value.op;
    if (op !== "append" && op !== "replace" && op !== "clear") return null;
    if (op !== "clear" && (typeof value.content !== "string")) return null;
    return {
      type: "scratchpad",
      op: op as ScratchpadAction["op"],
      content: op === "clear" ? undefined : (value.content as string),
    };
  }

  if (value.type === "spawn_scribe") {
    if (typeof value.name !== "string" || !value.name.trim()) return null;
    if (typeof value.task !== "string" || !value.task.trim()) return null;
    const validNames = ["scribe", "milo", "homer", "roamer", "riker"];
    if (!validNames.includes(value.name.trim().toLowerCase())) return null;
    return { type: "spawn_scribe", name: value.name.trim().toLowerCase(), task: value.task.trim() };
  }

  return null;
}

function validateEnvelope(raw: unknown): ValidatedEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: formatSchemaError("Envelope must be a JSON object.") };
  }

  const envelope = raw as Record<string, unknown>;
  if (envelope.summary !== undefined && typeof envelope.summary !== "string") {
    return { ok: false, error: formatSchemaError("summary must be a string when present.") };
  }

  if (envelope.schema_version !== undefined && typeof envelope.schema_version !== "number") {
    return { ok: false, error: formatSchemaError("schema_version must be a number when present.") };
  }

  if (!Array.isArray(envelope.actions)) {
    return { ok: false, error: formatSchemaError("actions must be an array.") };
  }

  const actions = envelope.actions.map(validateAction);
  if (actions.some((action) => !action)) {
    return { ok: false, error: formatSchemaError("actions contains an invalid or unsupported action.") };
  }

  let state: ActionEnvelope["state"] | undefined;
  if (envelope.state !== undefined) {
    if (!envelope.state || typeof envelope.state !== "object" || Array.isArray(envelope.state)) {
      return { ok: false, error: formatSchemaError("state must be an object when present.") };
    }

    const currentTask = (envelope.state as Record<string, unknown>).current_task;
    if (currentTask !== undefined && typeof currentTask !== "string") {
      return { ok: false, error: formatSchemaError("state.current_task must be a string when present.") };
    }

    state = currentTask !== undefined ? { current_task: currentTask } : {};
  }

  return {
    ok: true,
    envelope: {
      schema_version: typeof envelope.schema_version === "number" ? envelope.schema_version : undefined,
      summary: typeof envelope.summary === "string" ? envelope.summary : undefined,
      state,
      actions: actions as Action[],
    },
  };
}

function recordWorking(role: "assistant" | "system", content: string) {
  runMemoryInsert("INSERT INTO tier1_working (agent_name, role, content) VALUES (?, ?, ?)", name, role, content);
  appendMemorySourceArtifact("working", name!, {
    record_type: "tier1_working",
    agent_name: name,
    role,
    content,
  });
}

type BufferedActionRecord = {
  action_type: string;
  action_index: number;
  phase: string;
  detail: string | null;
  message_id: number | null;
  replay_disposition: string;
  replay_reason: string;
};

function flushActionBatch(records: BufferedActionRecord[]) {
  if (records.length === 0) return;
  try {
    execFileSync(
      "agent-state",
      ["record-actions-batch", name!, JSON.stringify(records)],
      { stdio: "ignore", maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    console.error(`Failed to flush action batch for ${name}`, e);
  }
}

function flushTurnEventBatch(
  phases: BufferedTurnPhaseRecord[],
  checkpoints: BufferedTurnCheckpointRecord[],
) {
  if (phases.length === 0 && checkpoints.length === 0) return;
  try {
    execFileSync(
      "agent-state",
      ["record-turn-events-batch", name!, JSON.stringify({ phases, checkpoints })],
      { stdio: "ignore" },
    );
    phases.length = 0;
    checkpoints.length = 0;
  } catch (e) {
    console.error(`Failed to flush turn events for ${name}`, e);
  }
}

function sleepUntil(target: string): Promise<void> {
  const deadline = new Date(target.endsWith("Z") ? target : `${target}Z`).getTime();
  const sleepMs = Math.max(0, deadline - Date.now());
  return new Promise((resolve) => setTimeout(resolve, sleepMs));
}

function peekInternalJob(): InternalJob | null {
  return (runJsonCommand(jobsBin, ["peek", name!]) ?? null) as InternalJob | null;
}

function reclaimStaleInternalJobs() {
  runJsonCommand(jobsBin, ["reclaim-stale", name!, String(jobClaimTtlMs)]);
}

function peekLocalEvent(): LocalEvent | null {
  return (runJsonCommand(jobsBin, ["event-peek", name!]) ?? null) as LocalEvent | null;
}

function claimLocalEvent(eventId?: number): LocalEvent | null {
  return (runJsonCommand(jobsBin, ["event-claim", name!, ...(eventId ? [String(eventId)] : [])]) ?? null) as LocalEvent | null;
}

function completeLocalEvent(eventId: number, error?: string | null) {
  runJsonCommand(jobsBin, ["event-complete", String(eventId), name!, ...(error ? [error] : [])]);
}

function peekAlarm(): JobAlarm | null {
  return (runJsonCommand(jobsBin, ["alarm-peek", name!]) ?? null) as JobAlarm | null;
}

function claimAlarm(alarmId?: number): JobAlarm | null {
  return (runJsonCommand(jobsBin, ["alarm-claim", name!, ...(alarmId ? [String(alarmId)] : [])]) ?? null) as JobAlarm | null;
}

function completeAlarm(alarmId: number) {
  runJsonCommand(jobsBin, ["alarm-complete", String(alarmId), name!]);
}

function claimInternalJob(jobId?: number): InternalJob | null {
  return (runJsonCommand(jobsBin, ["claim", name!, ...(jobId ? [String(jobId)] : [])]) ?? null) as InternalJob | null;
}

function completeInternalJob(jobId: number) {
  runJsonCommand(jobsBin, ["complete", String(jobId), name!]);
}

function failInternalJob(jobId: number, errorText: string) {
  runJsonCommand(jobsBin, ["fail", String(jobId), name!, errorText]);
}

function rescheduleInternalJob(jobId: number, availableAt: string, errorText: string) {
  runJsonCommand(jobsBin, ["reschedule", String(jobId), name!, availableAt, errorText]);
}

function queueInternalJob(task: string, targetAgent: string, priority: QueueTaskAction["priority"] = "normal", runAt: string | null = null): InternalJob | null {
  return (runJsonCommand(jobsBin, ["queue", targetAgent, name!, task, priority ?? "normal", runAt ?? ""]) ?? null) as InternalJob | null;
}

function isMaintenanceJob(msg: IncomingMessage): boolean {
  return msg.layer === "internal" && msg.sender === "fleet-librarian" && msg.body.startsWith("__maintenance__:");
}

function isRerunJob(msg: IncomingMessage): boolean {
  return msg.layer === "internal" && msg.body.startsWith("__rerun__:");
}

function parseRerunJob(body: string): { source: string; messageId: number; sender: string; layer: string } | null {
  const parts = body.replace(/^__rerun__:/, "").split(":");
  if (parts.length < 4) return null;
  return { source: parts[0], messageId: Number(parts[1]), sender: parts[2], layer: parts[3] };
}

function runMaintenanceJob(agentName: string, taskBody: string): { ok: boolean; detail: string } {
  const task = taskBody.replace(/^__maintenance__:/, "");
  const commands = task === "repair"
    ? [["repair", agentName]]
    : task === "extract"
    ? [["extract", agentName]]
    : [["decay", agentName], ["refresh", agentName], ["rebalance", agentName], ["compact", agentName]];
  for (const args of commands) {
    const result = runJsonCommand(memoryBin, args);
    if (!result) return { ok: false, detail: `${args[0]} failed` };
  }
  return { ok: true, detail: task };
}

function recordMaintenanceOutcome(agentName: string, task: string, phase: string, detail: string | null = null) {
  runLibrarianInsert(
    "INSERT INTO fleet_maintenance_journal (agent_name, task, phase, detail) VALUES (?, ?, ?, ?)",
    agentName,
    task,
    phase,
    detail ?? "",
  );
}

function lookupPreparedMemory(agentName: string, query: string, mode: RetrievalMode): MemoryLookup | null {
  return (runJsonCommand(memoryBin, ["lookup", agentName, query, "3", mode]) ?? null) as MemoryLookup | null;
}

function requestInferenceEmbed(text: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    const socket = createConnection(embedSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: number[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1200);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "embed", texts: [text.slice(0, 1600)] })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        const vector = Array.isArray(parsed?.embeddings?.[0]) ? parsed.embeddings[0].map((v: unknown) => Number(v) || 0) : null;
        finish(vector);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function requestInferenceRetrievalMode(source: WakeSource, burst: IncomingBurst): Promise<RetrievalMode | null> {
  return new Promise((resolve) => {
    const socket = createConnection(lightSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: RetrievalMode | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1800);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "choose_retrieval_mode",
        source,
        layer: burst.primary.layer,
        text: burst.messages.map((entry) => `${entry.layer} ${entry.body}`).join("\n").slice(0, 1800),
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        const mode = parsed?.mode;
        finish(mode === "local" || mode === "global" || mode === "mix" ? mode : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function dot(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < len; i += 1) total += (left[i] || 0) * (right[i] || 0);
  return total;
}

async function chooseRetrievalModeWithInference(source: WakeSource, burst: IncomingBurst): Promise<RetrievalMode> {
  const fallback = chooseRetrievalMode(source, burst);
  const modelChoice = await requestInferenceRetrievalMode(source, burst);
  if (modelChoice) return modelChoice;
  const body = burst.messages.map((entry) => `${entry.layer} ${entry.body}`).join("\n").slice(0, 1600);
  const prototypes: Array<{ mode: RetrievalMode; text: string }> = [
    { mode: "local", text: "urgent private exact bug fix error specific file trace local immediate task" },
    { mode: "global", text: "plan roadmap architecture overview summary broad project status design big picture global context" },
    { mode: "mix", text: "normal mixed turn with both immediate request and broader context memory" },
  ];
  const [queryVector, ...prototypeVectors] = await Promise.all([
    requestInferenceEmbed(body),
    ...prototypes.map((entry) => requestInferenceEmbed(entry.text)),
  ]);
  if (!queryVector || prototypeVectors.some((vector) => !vector)) return fallback;
  const scored = prototypes.map((entry, index) => ({
    mode: entry.mode,
    score: dot(queryVector, prototypeVectors[index] as number[]),
  })).sort((left, right) => right.score - left.score);
  return scored[0]?.mode ?? fallback;
}

function requestInferenceTurnProfile(source: WakeSource, burst: IncomingBurst): Promise<TurnProfile | null> {
  return new Promise((resolve) => {
    const socket = createConnection(lightSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: TurnProfile | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1800);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "choose_turn_profile",
        source,
        layer: burst.primary.layer,
        text: burst.messages.map((entry) => `${entry.layer} ${entry.body}`).join("\n").slice(0, 1800),
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        const profile = parsed?.profile;
        finish(profile === "light" || profile === "full" || profile === "max" ? profile : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function requestScribe(scribeName: string, task: string): Promise<string | null> {
  const lightScribes = ["scribe", "milo"];
  const socketPath = lightScribes.includes(scribeName) ? lightSocket : heavySocket;
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 30000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "scribe", name: scribeName, task })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        finish(parsed?.error ? null : (parsed?.result ?? null));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

type ProviderTurnResponse = {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  stop_reason: string;
  source: string;
  error?: string;
};

function requestProviderTurn(
  socketPath: string,
  model: string,
  system: string,
  promptText: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<ProviderTurnResponse> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value: ProviderTurnResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(value);
    };
    const errorResponse = (error: string): ProviderTurnResponse => ({
      content: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      model,
      stop_reason: "error",
      source: "harness",
      error,
    });
    const timer = setTimeout(() => finish(errorResponse(`Provider turn timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "turn",
        model,
        system,
        messages: [{ role: "user", content: promptText }],
        max_tokens: maxTokens,
        temperature,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        finish(parsed);
      } catch {
        finish(errorResponse("Failed to parse provider response"));
      }
    });
    socket.on("error", (err) => finish(errorResponse(`Provider socket error: ${err.message}`)));
    socket.on("end", () => { if (!settled) finish(errorResponse("Provider socket closed unexpectedly")); });
  });
}

async function requestProviderTurnWithFailover(
  profile: TurnProfile,
  primarySocket: string,
  primaryModel: string,
  system: string,
  promptText: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<ProviderTurnResponse> {
  const targets = buildProviderTargets(
    primarySocket,
    primaryModel,
    profile,
    {
      anthropic: anthropicSocket,
      google: googleSocket,
      openai: openaiSocket,
      openrouter: openrouterSocket,
    },
    process.env,
  );

  return executeProviderTargets(
    profile,
    targets,
    (target: ProviderTurnTarget) => requestProviderTurn(
      target.socketPath,
      target.model,
      system,
      promptText,
      maxTokens,
      temperature,
      timeoutMs,
    ),
    {
      onFallback: (target, attempt, reason, backoffMs) => {
        const mode = targets.length > 1 ? "failover" : "retry";
        recordWorking(
          "system",
          `Provider ${mode} ${attempt}/${targets.length} profile=${profile} provider=${target.provider} model=${target.model} reason=${reason} backoff=${backoffMs}ms`,
        );
      },
    },
  );
}

async function chooseTurnExecutionProfile(source: WakeSource, burst: IncomingBurst): Promise<TurnExecutionProfile> {
  const fallbackProfile = chooseTurnProfile(source, burst);
  const modelChoice = await requestInferenceTurnProfile(source, burst);
  const chosen = modelChoice ?? fallbackProfile;
  const config = turnProfileConfig(chosen);
  return {
    profile: chosen,
    model: config.model,
    reasoning_effort: config.reasoning_effort,
    timeout_ms: config.timeout_ms,
    source: modelChoice ? "model" : "deterministic",
    reason: modelChoice ? "local model classified turn profile" : "wake/layer heuristic classified turn profile",
  };
}

function timelinePreparedMemory(agentName: string, query: string): Array<NonNullable<MemoryLookup["timelineEvents"]>[number]> {
  const result = runJsonCommand(memoryBin, ["timeline", agentName, query, "8"]) as { events?: Array<NonNullable<MemoryLookup["timelineEvents"]>[number]> } | null;
  return result?.events ?? [];
}

function refreshMemoryAsync(agentName: string) {
  try {
    const child = spawn([memoryBin, "refresh", agentName], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (error) {
    console.error(`Failed to start ${memoryBin} refresh for ${agentName}`, error);
  }
}

function reinforceMemoryAsync(agentName: string, artifactIds: number[]) {
  const ids = [...new Set(artifactIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  try {
    const child = spawn([memoryBin, "reinforce", agentName, ids.join(",")], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (error) {
    console.error(`Failed to start ${memoryBin} reinforce for ${agentName}`, error);
  }
}

async function waitForMailBurst(): Promise<IncomingBurst | null> {
  const listener = spawn([mailBin, "listen-burst", "6", "300"]);
  const messageJson = await new Response(listener.stdout).text();
  await listener.exited;

  try {
    return JSON.parse(messageJson) as IncomingBurst;
  } catch {
    return null;
  }
}

function peekMailBurst(): IncomingBurst | null {
  return (runJsonCommand(mailBin, ["peek-burst", "6", "300"]) ?? null) as IncomingBurst | null;
}

function claimMailBurst(primaryId?: number): IncomingBurst | null {
  return (runJsonCommand(mailBin, ["claim-burst", "6", "300", ...(primaryId ? [String(primaryId)] : [])]) ?? null) as IncomingBurst | null;
}

function completeMailBurst(messageIds: number[]) {
  const ids = [...new Set(messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  runJsonCommand(mailBin, ["complete-burst", ...ids.map(String)]);
}

function reclaimStaleMailClaims() {
  runJsonCommand(mailBin, ["reclaim-stale", String(mailClaimTtlMs)]);
}

function releaseMailClaims(messageIds: number[]) {
  const ids = [...new Set(messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  runJsonCommand(mailBin, ["release-claim", ...ids.map(String)]);
}

function internalJobPriority(priority?: JobPriority): number {
  if (priority === "urgent") return 90;
  if (priority === "high") return 70;
  if (priority === "low") return 30;
  return 50;
}

function syntheticBurstFromInternal(
  id: number,
  sender: string,
  body: string,
  createdAt: string,
): IncomingBurst {
  const normalizedCreatedAt = createdAt.endsWith("Z") ? createdAt : `${createdAt}Z`;
  return {
    primary: {
      id,
      sender,
      body,
      layer: "internal",
      recipient: name!,
      created_at: normalizedCreatedAt,
    },
    messages: [
      {
        id,
        sender,
        body,
        layer: "internal",
        recipient: name!,
        created_at: normalizedCreatedAt,
      },
    ],
    mergedCount: 1,
    remainingUnread: 0,
  };
}

function summarizeWakeCandidate(candidate: WakeCandidate, index: number): string {
  const body = candidate.burst.primary.body.replace(/\s+/g, " ").slice(0, 220);
  return [
    `${index}. id=${candidate.claimId}`,
    `source=${candidate.source}`,
    `class=${candidate.wakeClass}`,
    `priority=${candidate.priority}`,
    `group=${candidate.sourceGroup}`,
    `reason=${candidate.wakeReason}`,
    `sender=${candidate.burst.primary.sender}`,
    `layer=${candidate.burst.primary.layer}`,
    `body=${body}`,
  ].join(" | ");
}

function renderWakeChoicePrompt(candidates: WakeCandidate[]): string {
  return [
    "Choose the next wake to handle.",
    "Return strict JSON only: {\"id\": <candidate id>, \"reason\": \"<short reason>\"}.",
    "Prefer urgent/direct work when needed, but you may defer noisy or low-leverage work.",
    "",
    "Candidates:",
    ...candidates.map((candidate, index) => summarizeWakeCandidate(candidate, index + 1)),
  ].join("\n");
}

function parseWakeChoice(raw: string, candidates: WakeCandidate[]): WakeCandidate | null {
  const parsed = parseActionEnvelope(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const chosenId = (parsed as Record<string, unknown>).id;
  const id = typeof chosenId === "number" ? chosenId : typeof chosenId === "string" ? Number(chosenId) : NaN;
  if (!Number.isInteger(id)) return null;
  return candidates.find((candidate) => candidate.claimId === id) ?? null;
}

function deterministicWakeChoice(candidates: WakeCandidate[]): WakeCandidate | null {
  const sourceRank = (source: WakeSource): number => {
    if (source === "internal_job") return 4;
    if (source === "alarm") return 3;
    if (source === "local_event") return 2;
    return 1;
  };
  return [...candidates].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (left.wakeClass !== right.wakeClass) return left.wakeClass === "hot" ? -1 : 1;
    if (sourceRank(right.source) !== sourceRank(left.source)) return sourceRank(right.source) - sourceRank(left.source);
    return left.claimId - right.claimId;
  })[0] ?? null;
}

const refractoryCooldowns = new Map<WakeSourceGroup, number>();

function wakeClassFor(source: WakeSource, burst: IncomingBurst, _jobPriority?: JobPriority): WakeClass {
  return schedulerWakeClassFor(source, burst.primary.layer);
}

function wakePriorityFor(source: WakeSource, burst: IncomingBurst, jobPriority?: JobPriority): number {
  if (source === "internal_job") {
    return internalJobPriority(jobPriority);
  }
  if (source === "alarm") {
    return burst.primary.body.startsWith("reminder:") ? 55 : 65;
  }
  if (source === "local_event") {
    return 60;
  }
  const layer = burst.primary.layer.toLowerCase();
  if (layer === "urgent") return 100;
  if (layer === "private") return 80;
  if (layer === "public") return 60;
  return 20;
}

function wakeSourceGroupFor(source: WakeSource, burst: IncomingBurst): WakeSourceGroup {
  return classifySourceGroup(source, burst.primary.layer);
}

function requestInferenceWakeChoice(candidates: WakeCandidate[]): Promise<WakeCandidate | null> {
  return new Promise((resolve) => {
    const socket = createConnection(lightSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: WakeCandidate | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 2000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "choose_next_wake",
        candidates: candidates.map((candidate) => ({
          id: candidate.claimId,
          source: candidate.source,
          wake_class: candidate.wakeClass,
          priority: candidate.priority,
          source_group: candidate.sourceGroup,
          wake_reason: candidate.wakeReason,
          sender: candidate.burst.primary.sender,
          layer: candidate.burst.primary.layer,
          body: candidate.burst.primary.body,
        })),
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(parseWakeChoice(buffer.slice(0, newline).trim(), candidates));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function claimWakeCandidate(candidate: WakeCandidate): WakeEvent | null {
  if (candidate.source === "internal_job") {
    const claimedJob = claimInternalJob(candidate.claimId);
    if (!claimedJob) return null;
    const burst = syntheticBurstFromInternal(claimedJob.id, claimedJob.sender, claimedJob.body, claimedJob.created_at);
    return {
      source: "internal_job",
      sourceGroup: wakeSourceGroupFor("internal_job", burst),
      wakeReason: `job:${claimedJob.id}`,
      priority: wakePriorityFor("internal_job", burst, claimedJob.priority),
      wakeClass: wakeClassFor("internal_job", burst, claimedJob.priority),
      burst,
    };
  }
  if (candidate.source === "alarm") {
    const claimedAlarm = claimAlarm(candidate.claimId);
    if (!claimedAlarm) return null;
    const burst = syntheticBurstFromInternal(
      claimedAlarm.id,
      claimedAlarm.kind,
      `${claimedAlarm.kind}:${claimedAlarm.message}`,
      claimedAlarm.due_at,
    );
    return {
      source: "alarm",
      sourceGroup: wakeSourceGroupFor("alarm", burst),
      wakeReason: `${claimedAlarm.kind}:${claimedAlarm.id}`,
      priority: wakePriorityFor("alarm", burst),
      wakeClass: wakeClassFor("alarm", burst),
      burst,
    };
  }
  if (candidate.source === "local_event") {
    const claimedEvent = claimLocalEvent(candidate.claimId);
    if (!claimedEvent) return null;
    const burst = syntheticBurstFromInternal(claimedEvent.id, claimedEvent.source, claimedEvent.content, claimedEvent.created_at);
    return {
      source: "local_event",
      sourceGroup: wakeSourceGroupFor("local_event", burst),
      wakeReason: `event:${claimedEvent.event_type}:${claimedEvent.id}`,
      priority: wakePriorityFor("local_event", burst),
      wakeClass: wakeClassFor("local_event", burst),
      burst,
    };
  }
  const claimedMailBurst = claimMailBurst(candidate.claimId);
  if (!claimedMailBurst) return null;
  return {
    source: "mail_burst",
    sourceGroup: wakeSourceGroupFor("mail_burst", claimedMailBurst),
    wakeReason: `mail:${claimedMailBurst.primary.layer}:${claimedMailBurst.primary.id}`,
    priority: wakePriorityFor("mail_burst", claimedMailBurst),
    wakeClass: wakeClassFor("mail_burst", claimedMailBurst),
    burst: claimedMailBurst,
  };
}

function completeWake(wake: WakeEvent, errorText?: string | null) {
  const messageId = wake.burst.primary.id;
  if (wake.source === "internal_job") {
    if (errorText) failInternalJob(messageId, errorText);
    else completeInternalJob(messageId);
    return;
  }
  if (wake.source === "alarm") {
    completeAlarm(messageId);
    return;
  }
  if (wake.source === "local_event") {
    completeLocalEvent(messageId, errorText ?? undefined);
    return;
  }
  if (!errorText) completeMailBurst(wake.burst.messages.map((entry) => entry.id));
}

function activeRefractoryDeadline(sourceGroup: WakeSourceGroup, now = Date.now()): number | null {
  const deadline = refractoryCooldowns.get(sourceGroup);
  if (!deadline) return null;
  if (deadline <= now) {
    refractoryCooldowns.delete(sourceGroup);
    return null;
  }
  return deadline;
}

function isRefractoryCoolingDown(sourceGroup: WakeSourceGroup, now = Date.now()): boolean {
  return activeRefractoryDeadline(sourceGroup, now) !== null;
}

function applyRefractoryCooldown(sourceGroup: WakeSourceGroup, now = Date.now()): string {
  const deadline = now + refractoryCooldownMs();
  refractoryCooldowns.set(sourceGroup, deadline);
  return new Date(deadline).toISOString();
}

function nextRefractoryCooldownDelay(now = Date.now()): number | null {
  let nextDeadline: number | null = null;
  for (const sourceGroup of refractoryCooldowns.keys()) {
    const deadline = activeRefractoryDeadline(sourceGroup, now);
    if (deadline === null) continue;
    if (nextDeadline === null || deadline < nextDeadline) {
      nextDeadline = deadline;
    }
  }
  return nextDeadline === null ? null : Math.max(0, nextDeadline - now);
}

function enumerateWakeCandidates(options?: { allowWorkload?: boolean }): { candidates: WakeCandidate[]; bestNonMailPriority: number } {
  const allowWorkload = options?.allowWorkload ?? true;
  const now = Date.now();
  reclaimStaleInternalJobs();
  reclaimStaleMailClaims();
  const queuedJob = peekInternalJob();
  const mailBurst = peekMailBurst();
  const localEvent = peekLocalEvent();
  const alarm = peekAlarm();
  const queuedJobBurst = queuedJob ? syntheticBurstFromInternal(queuedJob.id, queuedJob.sender, queuedJob.body, queuedJob.created_at) : null;
  const localEventBurst = localEvent
    ? syntheticBurstFromInternal(localEvent.id, localEvent.source, localEvent.content, localEvent.created_at)
    : null;
  const alarmBurst = alarm
    ? syntheticBurstFromInternal(alarm.id, alarm.kind, `${alarm.kind}:${alarm.message}`, alarm.due_at)
    : null;
  const jobWakeClass = queuedJobBurst ? wakeClassFor("internal_job", queuedJobBurst, queuedJob.priority) : null;
  const mailWakeClass = mailBurst ? wakeClassFor("mail_burst", mailBurst) : null;
  const localEventWakeClass = localEventBurst ? wakeClassFor("local_event", localEventBurst) : null;
  const alarmWakeClass = alarmBurst ? wakeClassFor("alarm", alarmBurst) : null;
  const jobSourceGroup = queuedJobBurst ? wakeSourceGroupFor("internal_job", queuedJobBurst) : null;
  const mailSourceGroup = mailBurst ? wakeSourceGroupFor("mail_burst", mailBurst) : null;
  const localEventSourceGroup = localEventBurst ? wakeSourceGroupFor("local_event", localEventBurst) : null;
  const alarmSourceGroup = alarmBurst ? wakeSourceGroupFor("alarm", alarmBurst) : null;
  const eligibleJobBurst = queuedJobBurst
    && (allowWorkload || jobWakeClass === "hot")
    && (jobWakeClass === "hot" || !isRefractoryCoolingDown(jobSourceGroup!, now))
      ? queuedJobBurst
      : null;
  const eligibleMailBurst = mailBurst
    && (allowWorkload || mailWakeClass === "hot")
    && (mailWakeClass === "hot" || !isRefractoryCoolingDown(mailSourceGroup!, now))
      ? mailBurst
      : null;
  const eligibleLocalEventBurst = localEventBurst
    && (allowWorkload || localEventWakeClass === "hot")
    && (localEventWakeClass === "hot" || !isRefractoryCoolingDown(localEventSourceGroup!, now))
      ? localEventBurst
      : null;
  const eligibleAlarmBurst = alarmBurst
    && (allowWorkload || alarmWakeClass === "hot")
    && (alarmWakeClass === "hot" || !isRefractoryCoolingDown(alarmSourceGroup!, now))
      ? alarmBurst
      : null;
  const mailPriority = eligibleMailBurst ? wakePriorityFor("mail_burst", eligibleMailBurst) : -1;
  const jobPriority = eligibleJobBurst && queuedJob ? wakePriorityFor("internal_job", eligibleJobBurst, queuedJob.priority) : -1;
  const localEventPriority = eligibleLocalEventBurst ? wakePriorityFor("local_event", eligibleLocalEventBurst) : -1;
  const alarmPriority = eligibleAlarmBurst ? wakePriorityFor("alarm", eligibleAlarmBurst) : -1;
  const candidates: WakeCandidate[] = [];

  if (queuedJob && eligibleJobBurst) {
    candidates.push({
      source: "internal_job",
      sourceGroup: jobSourceGroup!,
      wakeReason: `job:${queuedJob.id}`,
      priority: jobPriority,
      wakeClass: wakeClassFor("internal_job", eligibleJobBurst, queuedJob.priority),
      burst: eligibleJobBurst,
      claimId: queuedJob.id,
      sourceLabel: queuedJob.sender,
    });
  }
  if (alarm && eligibleAlarmBurst) {
    candidates.push({
      source: "alarm",
      sourceGroup: alarmSourceGroup!,
      wakeReason: `${alarm.kind}:${alarm.id}`,
      priority: alarmPriority,
      wakeClass: wakeClassFor("alarm", eligibleAlarmBurst),
      burst: eligibleAlarmBurst,
      claimId: alarm.id,
      sourceLabel: alarm.kind,
    });
  }
  if (localEvent && eligibleLocalEventBurst) {
    candidates.push({
      source: "local_event",
      sourceGroup: localEventSourceGroup!,
      wakeReason: `event:${localEvent.event_type}:${localEvent.id}`,
      priority: localEventPriority,
      wakeClass: wakeClassFor("local_event", eligibleLocalEventBurst),
      burst: eligibleLocalEventBurst,
      claimId: localEvent.id,
      sourceLabel: localEvent.event_type,
    });
  }
  if (eligibleMailBurst) {
    candidates.push({
      source: "mail_burst",
      sourceGroup: mailSourceGroup!,
      wakeReason: `mail:${eligibleMailBurst.primary.layer}:${eligibleMailBurst.primary.id}`,
      priority: mailPriority,
      wakeClass: wakeClassFor("mail_burst", eligibleMailBurst),
      burst: eligibleMailBurst,
      claimId: eligibleMailBurst.primary.id,
      sourceLabel: eligibleMailBurst.primary.layer,
    });
  }

  return { candidates, bestNonMailPriority: Math.max(jobPriority, localEventPriority, alarmPriority) };
}

async function selectNextWake(options?: { allowWorkload?: boolean; blockingMail?: boolean }): Promise<WakeEvent | null> {
  const blockingMail = options?.blockingMail ?? true;
  const now = Date.now();
  const { candidates, bestNonMailPriority } = enumerateWakeCandidates(options);

  if (candidates.length > 0) {
    let remaining = [...candidates];
    while (remaining.length > 0) {
      const preferred = remaining.length === 1
        ? remaining[0]
        : (await requestInferenceWakeChoice(remaining)) ?? deterministicWakeChoice(remaining);
      if (!preferred) break;
      const claimed = claimWakeCandidate(preferred);
      if (claimed) return claimed;
      remaining = remaining.filter((candidate) => candidate.source !== preferred.source || candidate.claimId !== preferred.claimId);
    }
    return null;
  }

  if (!blockingMail) return null;

  if (bestNonMailPriority >= 0) return null;

  const refractoryDelayMs = nextRefractoryCooldownDelay(now);
  if (refractoryDelayMs !== null && refractoryDelayMs > 0) {
    const cooldownUntil = new Date(now + refractoryDelayMs).toISOString();
    setRuntimeState("cooldown", "refractory_window", "scheduler", null, cooldownUntil);
    await new Promise((resolve) => setTimeout(resolve, Math.min(refractoryDelayMs, 1000)));
    return null;
  }

  setRuntimeState("idle", "awaiting_message", "mail_listen");
  const blockingMailBurst = await waitForMailBurst();
  if (!blockingMailBurst) return null;
  const blockingWakeClass = wakeClassFor("mail_burst", blockingMailBurst);
  const blockingSourceGroup = wakeSourceGroupFor("mail_burst", blockingMailBurst);
  if (blockingWakeClass !== "hot" && isRefractoryCoolingDown(blockingSourceGroup)) {
    return null;
  }

  return {
    source: "mail_burst",
    sourceGroup: blockingSourceGroup,
    wakeReason: `mail:${blockingMailBurst.primary.layer}:${blockingMailBurst.primary.id}`,
    priority: wakePriorityFor("mail_burst", blockingMailBurst),
    wakeClass: blockingWakeClass,
    burst: blockingMailBurst,
  };
}

async function assembleTurnContext(agentName: string, burst: IncomingBurst, wakeSource: WakeSource): Promise<TurnAssembly> {
  const now = Date.now();
  const lastActionRec = runMemoryQuery("SELECT timestamp FROM tier1_working WHERE agent_name = ? ORDER BY id DESC LIMIT 1", agentName)[0];
  const lastAction = lastActionRec ? new Date(lastActionRec.timestamp + "Z").getTime() : (now - 3600000);
  const sleepDeltaSeconds = Math.floor((now - lastAction) / 1000);
  const workingLog = runMemoryQuery("SELECT role, content FROM tier1_working WHERE agent_name = ? ORDER BY id DESC LIMIT 5", agentName).reverse();
  const inboundBurstText = burst.messages
    .map((entry) => {
      const ts = entry.created_at.endsWith("Z") ? entry.created_at : `${entry.created_at}Z`;
      return `- [${new Date(ts).toISOString()}] ${entry.sender} (${entry.layer}): ${entry.body}`;
    })
    .join("\n");
  const retrievalQuery = burst.messages
    .map((entry) => `${entry.sender} ${entry.layer} ${entry.body}`)
    .join("\n")
    .slice(0, 2400);
  const retrievalMode = await chooseRetrievalModeWithInference(wakeSource, burst);
  const preparedMemory = lookupPreparedMemory(agentName, retrievalQuery, retrievalMode);
  if (!preparedMemory || preparedMemory.freshness?.stale || preparedMemory.freshness?.last_status === "error") {
    refreshMemoryAsync(agentName);
  }
  const recentDigests = preparedMemory?.recentDigests?.length
    ? preparedMemory.recentDigests
    : runMemoryQuery("SELECT summary FROM public_digests WHERE timestamp > datetime(?, 'unixepoch') ORDER BY id DESC LIMIT 3", Math.floor(lastAction / 1000).toString());
  const episodic = preparedMemory?.episodic?.length
    ? preparedMemory.episodic
    : runMemoryQuery("SELECT summary FROM tier2_episodic WHERE agent_name = ? ORDER BY id DESC LIMIT 3", agentName);
  const archival = preparedMemory?.archival?.length
    ? preparedMemory.archival
    : runMemoryQuery("SELECT reflection FROM tier3_archival WHERE agent_name = ? ORDER BY id DESC LIMIT 3", agentName);
  const currentFacts = preparedMemory?.currentFacts?.length
    ? preparedMemory.currentFacts
    : [];
  const recentInvalidations = preparedMemory?.recentInvalidations?.length
    ? preparedMemory.recentInvalidations
    : [];
  const linkedArchival = preparedMemory?.linkedArchival?.length
    ? preparedMemory.linkedArchival
    : [];
  const timelineEvents = timelinePreparedMemory(agentName, retrievalQuery);
  const retrievalTraces = preparedMemory?.traces?.length
    ? preparedMemory.traces
    : [];
  const recalledArtifactIds = [...recentDigests, ...episodic, ...archival, ...currentFacts, ...linkedArchival, ...timelineEvents.map((event) => ({ id: event.from.id })), ...timelineEvents.map((event) => ({ id: event.to.id }))]
    .map((row: any) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const scratchpad = readScratchpad(agentName);
  const ghost = readGhostedTurn();

  return {
    inboundBurstText,
    orientationAlert: ghost ? formatGhostOrientation(ghost) : null,
    sleepDeltaSeconds,
    recentDigests,
    episodic,
    archival,
    currentFacts,
    recentInvalidations,
    linkedArchival,
    timelineEvents,
    retrievalTraces,
    workingLog,
    memorySelection: preparedMemory?.memorySelection ?? `memory artifacts unavailable: deterministic recency fallback (${retrievalMode})`,
    recalledArtifactIds,
    scratchpad,
    scratchpadStatus: scratchpadStatus(scratchpad),
  };
}

// System prompt assembly — reads base + per-agent overlay from prompts/
const promptsDir = join(process.cwd(), "prompts");

function readPromptFile(filename: string): string {
  try {
    return readFileSync(join(promptsDir, filename), "utf-8").trim();
  } catch {
    return "";
  }
}

// Cache prompt files (they don't change during runtime)
let cachedBaseSystem: string | null = null;
let cachedAgentOverlay: string | null = null;

function renderSystemPrompt(agentName: string, burst: IncomingBurst): string {
  if (cachedBaseSystem === null) {
    const raw = readPromptFile("base-system.md");
    // Template substitution
    cachedBaseSystem = raw
      .replace(/\{\{\s*agent_name\s*\}\}/g, agentName)
      .replace(/\{\{\s*output_budget\s*\}\}/g, String(OUTPUT_BUDGET_CHARS))
      .replace(/\{\{\s*machete_limit\s*\}\}/g, String(MACHETE_LIMIT));
  }
  if (cachedAgentOverlay === null) {
    cachedAgentOverlay = readPromptFile(`${agentName}-system.md`);
  }

  const parts = [cachedBaseSystem];
  if (cachedAgentOverlay) parts.push(cachedAgentOverlay);
  return parts.join("\n\n---\n\n");
}

function renderTurnPrompt(agentName: string, burst: IncomingBurst, turn: TurnAssembly): string {
  const msg = burst.primary;

  // TDD-inspired shorthand: § section, ∂ delta, τ type, ε error, → target, ↑ escalate
  // Section budgets: P1 (burst, envelope) uncapped; P2 (archival, working) capped; P3 (episodic, digest) capped
  const archivalLines = budgetSection(
    turn.archival.map((a) => `- ${a.reflection}`),
    BUDGET_ARCHIVAL_CHARS,
  );
  const linkedArchivalLines = budgetSection(
    turn.linkedArchival.map((row) => `- [${row.relation} w=${row.weight.toFixed(2)}] ${row.reflection}`),
    BUDGET_LINKED_ARCHIVAL_CHARS,
  );
  const factLines = budgetSection(
    turn.currentFacts.map((fact) => `- ${fact.subject} ${fact.predicate} ${fact.object}${fact.valid_from ? ` @ ${fact.valid_from}` : ""}`),
    BUDGET_FACTS_CHARS,
  );
  const invalidatedLines = budgetSection(
    turn.recentInvalidations.map((entry) => entry.kind === "fact"
      ? `- [ended ${entry.valid_to ?? "?"}] ${entry.subject} ${entry.predicate} ${entry.object}`
      : `- [ended ${entry.valid_to ?? "?"}] ${entry.relation}: ${entry.from_content} -> ${entry.to_content}`),
    BUDGET_INVALIDATED_CHARS,
  );
  const episodicLines = budgetSection(
    turn.episodic.map((row) => `- ${row.summary}`),
    BUDGET_EPISODIC_CHARS,
  );
  const timelineLines = budgetSection(
    turn.timelineEvents.map((event) => {
      const validity = event.valid_to ? `${event.valid_from ?? "?"}..${event.valid_to}` : `${event.valid_from ?? "?"}..now`;
      return `- [${event.relation} w=${event.weight.toFixed(2)} ${validity}] ${event.from.kind}:${event.from.content} -> ${event.to.kind}:${event.to.content}`;
    }),
    BUDGET_TIMELINE_CHARS,
  );
  const digestLines = budgetSection(
    turn.recentDigests.map((d) => `- ${d.summary}`),
    BUDGET_DIGEST_CHARS,
  );
  const workingLines = budgetSection(
    turn.workingLog.map((l) => `${l.role}: ${l.content}`),
    BUDGET_WORKING_CHARS,
  );
  const traceTable = toToonTable(
    turn.retrievalTraces.slice(0, 8).map((row) => ({
      id: String(row.id ?? ""),
      rk: row.record_kind,
      sk: row.source_kind,
      sc: row.score.toFixed(3),
      lx: row.lexical_score.toFixed(3),
      lk: row.link_boost.toFixed(3),
    })),
    ["id", "rk", "sk", "sc", "lx", "lk"],
  );
  const traceLines = budgetSection(traceTable ? traceTable.split("\n") : [], BUDGET_TRACE_CHARS);

  return `§TURN agent=${agentName}
${turn.orientationAlert ? `${turn.orientationAlert}\n` : ""}§LTM
${archivalLines.length ? archivalLines.join("\n") : "- (none)"}
§FACTS
${factLines.length ? factLines.join("\n") : "- (none)"}
§INVALIDATED
${invalidatedLines.length ? invalidatedLines.join("\n") : "- (none)"}
§LTM-LINKS
${linkedArchivalLines.length ? linkedArchivalLines.join("\n") : "- (none)"}
§CTX ∂sleep=${turn.sleepDeltaSeconds}s claimed=${burst.mergedCount} queued=${burst.remainingUnread} mem=${turn.memorySelection}
§DIGEST
${digestLines.length ? digestLines.join("\n") : "- (none)"}
§EPISODIC
${episodicLines.length ? episodicLines.join("\n") : "- (none)"}
§TIMELINE
${timelineLines.length ? timelineLines.join("\n") : "- (none)"}
§TRACE
${traceLines.length ? traceLines.join("\n") : "- (none)"}
§WM
${workingLines.length ? workingLines.join("\n") : "- (start)"}
§SCRATCHPAD ${turn.scratchpadStatus.chars}/${turn.scratchpadStatus.cap}${turn.scratchpadStatus.warning ? ` ⚠ ${turn.scratchpadStatus.warning}` : ""}
${turn.scratchpad ? budgetSection(turn.scratchpad.split("\n"), BUDGET_SCRATCHPAD_CHARS).join("\n") : "- (empty)"}
§REMINDER budget=${OUTPUT_BUDGET_CHARS} reply→${msg.layer}→${msg.sender} JSON only
§BURST
${turn.inboundBurstText}
`;
}

type AcpResponse = { result?: any; error?: any };

function acpErrorText(error: any): string {
  if (!error) return "Unknown ACP error";
  if (typeof error === "string") return error;

  const message = typeof error.message === "string" ? error.message : "";
  const data = error.data === undefined ? "" : ` ${JSON.stringify(error.data)}`;
  return `${message}${data}`.trim() || JSON.stringify(error);
}

// ACP Client state
let acpRequestCounter = 1;
const acpPendingRequests = new Map<number, (res: AcpResponse) => void>();

function resolvePendingAcpError(message: string) {
  for (const [, resolve] of acpPendingRequests.entries()) {
    resolve({ error: { message } });
  }
  acpPendingRequests.clear();
}

async function acpCall(agentStdin: any, method: string, params: any): Promise<AcpResponse> {
  const id = acpRequestCounter++;
  const req = { jsonrpc: "2.0", id, method, params };
  agentStdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => {
    acpPendingRequests.set(id, resolve);
  });
}

async function processWakeEvent(
  wake: WakeEvent,
  options?: {
    successStatus?: "idle" | "cooldown";
    successCurrentTask?: string;
    successWakeReason?: string;
    successCooldownUntil?: string | null;
  },
) {
  const burst = wake.burst;
  const msg = burst.primary;
  if (isMaintenanceJob(msg)) {
    const maintenanceTask = msg.body.replace(/^__maintenance__:/, "");
    recordMaintenanceOutcome(name, maintenanceTask, "started", `job:${msg.id}`);
    const result = runMaintenanceJob(name, msg.body);
    if (result.ok) {
      recordWorking("system", `Maintenance completed: ${result.detail}`);
      recordMaintenanceOutcome(name, maintenanceTask, "completed", result.detail);
      completeInternalJob(msg.id);
    } else {
      recordWorking("system", `Maintenance failed: ${result.detail}`);
      recordMaintenanceOutcome(name, maintenanceTask, "failed", result.detail);
      failInternalJob(msg.id, result.detail);
    }
    return;
  }
  // Re-run jobs force full profile — complete this job and override the execution profile
  if (isRerunJob(msg)) {
    const rerunInfo = parseRerunJob(msg.body);
    if (rerunInfo) {
      recordWorking("system", `Processing re-run job as full profile: original ${rerunInfo.source}:${rerunInfo.messageId}`);
    }
    completeInternalJob(msg.id);
    // Override the wake to force full profile — fall through to normal ACP turn below
    // The re-run uses the same burst text, but chooseTurnExecutionProfile will be overridden
  }
  const forceFullProfile = isRerunJob(msg);
  const turnKey = `${wake.source}:${msg.id}:${Date.now()}`;
  const currentTask = wake.source === "mail_burst" ? `message:${msg.id}` : `${wake.source}:${msg.id}`;
  let checkpointPromptHash: string | null = null;
  let checkpointPromptChars = 0;
  const bufferedActionRecords: BufferedActionRecord[] = [];
  const bufferedTurnPhases: BufferedTurnPhaseRecord[] = [];
  const bufferedTurnCheckpoints: BufferedTurnCheckpointRecord[] = [];
  const recordBufferedTurnPhase = (phase: TurnPhase, detail: string | null = null) => {
    bufferedTurnPhases.push({
      turn_key: turnKey,
      wake_source: wake.source,
      wake_reason: wake.wakeReason,
      message_id: msg.id,
      phase,
      detail,
    });
  };
  const recordBufferedTurnCheckpoint = (checkpoint: Omit<TurnCheckpoint, "agent_name">) => {
    bufferedTurnCheckpoints.push(checkpoint);
  };
  const recordBufferedAction = (actionType: string, actionIndex: number, phase: string, detail: string | null = null, messageId: number | null = null) => {
    const replayPolicy = replayPolicyForAction(actionType);
    bufferedActionRecords.push({
      action_type: actionType,
      action_index: actionIndex,
      phase,
      detail,
      message_id: messageId,
      replay_disposition: replayPolicy.disposition,
      replay_reason: replayPolicy.reason,
    });
  };
  recordBufferedTurnPhase("started", currentTask);
  flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
  setRuntimeState("thinking", currentTask, wake.wakeReason, null, null, String(msg.id));
    recordWorking("system", `Wake selected: ${wake.source} (${wake.wakeReason}, group=${wake.sourceGroup}, priority=${wake.priority}, class=${wake.wakeClass})`);
  try {
    const turn = await assembleTurnContext(name, burst, wake.source);
    const executionProfile = forceFullProfile
      ? { profile: "full" as TurnProfile, ...turnProfileConfig("full"), source: "rerun" as const, reason: "forced full re-run after light turn escalation" }
      : await chooseTurnExecutionProfile(wake.source, burst);
    recordWorking("system", `Turn profile: ${executionProfile.profile} source=${executionProfile.source} model=${executionProfile.model ?? "default"} effort=${executionProfile.reasoning_effort ?? "default"} timeout=${executionProfile.timeout_ms}ms`);
    reinforceMemoryAsync(name, turn.recalledArtifactIds);
    const promptText = renderTurnPrompt(name, burst, turn);
    checkpointPromptHash = promptHash(promptText);
    checkpointPromptChars = promptText.length;
    recordBufferedTurnCheckpoint({
      turn_key: turnKey,
      wake_source: wake.source,
      wake_reason: wake.wakeReason,
      wake_class: wake.wakeClass,
      wake_priority: wake.priority,
      message_id: msg.id,
      sender: msg.sender,
      layer: msg.layer,
      burst_count: burst.mergedCount,
      prompt_hash: checkpointPromptHash,
      prompt_chars: checkpointPromptChars,
      envelope_status: "prompt_built",
      envelope_summary: null,
    });
    flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
    runMemoryInsert(
      "INSERT INTO tier1_working (agent_name, role, content) VALUES (?, 'user', ?)",
      name,
      `Inbound burst from ${msg.sender} on ${msg.layer}: ${burst.messages.map((entry) => entry.body).join(" | ")}`,
    );
    appendMemorySourceArtifact("working", name!, {
      record_type: "tier1_working",
      agent_name: name,
      role: "user",
      content: `Inbound burst from ${msg.sender} on ${msg.layer}: ${burst.messages.map((entry) => entry.body).join(" | ")}`,
    });
    runMemoryInsert(
      "INSERT INTO tier2_episodic (agent_name, summary, duration_asleep, actors) VALUES (?, ?, ?, ?)",
      name,
      summarizeIncomingBurst(burst),
      String(Math.max(0, Math.floor((Date.now() - (new Date(msg.created_at.endsWith("Z") ? msg.created_at : `${msg.created_at}Z`).getTime())) / 1000))),
      [...new Set(burst.messages.map((entry) => entry.sender))].join(", "),
    );
    appendMemorySourceArtifact("episodic", name!, {
      record_type: "tier2_episodic",
      agent_name: name,
      summary: summarizeIncomingBurst(burst),
      duration_asleep: Math.max(0, Math.floor((Date.now() - (new Date(msg.created_at.endsWith("Z") ? msg.created_at : `${msg.created_at}Z`).getTime())) / 1000)),
      actors: [...new Set(burst.messages.map((entry) => entry.sender))].join(", "),
    });
    refreshMemoryAsync(name);

    let responseText = "";
    let diagnosticBuffer = "";
    let liveLimitState: LimitState = "none";
    let liveLimitInfo = "";

    if (promptMode === "provider") {
      // --- Provider socket mode: single turn request ---
      const turnModel = executionProfile.model ?? providerModel;
      if (!turnModel) {
      diagnosticBuffer += "No model specified (INFERENCE_CLOUD_MODEL or execution profile model required)\n";
      }
      const turnResponse = await requestProviderTurnWithFailover(
        executionProfile.profile,
        providerSocket,
        turnModel,
        renderSystemPrompt(name, burst),
        promptText,
        parseInt(process.env.FLEET_OUTPUT_BUDGET || "8192", 10),
        executionProfile.profile === "light" ? 0.3 : 1.0,
        executionProfile.timeout_ms,
      );
      responseText = turnResponse.content;
      if (turnResponse.error) {
        diagnosticBuffer += `Provider error: ${turnResponse.error}\n`;
      }
      if (turnResponse.stop_reason === "rate_limited") {
        liveLimitState = "quota_exhausted";
        liveLimitInfo = turnResponse.error ?? "rate limited";
      }
      if (turnResponse.usage) {
        recordWorking("system", `Token usage: input=${turnResponse.usage.input_tokens} output=${turnResponse.usage.output_tokens} model=${turnResponse.model} source=${turnResponse.source}`);
      }
      console.log(responseText);
    } else {
      // --- Legacy ACP subprocess mode ---
      const agent = spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FLEET_REPLY_TO: msg.sender,
          FLEET_REPLY_LAYER: msg.layer,
        },
      });

      let deadmanTriggered = false;
      let deadmanReason = "";
      let liveLimitTriggered = false;

      let resolveLimitSignal: ((value: { state: LimitState; info: string }) => void) | null = null;
      const limitSignal = new Promise<{ state: LimitState; info: string }>((resolve) => {
        resolveLimitSignal = resolve;
      });

      const deadmanTimer = setTimeout(() => {
        deadmanTriggered = true;
        deadmanReason = `turn timed out after ${executionProfile.timeout_ms}ms`;
        diagnosticBuffer += `[DEADMAN] ${deadmanReason}\n`;
        resolvePendingAcpError(deadmanReason);
        try { agent.kill(); } catch {}
      }, executionProfile.timeout_ms);

      const triggerLiveLimit = () => {
        if (liveLimitTriggered) return;
        const state = classifyLimitState(diagnosticBuffer, 1);
        if (state !== "quota_exhausted" && state !== "transient_capacity") return;
        liveLimitTriggered = true;
        liveLimitState = state;
        liveLimitInfo = extractLimitInfo(diagnosticBuffer);
        resolveLimitSignal?.({ state: liveLimitState, info: liveLimitInfo });
        try { agent.kill(); } catch {}
      };

      const stdoutReader = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of agent.stdout) {
          buffer += decoder.decode(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const resJson = JSON.parse(line);
              if (resJson.id !== undefined) {
                const resolver = acpPendingRequests.get(resJson.id);
                if (resolver) {
                  acpPendingRequests.delete(resJson.id);
                  resolver({ result: resJson.result, error: resJson.error });
                }
              } else if (resJson.method === "session/update") {
                const update = resJson.params.update;
                if (update.sessionUpdate === "agent_message_chunk") {
                  const chunk = update.content.text;
                  process.stdout.write(chunk);
                  responseText += chunk;
                }
              }
            } catch {
              process.stdout.write(line + "\n");
              diagnosticBuffer += line + "\n";
              triggerLiveLimit();
            }
          }
        }
      })();

      const stderrReader = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of agent.stderr) {
          const text = decoder.decode(chunk);
          process.stdout.write(text);
          diagnosticBuffer += text;
          triggerLiveLimit();
        }
      })();

      const initRes = await acpCall(agent.stdin, "initialize", {
        protocolVersion: 1,
        clientInfo: { name: "agent-runtime", version: "1.0" },
        clientCapabilities: {}
      });
      if (initRes.error) diagnosticBuffer += acpErrorText(initRes.error) + "\n";

      const sessionRes = await acpCall(agent.stdin, "session/new", {
        cwd: process.cwd(),
        mcpServers: [],
        model: executionProfile.model ?? undefined,
        reasoningEffort: executionProfile.reasoning_effort ?? undefined,
        metadata: {
          fleet_profile: executionProfile.profile,
          fleet_profile_source: executionProfile.source,
          fleet_profile_reason: executionProfile.reason,
        }
      });
      if (sessionRes.error) diagnosticBuffer += acpErrorText(sessionRes.error) + "\n";
      triggerLiveLimit();
      const sessionId = sessionRes.result?.sessionId;

      let promptRes: AcpResponse | null = null;
      if (sessionId) {
        const promptOutcome = await Promise.race([
          acpCall(agent.stdin, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: promptText }]
          }).then((response) => ({ type: "response" as const, response })),
          limitSignal.then((limit) => ({ type: "limit" as const, limit })),
        ]);

        if (promptOutcome.type === "response") {
          promptRes = promptOutcome.response;
          if (promptRes.error) diagnosticBuffer += acpErrorText(promptRes.error) + "\n";
          triggerLiveLimit();
        } else {
          liveLimitState = promptOutcome.limit.state;
          liveLimitInfo = promptOutcome.limit.info;
        }
      } else {
        diagnosticBuffer += "ACP session/new did not return a sessionId.\n";
      }

      try { agent.kill(); } catch {}
      const exitCode = await agent.exited;
      await Promise.all([stdoutReader, stderrReader]);
      clearTimeout(deadmanTimer);

      const acpLimitState = liveLimitState !== "none" ? liveLimitState : classifyLimitState(diagnosticBuffer, exitCode);
      if (acpLimitState === "quota_exhausted" || acpLimitState === "transient_capacity") {
        liveLimitState = acpLimitState;
      }
    }

    const isLimited = liveLimitState === "quota_exhausted" || liveLimitState === "transient_capacity";

  // --- Machete: hard truncation before envelope parsing ---
    const macheted = applyMachete(responseText);
    if (macheted.truncated) {
    recordWorking("system", `Output machete fired: response truncated from ${responseText.length} to ${MACHETE_LIMIT} chars`);
    console.log(`[MACHETE] ${name} output truncated: ${responseText.length} → ${MACHETE_LIMIT} chars`);
    }
    const safeResponseText = macheted.text;

    const parsedEnvelope = !isLimited ? parseActionEnvelope(safeResponseText) : null;
    const envelopeResult = !isLimited ? validateEnvelope(parsedEnvelope) : null;
    const envelope = envelopeResult?.ok ? envelopeResult.envelope : null;

    if (isLimited) {
      recordBufferedTurnCheckpoint({
        turn_key: turnKey,
        wake_source: wake.source,
        wake_reason: wake.wakeReason,
        wake_class: wake.wakeClass,
        wake_priority: wake.priority,
        message_id: msg.id,
        sender: msg.sender,
        layer: msg.layer,
        burst_count: burst.mergedCount,
        prompt_hash: checkpointPromptHash,
        prompt_chars: checkpointPromptChars,
        envelope_status: "rate_limited",
        envelope_summary: null,
      });
    } else if (!parsedEnvelope) {
      recordBufferedTurnCheckpoint({
        turn_key: turnKey,
        wake_source: wake.source,
        wake_reason: wake.wakeReason,
        wake_class: wake.wakeClass,
        wake_priority: wake.priority,
        message_id: msg.id,
        sender: msg.sender,
        layer: msg.layer,
        burst_count: burst.mergedCount,
        prompt_hash: checkpointPromptHash,
        prompt_chars: checkpointPromptChars,
        envelope_status: "parse_failed",
        envelope_summary: null,
      });
    } else if (envelopeResult?.ok === false) {
      recordBufferedTurnCheckpoint({
        turn_key: turnKey,
        wake_source: wake.source,
        wake_reason: wake.wakeReason,
        wake_class: wake.wakeClass,
        wake_priority: wake.priority,
        message_id: msg.id,
        sender: msg.sender,
        layer: msg.layer,
        burst_count: burst.mergedCount,
        prompt_hash: checkpointPromptHash,
        prompt_chars: checkpointPromptChars,
        envelope_status: "validation_failed",
        envelope_summary: null,
      });
    } else if (envelope) {
      recordBufferedTurnCheckpoint({
        turn_key: turnKey,
        wake_source: wake.source,
        wake_reason: wake.wakeReason,
        wake_class: wake.wakeClass,
        wake_priority: wake.priority,
        message_id: msg.id,
        sender: msg.sender,
        layer: msg.layer,
        burst_count: burst.mergedCount,
        prompt_hash: checkpointPromptHash,
        prompt_chars: checkpointPromptChars,
        envelope_status: "validated",
        envelope_summary: envelope.summary ?? null,
      });
    }
    flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);

    if (safeResponseText.trim() && !isLimited) {
    recordWorking("assistant", safeResponseText.trim());
    runMemoryInsert(
      "INSERT INTO tier3_archival (agent_name, task_id, result, reflection) VALUES (?, ?, ?, ?)",
      name,
      `msg-${msg.id}`,
      safeResponseText.trim().slice(0, 4000),
      `Responded to ${burst.mergedCount} queued message(s) on ${msg.layer} from ${msg.sender}.`,
    );
    appendMemorySourceArtifact("archival", name!, {
      record_type: "tier3_archival",
      agent_name: name,
      task_id: `msg-${msg.id}`,
      result: safeResponseText.trim().slice(0, 4000),
      reflection: `Responded to ${burst.mergedCount} queued message(s) on ${msg.layer} from ${msg.sender}.`,
    });
    refreshMemoryAsync(name);
    }

    if (isLimited) {
    const limitInfo = liveLimitInfo || extractLimitInfo(diagnosticBuffer);
    const limitWindow = getLimitWindow(limitInfo, limitState);
    const statusText = limitState === "quota_exhausted" ? "quota-exhausted" : "temporarily capacity-limited";
    const replyBody = `[SYSTEM MESSAGE]: The agent '${name}' is currently ${statusText} and will hibernate until ${limitWindow.availableAt}. Limit info: ${limitWindow.info}`;
    if (msg.layer !== "internal") {
      sendMessage(msg.sender, msg.layer, replyBody);
    } else {
      rescheduleInternalJob(msg.id, limitWindow.availableAt, limitWindow.info);
    }
    const cooldown = forceGovernor(Math.max(1, Math.ceil(limitWindow.sleepMs / 1000)), `${limitState}:${wake.sourceGroup}`);
    const hibernateUntil = cooldown?.forced_cooldown_until ?? limitWindow.availableAt;
    recordWorking(
      "system",
      `Provider limit detected (${limitState}). Hibernating until ${hibernateUntil}. Parsed=${limitWindow.extracted ? "yes" : "fallback"}. ${limitWindow.info}`,
    );
      recordBufferedTurnPhase("rate_limited", limitWindow.info);
      flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
      setRuntimeState("rate_limited", currentTask, limitState, limitWindow.info, hibernateUntil, String(msg.id));
    console.log(`--- ${name} hibernating until ${hibernateUntil} (${Math.round(limitWindow.sleepMs / 60000)} minutes) ---`);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, limitWindow.sleepMs)));
      return;
    }

    if (envelope?.state?.current_task) {
      setRuntimeState("thinking", envelope.state.current_task, wake.wakeReason, null, null, String(msg.id));
    }
  // TOON-style operator display for action summary
    if (envelope && envelope.actions.length > 0) {
    const actionRows = envelope.actions.map((a, i) => ({
      n: String(i + 1),
      τ: a.type,
      detail: a.type === "reply" ? (a as ReplyAction).message.trim().slice(0, 120)
        : a.type === "note" ? (a as NoteAction).message.trim().slice(0, 120)
        : a.type === "sleep_until" ? (a as SleepUntilAction).until
        : a.type === "queue_task" ? `${(a as QueueTaskAction).target_agent ?? name}:${(a as QueueTaskAction).task.slice(0, 80)}`
        : a.type === "escalate" ? (a as EscalateAction).message.slice(0, 120)
        : a.type === "scratchpad" ? `${(a as ScratchpadAction).op}${(a as ScratchpadAction).content ? `: ${(a as ScratchpadAction).content!.slice(0, 80)}` : ""}`
        : "",
    }));
    console.log(`[${name}] ${envelope.summary ?? ""}${macheted.truncated ? " [MACHETED]" : ""}`);
    console.log(toToonTable(actionRows, ["n", "τ", "detail"]));
    }

    if (envelope) {
    for (const [actionIndex, action] of envelope.actions.entries()) {
      const oneBasedIndex = actionIndex + 1;
      const actionDetail =
        action.type === "reply" ? action.message.trim()
        : action.type === "note" ? action.message.trim()
        : action.type === "sleep_until" ? action.until
        : action.type === "queue_task" ? action.task
        : action.type === "escalate" ? action.message
        : action.type === "scratchpad" ? `${action.op}${action.content ? `: ${action.content.slice(0, 80)}` : ""}`
        : action.type === "spawn_scribe" ? `${action.name}: ${action.task.slice(0, 80)}`
        : null;
      recordBufferedAction(action.type, oneBasedIndex, "planned", actionDetail, msg.id);
      try {
        recordBufferedAction(action.type, oneBasedIndex, "started", actionDetail, msg.id);
        if (action.type === "reply") {
          if (msg.layer !== "internal") {
            sendMessage(msg.sender, msg.layer, action.message.trim());
            recordWorking("system", `Executed action: reply to ${msg.sender} on ${msg.layer}`);
          } else {
            recordWorking("system", `Skipped external reply for internal wake: ${action.message.trim()}`);
          }
        } else if (action.type === "note") {
          recordWorking("system", `Action note: ${action.message.trim()}`);
        } else if (action.type === "sleep_until") {
          setRuntimeState("sleeping", envelope.state?.current_task ?? currentTask, "sleep_until", null, action.until, String(msg.id));
          recordWorking("system", `Executed action: sleep_until ${action.until}`);
          await sleepUntil(action.until);
        } else if (action.type === "queue_task") {
          const targetAgent = action.target_agent || name!;
          const queued = queueInternalJob(action.task, targetAgent, action.priority ?? "normal", action.run_at ?? null);
          recordWorking("system", `Executed action: queue_task for ${targetAgent}${queued ? ` as job ${queued.id}` : ""} (${action.priority ?? "normal"})`);
        } else if (action.type === "escalate") {
          const escalationLayer = action.channel ?? "private";
          sendMessage("operator", escalationLayer, `[ESCALATION from ${name}]: ${action.message}`);
          recordWorking("system", `Executed action: escalate to operator on ${escalationLayer}`);
        } else if (action.type === "scratchpad") {
          const current = readScratchpad(name);
          if (action.op === "clear") {
            writeScratchpad(name, "");
            recordWorking("system", `Executed action: scratchpad clear (was ${current.length} chars)`);
          } else if (action.op === "replace") {
            writeScratchpad(name, action.content ?? "");
            recordWorking("system", `Executed action: scratchpad replace (${(action.content ?? "").length} chars)`);
          } else {
            writeScratchpad(name, current + (current && !current.endsWith("\n") ? "\n" : "") + (action.content ?? ""));
            recordWorking("system", `Executed action: scratchpad append (+${(action.content ?? "").length} chars, now ${readScratchpad(name).length}/${SCRATCHPAD_CAP})`);
          }
        } else if (action.type === "spawn_scribe") {
          const scribeResult = await requestScribe(action.name, action.task);
          if (scribeResult) {
            sendMessage(name!, "private", `[scribe:${action.name}] ${scribeResult}`);
            recordWorking("system", `Executed action: spawn_scribe ${action.name} — result delivered to agent-mail`);
          } else {
            recordWorking("system", `Executed action: spawn_scribe ${action.name} — inference failed or timed out`);
          }
        } else {
          recordWorking("system", "Executed action: noop");
        }
        recordBufferedAction(action.type, oneBasedIndex, "completed", actionDetail, msg.id);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        recordBufferedAction(action.type, oneBasedIndex, "failed", errorText, msg.id);
        throw error;
      }
    }
    }

    // Check for provider-level errors in diagnosticBuffer (covers both modes)
    const hasProviderError = diagnosticBuffer.includes("Provider error:") || diagnosticBuffer.includes("[DEADMAN]") || diagnosticBuffer.includes("ACP prompt failed");
    if (hasProviderError && !responseText && !isLimited) {
      const errorText = diagnosticBuffer.trim().split("\n").pop() || "Provider turn failed";
      recordBufferedTurnCheckpoint({
        turn_key: turnKey,
        wake_source: wake.source,
        wake_reason: wake.wakeReason,
        wake_class: wake.wakeClass,
        wake_priority: wake.priority,
        message_id: msg.id,
        sender: msg.sender,
        layer: msg.layer,
        burst_count: burst.mergedCount,
        prompt_hash: checkpointPromptHash,
        prompt_chars: checkpointPromptChars,
        envelope_status: "provider_error",
        envelope_summary: null,
      });
      recordGhostedTurn(turnKey, wake, deadmanTriggered ? "deadman" : "provider_error", errorText, "provider_error");
      recordBufferedTurnPhase("failed", errorText);
      flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
      setRuntimeState("error", currentTask, "provider_error", errorText, null, String(msg.id));
      completeWake(wake, wake.source === "internal_job" ? errorText : wake.source === "local_event" ? errorText : null);
      console.error(`Provider turn failed for ${name}: ${errorText}`);
    } else if (!envelope) {
      const invalidReason = envelopeResult?.ok === false ? envelopeResult.error : "Agent did not return valid JSON envelope.";
      recordBufferedTurnCheckpoint({
        turn_key: turnKey,
        wake_source: wake.source,
        wake_reason: wake.wakeReason,
        wake_class: wake.wakeClass,
        wake_priority: wake.priority,
        message_id: msg.id,
        sender: msg.sender,
        layer: msg.layer,
        burst_count: burst.mergedCount,
        prompt_hash: checkpointPromptHash,
        prompt_chars: checkpointPromptChars,
        envelope_status: envelopeResult?.ok === false ? "validation_failed" : "parse_failed",
        envelope_summary: null,
      });
      recordBufferedTurnPhase("failed", invalidReason);
      flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
      setRuntimeState("error", currentTask, "invalid_action_envelope", invalidReason, null, String(msg.id));
      if (msg.layer !== "internal") {
        sendMessage(msg.sender, msg.layer, `[SYSTEM MESSAGE]: The agent '${name}' returned an invalid action envelope and no actions were executed.`);
      } else {
        completeWake(wake, invalidReason);
      }
      recordWorking("system", `Rejected invalid action envelope: ${invalidReason}`);
      console.error(`Invalid action envelope from ${name}: ${invalidReason}`);
    } else {
      // Split-brain re-run policy: if a light turn produced escalation or complex actions, re-queue as full
      const shouldRerun = executionProfile.profile === "light" && envelope.actions.some((a) =>
        a.type === "escalate"
        || (a.type === "queue_task" && ((a as QueueTaskAction).priority === "urgent" || (a as QueueTaskAction).priority === "high"))
        || a.type === "sleep_until"
      );
      if (shouldRerun) {
        recordWorking("system", `Light turn produced complex actions (${envelope.actions.map((a) => a.type).join(",")}); re-queuing as full-profile turn`);
        recordBufferedTurnCheckpoint({
          turn_key: turnKey,
          wake_source: wake.source,
          wake_reason: wake.wakeReason,
          wake_class: wake.wakeClass,
          wake_priority: wake.priority,
          message_id: msg.id,
          sender: msg.sender,
          layer: msg.layer,
          burst_count: burst.mergedCount,
          prompt_hash: checkpointPromptHash,
          prompt_chars: checkpointPromptChars,
          envelope_status: "rerun_as_full",
          envelope_summary: envelope.summary ?? null,
        });
        recordBufferedTurnPhase("completed", `light→full re-run triggered: ${envelope.summary ?? ""}`);
        flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
        // Re-queue the original wake as a high-priority internal job for full re-run
        const rerunTask = `__rerun__:${wake.source}:${msg.id}:${msg.sender}:${msg.layer}`;
        queueInternalJob(rerunTask, name!, "high");
        // Don't complete the original job/mail — the re-run will handle it
        setRuntimeState(
          options?.successStatus ?? "idle",
          options?.successCurrentTask ?? "awaiting_rerun",
          options?.successWakeReason ?? `rerun:${msg.id}`,
          null,
          options?.successCooldownUntil ?? null,
          String(msg.id),
        );
        clearGhostedTurn();
      } else {
        recordBufferedTurnCheckpoint({
          turn_key: turnKey,
          wake_source: wake.source,
          wake_reason: wake.wakeReason,
          wake_class: wake.wakeClass,
          wake_priority: wake.priority,
          message_id: msg.id,
          sender: msg.sender,
          layer: msg.layer,
          burst_count: burst.mergedCount,
          prompt_hash: checkpointPromptHash,
          prompt_chars: checkpointPromptChars,
          envelope_status: "completed",
          envelope_summary: envelope.summary ?? null,
        });
        recordBufferedTurnPhase("completed", envelope.summary ?? null);
        flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
        bumpGovernor(120, 4, `turn_complete:${wake.sourceGroup}`);
        completeWake(wake);
        setRuntimeState(
          options?.successStatus ?? "idle",
          options?.successCurrentTask ?? "awaiting_message",
          options?.successWakeReason ?? `completed:${msg.id}`,
          null,
          options?.successCooldownUntil ?? null,
          String(msg.id),
        );
        clearGhostedTurn();
      }
    }

    flushActionBatch(bufferedActionRecords);
    console.log(`--- ${name} finished task. Waiting for next message... ---`);
  } catch (error) {
    resolvePendingAcpError("turn crashed before ACP completion");
    const errorText = error instanceof Error ? error.message : String(error);
    flushActionBatch(bufferedActionRecords);
    recordBufferedTurnCheckpoint({
      turn_key: turnKey,
      wake_source: wake.source,
      wake_reason: wake.wakeReason,
      wake_class: wake.wakeClass,
      wake_priority: wake.priority,
      message_id: msg.id,
      sender: msg.sender,
      layer: msg.layer,
      burst_count: burst.mergedCount,
      prompt_hash: checkpointPromptHash,
      prompt_chars: checkpointPromptChars,
      envelope_status: "turn_crash",
      envelope_summary: null,
    });
    recordGhostedTurn(turnKey, wake, "turn_crash", errorText, "turn_crash");
    recordBufferedTurnPhase("failed", errorText);
    flushTurnEventBatch(bufferedTurnPhases, bufferedTurnCheckpoints);
    setRuntimeState("error", currentTask, "turn_crash", errorText, null, String(msg.id));
    completeWake(wake, wake.source === "internal_job" ? errorText : wake.source === "local_event" ? errorText : null);
    recordWorking("system", `Turn crashed: ${errorText}`);
    console.error(`Turn crashed for ${name}: ${errorText}`);
  }
}

async function runWorker() {
  console.log(`--- starting harness for ${name} ---`);
  setRuntimeState("idle", "awaiting_message", "startup");
  const recoveredTurns = recoverInterruptedTurns(runStateQuery, runStateInsert, name!, turnStaleMs);
  for (const turn of recoveredTurns.turns) {
    if (!turn.message_id) continue;
    try {
      execFileSync(
        "agent-state",
        [
          "ghost-set",
          name!,
          turn.turn_key,
          turn.wake_source,
          turn.wake_reason,
          turn.replay_disposition === "safe" ? "interrupted_recovered" : "interrupted_manual_review",
          String(turn.message_id),
          turn.detail ?? "",
          "started",
        ],
        { stdio: "ignore" },
      );
    } catch (e) {
      console.error(`Failed to persist recovered ghost state for ${name}`, e);
    }
    if (turn.replay_disposition !== "safe") {
      sendMessage("operator", "urgent", `[RECOVERY REVIEW] ${name} turn ${turn.turn_key} requires manual review before replay: ${turn.detail ?? "unknown recovery risk"}`);
      recordWorking("system", `Manual review required for interrupted turn ${turn.turn_key}`);
      continue;
    }
    if (turn.wake_source === "internal_job") {
      rescheduleInternalJob(turn.message_id, new Date().toISOString(), "replayed after interrupted turn recovery");
      recordWorking("system", `Rescheduled interrupted internal turn ${turn.turn_key} as job ${turn.message_id}`);
    } else if (turn.wake_source === "local_event") {
      completeLocalEvent(turn.message_id, "replayed after interrupted turn recovery");
      recordWorking("system", `Completed interrupted local event turn ${turn.turn_key} as event ${turn.message_id}`);
    } else if (turn.wake_source === "alarm") {
      completeAlarm(turn.message_id);
      recordWorking("system", `Completed interrupted alarm turn ${turn.turn_key} as alarm ${turn.message_id}`);
    } else if (turn.wake_source === "mail_burst") {
      releaseMailClaims([turn.message_id]);
      recordWorking("system", `Released interrupted mail claim for turn ${turn.turn_key} message ${turn.message_id}`);
    }
  }
  if (recoveredTurns.recovered > 0) {
    recordWorking("system", `Recovered ${recoveredTurns.recovered} interrupted turn(s) older than stale TTL`);
  }
  
  while (true) {
    const governor = readGovernor();
    if (!governor.allowed && governor.forced_cooldown_until) {
      const cooldownUntil = governor.forced_cooldown_until;
      const cooldownDeadline = new Date(cooldownUntil.endsWith("Z") ? cooldownUntil : `${cooldownUntil}Z`).getTime();
      setRuntimeState("cooldown", "refractory_window", "governor", null, cooldownUntil);
      while (Date.now() < cooldownDeadline) {
        const hotWake = await selectNextWake({ allowWorkload: false, blockingMail: false });
        if (hotWake) {
          await processWakeEvent(hotWake, {
            successStatus: "cooldown",
            successCurrentTask: "refractory_window",
            successWakeReason: "governor",
            successCooldownUntil: cooldownUntil,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (Date.now() < cooldownDeadline) {
        continue;
      }
    }

    const wake = await selectNextWake();
    if (!wake) continue;
    await processWakeEvent(wake);
    if (wake.wakeClass === "refractory") {
      const cooldownUntil = applyRefractoryCooldown(wake.sourceGroup);
      setRuntimeState("cooldown", "refractory_window", wake.wakeReason, null, cooldownUntil);
    }
  }
}

runWorker();
