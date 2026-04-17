import { appendReviewArtifact, appendTurnArtifact } from "../state-artifacts/lib";

type RunInsert = (query: string, ...args: string[]) => void;
type RunSql = (query: string, ...args: string[]) => any[];

export type TurnPhase = "started" | "completed" | "failed" | "rate_limited" | "interrupted_recovered" | "interrupted_manual_review";
export type ReplayDisposition = "safe" | "manual_review";
export type ActionReplayPolicy = {
  disposition: ReplayDisposition;
  reason: string;
};
export type TurnCheckpoint = {
  agent_name: string;
  turn_key: string;
  wake_source: string;
  wake_reason: string;
  wake_class: string;
  wake_priority: number;
  message_id: number | null;
  sender: string;
  layer: string;
  burst_count: number;
  prompt_hash: string | null;
  prompt_chars: number;
  envelope_status: string;
  envelope_summary: string | null;
  updated_at?: string;
};
type StoredCheckpoint = {
  envelope_status: string;
  prompt_hash: string | null;
  prompt_chars: number | string;
};

export function ensureTurnJournal(runInsert: RunInsert) {
  runInsert(
    `CREATE TABLE IF NOT EXISTS fleet_turn_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      wake_source TEXT NOT NULL,
      wake_reason TEXT NOT NULL,
      message_id INTEGER,
      phase TEXT NOT NULL,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  runInsert(
    `CREATE TABLE IF NOT EXISTS fleet_turn_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      wake_source TEXT NOT NULL,
      wake_reason TEXT NOT NULL,
      wake_class TEXT NOT NULL,
      wake_priority INTEGER NOT NULL,
      message_id INTEGER,
      sender TEXT NOT NULL,
      layer TEXT NOT NULL,
      burst_count INTEGER NOT NULL,
      prompt_hash TEXT,
      prompt_chars INTEGER NOT NULL DEFAULT 0,
      envelope_status TEXT NOT NULL,
      envelope_summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(agent_name, turn_key)
    )`,
  );
}

export function recordTurnCheckpoint(runInsert: RunInsert, checkpoint: TurnCheckpoint) {
  runInsert(
    `INSERT INTO fleet_turn_checkpoints (
       agent_name, turn_key, wake_source, wake_reason, wake_class, wake_priority,
       message_id, sender, layer, burst_count, prompt_hash, prompt_chars, envelope_status, envelope_summary,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name, turn_key) DO UPDATE SET
       wake_source = excluded.wake_source,
       wake_reason = excluded.wake_reason,
       wake_class = excluded.wake_class,
       wake_priority = excluded.wake_priority,
       message_id = excluded.message_id,
       sender = excluded.sender,
       layer = excluded.layer,
       burst_count = excluded.burst_count,
       prompt_hash = excluded.prompt_hash,
       prompt_chars = excluded.prompt_chars,
       envelope_status = excluded.envelope_status,
       envelope_summary = excluded.envelope_summary,
       updated_at = CURRENT_TIMESTAMP`,
    checkpoint.agent_name,
    checkpoint.turn_key,
    checkpoint.wake_source,
    checkpoint.wake_reason,
    checkpoint.wake_class,
    String(checkpoint.wake_priority),
    checkpoint.message_id === null ? "" : String(checkpoint.message_id),
    checkpoint.sender,
    checkpoint.layer,
    String(checkpoint.burst_count),
    checkpoint.prompt_hash ?? "",
    String(checkpoint.prompt_chars),
    checkpoint.envelope_status,
    checkpoint.envelope_summary ?? "",
  );
  appendTurnArtifact(checkpoint.agent_name, {
    record_type: "checkpoint",
    turn_key: checkpoint.turn_key,
    wake_source: checkpoint.wake_source,
    wake_reason: checkpoint.wake_reason,
    wake_class: checkpoint.wake_class,
    wake_priority: checkpoint.wake_priority,
    message_id: checkpoint.message_id,
    sender: checkpoint.sender,
    layer: checkpoint.layer,
    burst_count: checkpoint.burst_count,
    prompt_hash: checkpoint.prompt_hash,
    prompt_chars: checkpoint.prompt_chars,
    envelope_status: checkpoint.envelope_status,
    envelope_summary: checkpoint.envelope_summary,
  });
}

export function replayPolicyForAction(actionType: string): ActionReplayPolicy {
  switch (actionType) {
    case "noop":
      return { disposition: "safe", reason: "No external or durable side effect." };
    case "note":
      return { disposition: "safe", reason: "Working-memory note is replay-tolerable." };
    case "reply":
      return { disposition: "manual_review", reason: "May duplicate outward communication." };
    case "queue_task":
      return { disposition: "manual_review", reason: "May enqueue duplicate internal work without idempotence key." };
    case "escalate":
      return { disposition: "manual_review", reason: "May duplicate operator escalation." };
    case "scratchpad":
      return { disposition: "manual_review", reason: "May duplicate or overwrite persistent scratchpad state." };
    case "sleep_until":
      return { disposition: "manual_review", reason: "Sleep timing is not replay-idempotent." };
    case "spawn_scribe":
      return { disposition: "safe", reason: "Fire-and-forget scribe; result delivery via mail is idempotent." };
    default:
      return { disposition: "manual_review", reason: "Unknown action type is not replay-safe." };
  }
}

export function recordTurnPhase(
  runInsert: RunInsert,
  agentName: string,
  turnKey: string,
  wakeSource: string,
  wakeReason: string,
  messageId: number | null,
  phase: TurnPhase,
  detail: string | null = null,
) {
  runInsert(
    "INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    agentName,
    turnKey,
    wakeSource,
    wakeReason,
    messageId === null ? "" : String(messageId),
    phase,
    detail ?? "",
  );
  appendTurnArtifact(agentName, {
    record_type: "phase",
    turn_key: turnKey,
    wake_source: wakeSource,
    wake_reason: wakeReason,
    message_id: messageId,
    phase,
    detail,
  });
}

export function recoverInterruptedTurns(runSql: RunSql, runInsert: RunInsert, agentName: string, staleMs: number) {
  const rows = runSql(
    `SELECT turn_key, wake_source, wake_reason, message_id, phase, detail, created_at
     FROM fleet_turn_journal
     WHERE agent_name = ?
     ORDER BY id DESC
     LIMIT 200`,
    agentName,
  ) as Array<{
    turn_key: string;
    wake_source: string;
    wake_reason: string;
    message_id: number | string | null;
    phase: string;
    detail: string | null;
    created_at: string;
  }>;

  const latestByTurn = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!row.turn_key || latestByTurn.has(row.turn_key)) continue;
    latestByTurn.set(row.turn_key, row);
  }

  let recovered = 0;
  const recoveredTurns: Array<{
    turn_key: string;
    wake_source: string;
    wake_reason: string;
    message_id: number | null;
    detail: string | null;
    replay_disposition: "safe" | "manual_review";
  }> = [];
  for (const row of latestByTurn.values()) {
    if (row.phase !== "started") continue;
    const createdAtMs = new Date(row.created_at.endsWith("Z") ? row.created_at : `${row.created_at}Z`).getTime();
    if (!Number.isFinite(createdAtMs)) continue;
    if ((Date.now() - createdAtMs) < staleMs) continue;
    const messageId = row.message_id === null || row.message_id === "" ? null : Number(row.message_id);
    const checkpoint = runSql(
      `SELECT envelope_status, prompt_hash, prompt_chars
       FROM fleet_turn_checkpoints
       WHERE agent_name = ?
         AND turn_key = ?
       LIMIT 1`,
      agentName,
      row.turn_key,
    )[0] as StoredCheckpoint | undefined;
    const actionRows = messageId === null ? [] : runSql(
      `SELECT action_type, phase, replay_disposition, replay_reason
       FROM fleet_agent_action_journal
       WHERE agent_name = ?
         AND message_id = ?
       ORDER BY id ASC`,
      agentName,
      String(messageId),
    ) as Array<{ action_type: string; phase: string; replay_disposition?: ReplayDisposition; replay_reason?: string | null }>;
    const effectedActions = actionRows.filter((entry) => entry.phase === "started" || entry.phase === "completed");
    const unsafeEffectActions = effectedActions.filter((entry) => (entry.replay_disposition ?? replayPolicyForAction(entry.action_type).disposition) !== "safe");
    const checkpointStatus = checkpoint?.envelope_status ?? "missing";
    const checkpointReady = checkpointStatus === "prompt_built"
      || checkpointStatus === "validated"
      || checkpointStatus === "completed"
      || checkpointStatus === "rate_limited";
    const replayDisposition: ReplayDisposition = unsafeEffectActions.length > 0 || !checkpointReady ? "manual_review" : "safe";
    const phase: TurnPhase = replayDisposition === "safe" ? "interrupted_recovered" : "interrupted_manual_review";
    const detail = replayDisposition === "safe"
      ? `turn was still marked started after stale TTL; checkpoint=${checkpointStatus}; prompt_hash=${checkpoint?.prompt_hash ?? "none"}`
      : unsafeEffectActions.length > 0
        ? `manual review required: ${unsafeEffectActions.map((entry) => `${entry.action_type} (${entry.replay_reason ?? replayPolicyForAction(entry.action_type).reason})`).join("; ")}`
        : `manual review required: checkpoint state '${checkpointStatus}' is not strong enough for auto-replay`;
    if (replayDisposition === "manual_review") {
      appendReviewArtifact(
        agentName,
        `manual-review ${row.turn_key}`,
        [
          `turn_key: ${row.turn_key}`,
          `wake_source: ${row.wake_source}`,
          `wake_reason: ${row.wake_reason}`,
          `message_id: ${messageId ?? "none"}`,
          `checkpoint_status: ${checkpointStatus}`,
          `detail: ${detail}`,
        ].join("\n"),
      );
    }
    recordTurnPhase(
      runInsert,
      agentName,
      row.turn_key,
      row.wake_source,
      row.wake_reason,
      messageId,
      phase,
      detail,
    );
    recovered += 1;
    recoveredTurns.push({
      turn_key: row.turn_key,
      wake_source: row.wake_source,
      wake_reason: row.wake_reason,
      message_id: messageId,
      detail,
      replay_disposition: replayDisposition,
    });
  }
  return { recovered, turns: recoveredTurns };
}
