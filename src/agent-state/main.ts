import { Database } from "bun:sqlite";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { appendActionArtifact, appendReviewArtifact, appendRuntimeArtifact, appendTurnArtifact } from "../state-artifacts/lib";
import { ensureSchema } from "./schema";

const dbPath = process.env.AGENT_STATE_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-state.db");
const db = new Database(dbPath);
const jobsDbPath = process.env.AGENT_JOBS_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-jobs.db");
const mailDbPath = process.env.AGENT_MAIL_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-mail.db");
const jobsBin = process.env.AGENT_JOBS_BIN || "agent-jobs";
const mailBin = process.env.AGENT_MAIL_BIN || "agent-mail";

const SKILL = `---
name: agent-state
description: Read and update per-agent runtime state in the agent-state database
binary: agent-state
source: src/agent-state/main.ts
---

# Agent State

Binary: \`agent-state\`
Source: \`src/agent-state/main.ts\`

Per-agent runtime state helper for the agent-state database.
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const [, , cmd, arg1, arg2] = Bun.argv;
const nullableArg = (value: string | undefined | null) => (value === undefined || value === null || value === "" ? null : value);

function usage(): never {
  console.error("Usage: agent-state <get|set|record-action|record-actions-batch|record-turn-events-batch|rebuild|verify|list-actions|list-turns|list-checkpoints|get-checkpoint|recover-turns|review-turns|resolve-turn|replay-turn> ...");
  process.exit(64);
}

function stateDir(...parts: string[]) {
  return join(resolve(process.cwd(), process.env.FLEET_STATE_DIR || join(process.env.META_REPO_ROOT || ".", "state")), ...parts);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rebuildState(agent?: string) {
  const actionsRoot = stateDir("actions");
  const agents = agent
    ? [agent]
    : existsSync(actionsRoot)
      ? readdirSync(actionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name.replace(/\.jsonl$/, ""))
      : [];

  const summary: Array<Record<string, unknown>> = [];
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const name of agents) {
      db.prepare("DELETE FROM fleet_agent_state WHERE agent_name = ?").run(name);
      db.prepare("DELETE FROM fleet_agent_action_journal WHERE agent_name = ?").run(name);
      db.prepare("DELETE FROM fleet_turn_journal WHERE agent_name = ?").run(name);
      db.prepare("DELETE FROM fleet_turn_checkpoints WHERE agent_name = ?").run(name);

      const runtimeRows = readJsonl(stateDir("runtime", `${name}.jsonl`));
      const actionRows = readJsonl(stateDir("actions", `${name}.jsonl`));
      const turnRows = readJsonl(stateDir("turns", `${name}.jsonl`));

      let latestRuntime: Record<string, unknown> | null = null;
      for (const row of runtimeRows) {
        if (row.record_type !== "runtime_state") continue;
        latestRuntime = row;
      }
      if (latestRuntime) {
        db.prepare(
          `INSERT INTO fleet_agent_state (agent_name, status, current_task, wake_reason, last_error, cooldown_until, last_message_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          name,
          latestRuntime.status ?? "idle",
          latestRuntime.current_task ?? null,
          latestRuntime.wake_reason ?? null,
          latestRuntime.last_error ?? null,
          latestRuntime.cooldown_until ?? null,
          latestRuntime.last_message_id ?? null,
          latestRuntime.recorded_at ?? new Date().toISOString(),
        );
      }

      const insertAction = db.prepare(
        `INSERT INTO fleet_agent_action_journal (agent_name, message_id, action_index, action_type, phase, detail, replay_disposition, replay_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of actionRows) {
        if (row.record_type !== "action") continue;
        insertAction.run(
          name,
          row.message_id ?? null,
          row.action_index ?? 0,
          row.action_type ?? "",
          row.phase ?? "",
          row.detail ?? null,
          row.replay_disposition ?? "manual_review",
          row.replay_reason ?? null,
          row.recorded_at ?? new Date().toISOString(),
        );
      }

      const insertTurnPhase = db.prepare(
        `INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const upsertCheckpoint = db.prepare(
        `INSERT INTO fleet_turn_checkpoints (
           agent_name, turn_key, wake_source, wake_reason, wake_class, wake_priority,
           message_id, sender, layer, burst_count, prompt_hash, prompt_chars, envelope_status, envelope_summary,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updated_at = excluded.updated_at`,
      );
      for (const row of turnRows) {
        if (row.record_type === "phase") {
          insertTurnPhase.run(
            name,
            row.turn_key ?? "",
            row.wake_source ?? "",
            row.wake_reason ?? "",
            row.message_id ?? null,
            row.phase ?? "",
            row.detail ?? null,
            row.recorded_at ?? new Date().toISOString(),
          );
        } else if (row.record_type === "checkpoint") {
          const ts = row.recorded_at ?? new Date().toISOString();
          upsertCheckpoint.run(
            name,
            row.turn_key ?? "",
            row.wake_source ?? "",
            row.wake_reason ?? "",
            row.wake_class ?? "",
            row.wake_priority ?? 0,
            row.message_id ?? null,
            row.sender ?? "",
            row.layer ?? "",
            row.burst_count ?? 0,
            row.prompt_hash ?? null,
            row.prompt_chars ?? 0,
            row.envelope_status ?? "missing",
            row.envelope_summary ?? null,
            ts,
            ts,
          );
        }
      }

      summary.push({
        agent: name,
        runtime_records: runtimeRows.length,
        action_records: actionRows.length,
        turn_records: turnRows.length,
      });
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  console.log(JSON.stringify({ rebuilt: summary }));
}

function verifyState(agent?: string) {
  const actionsRoot = stateDir("actions");
  const runtimeRoot = stateDir("runtime");
  const turnsRoot = stateDir("turns");
  const discovered = new Set<string>();
  for (const root of [actionsRoot, runtimeRoot, turnsRoot]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) discovered.add(entry.name.replace(/\.jsonl$/, ""));
    }
  }
  const agents = agent ? [agent] : [...discovered];
  const verified = agents.map((name) => {
    const runtimeRows = readJsonl(stateDir("runtime", `${name}.jsonl`)).filter((row) => row.record_type === "runtime_state");
    const expectedRuntime = runtimeRows.length ? runtimeRows[runtimeRows.length - 1] : null;
    const actualRuntime = db.prepare("SELECT status, current_task, wake_reason, last_error, cooldown_until, last_message_id FROM fleet_agent_state WHERE agent_name = ?").get(name) as Record<string, unknown> | null;
    const actionRows = readJsonl(stateDir("actions", `${name}.jsonl`)).filter((row) => row.record_type === "action");
    const turnRows = readJsonl(stateDir("turns", `${name}.jsonl`));
    const expectedPhaseCount = turnRows.filter((row) => row.record_type === "phase").length;
    const expectedCheckpointCount = new Set(turnRows.filter((row) => row.record_type === "checkpoint").map((row) => String(row.turn_key ?? ""))).size;
    const actualActionCount = Number((db.prepare("SELECT COUNT(*) AS count FROM fleet_agent_action_journal WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0);
    const actualPhaseCount = Number((db.prepare("SELECT COUNT(*) AS count FROM fleet_turn_journal WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0);
    const actualCheckpointCount = Number((db.prepare("SELECT COUNT(*) AS count FROM fleet_turn_checkpoints WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0);
    const runtimeDrift = expectedRuntime
      ? {
          status: expectedRuntime.status !== actualRuntime?.status,
          current_task: (expectedRuntime.current_task ?? null) !== (actualRuntime?.current_task ?? null),
          wake_reason: (expectedRuntime.wake_reason ?? null) !== (actualRuntime?.wake_reason ?? null),
          last_error: (expectedRuntime.last_error ?? null) !== (actualRuntime?.last_error ?? null),
          cooldown_until: (expectedRuntime.cooldown_until ?? null) !== (actualRuntime?.cooldown_until ?? null),
          last_message_id: (expectedRuntime.last_message_id ?? null) !== (actualRuntime?.last_message_id ?? null),
        }
      : null;
    // Row-level action content drift (sample up to 10 recent rows when counts match)
    const actionContentDrift: string[] = [];
    if (actualActionCount === actionRows.length && actionRows.length > 0) {
      const recentExpected = actionRows.slice(-10);
      const recentActual = db.prepare(
        "SELECT action_type, action_index, phase, detail, replay_disposition FROM fleet_agent_action_journal WHERE agent_name = ? ORDER BY id DESC LIMIT 10",
      ).all(name) as Array<{ action_type: string; action_index: number; phase: string; detail: string | null; replay_disposition: string | null }>;
      recentActual.reverse();
      for (let i = 0; i < Math.min(recentExpected.length, recentActual.length); i++) {
        const exp = recentExpected[i];
        const act = recentActual[i];
        if (!exp || !act) continue;
        const diffs: string[] = [];
        if (exp.action_type !== act.action_type) diffs.push(`action_type: ${exp.action_type} vs ${act.action_type}`);
        if ((exp.phase ?? null) !== (act.phase ?? null)) diffs.push(`phase: ${exp.phase} vs ${act.phase}`);
        if ((exp.replay_disposition ?? null) !== (act.replay_disposition ?? null)) diffs.push(`replay_disposition: ${exp.replay_disposition} vs ${act.replay_disposition}`);
        if (diffs.length > 0) actionContentDrift.push(`action[${i}]: ${diffs.join(", ")}`);
      }
    }
    // Detailed runtime drift with expected vs actual values
    const runtimeDriftDetail: Record<string, { expected: unknown; actual: unknown }> = {};
    if (runtimeDrift) {
      for (const [field, drifted] of Object.entries(runtimeDrift)) {
        if (drifted) {
          runtimeDriftDetail[field] = { expected: expectedRuntime?.[field] ?? null, actual: actualRuntime?.[field] ?? null };
        }
      }
    }
    const issues = [
      actualActionCount !== actionRows.length ? `action count drift: expected ${actionRows.length}, actual ${actualActionCount}` : null,
      actualPhaseCount !== expectedPhaseCount ? `turn-phase count drift: expected ${expectedPhaseCount}, actual ${actualPhaseCount}` : null,
      actualCheckpointCount !== expectedCheckpointCount ? `checkpoint count drift: expected ${expectedCheckpointCount}, actual ${actualCheckpointCount}` : null,
      runtimeDrift && Object.entries(runtimeDrift).filter(([, drift]) => drift).map(([field]) => `runtime field drift: ${field}`).join(", "),
      ...actionContentDrift.map((d) => `action content drift: ${d}`),
    ].filter(Boolean);
    return {
      agent: name,
      ok: issues.length === 0 && actualActionCount === actionRows.length
        && actualPhaseCount === expectedPhaseCount
        && actualCheckpointCount === expectedCheckpointCount
        && (!runtimeDrift || !Object.values(runtimeDrift).some(Boolean))
        && actionContentDrift.length === 0,
      expected: {
        runtime_present: !!expectedRuntime,
        actions: actionRows.length,
        turn_phases: expectedPhaseCount,
        checkpoints: expectedCheckpointCount,
      },
      actual: {
        runtime_present: !!actualRuntime,
        actions: actualActionCount,
        turn_phases: actualPhaseCount,
        checkpoints: actualCheckpointCount,
      },
      runtime_drift: runtimeDrift,
      runtime_drift_detail: Object.keys(runtimeDriftDetail).length > 0 ? runtimeDriftDetail : null,
      action_content_drift: actionContentDrift.length > 0 ? actionContentDrift : null,
      issues,
      repair: issues.length === 0 ? null : `agent-state rebuild ${name}`,
    };
  });
  console.log(JSON.stringify({ verified }));
}

ensureSchema(db);

function recoverTurns(agent: string) {
  const rows = db.prepare(
    `SELECT turn_key, wake_source, wake_reason, message_id
     FROM fleet_turn_journal
     WHERE agent_name = ?
       AND phase IN ('interrupted_recovered', 'interrupted_manual_review')
     ORDER BY id DESC
     LIMIT 50`,
  ).all(agent) as Array<{ turn_key: string; wake_source: string; wake_reason: string; message_id: number | null }>;
  const seen = new Set<string>();
  const recovered: Array<{ turn_key: string; action: string; message_id: number | null }> = [];
  for (const row of rows) {
    if (!row.turn_key || seen.has(row.turn_key) || !row.message_id) continue;
    seen.add(row.turn_key);
    const review = db.prepare(
      `SELECT phase, detail
       FROM fleet_turn_journal
       WHERE agent_name = ?
         AND turn_key = ?
       ORDER BY id DESC
       LIMIT 1`,
    ).get(agent, row.turn_key) as { phase: string; detail: string | null } | null;
    if (review?.phase === "interrupted_manual_review") {
      recovered.push({ turn_key: row.turn_key, action: "manual_review_required", message_id: row.message_id });
      continue;
    }
    if (row.wake_source === "internal_job") {
      execFileSync(jobsBin, ["reschedule", String(row.message_id), agent, new Date().toISOString(), "manual agent-state recovery"], { stdio: "ignore" });
      recovered.push({ turn_key: row.turn_key, action: "rescheduled_job", message_id: row.message_id });
    } else if (row.wake_source === "mail_burst") {
      execFileSync(mailBin, ["release-claim", String(row.message_id)], {
        stdio: "ignore",
        env: { ...process.env, AGENT_NAME: agent, AGENT_MAIL_DB: mailDbPath },
      });
      recovered.push({ turn_key: row.turn_key, action: "released_mail_claim", message_id: row.message_id });
    }
  }
  console.log(JSON.stringify({ agent, recovered }));
}

function reviewTurns(agent: string) {
  const jobs = new Database(jobsDbPath);
  const comms = new Database(mailDbPath);
  for (const conn of [jobs, comms]) {
    conn.exec("PRAGMA busy_timeout = 5000;");
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec("PRAGMA synchronous = NORMAL;");
  }
  const rows = db.prepare(
    `SELECT id, turn_key, wake_source, wake_reason, message_id, phase, detail, created_at
     FROM fleet_turn_journal
     WHERE agent_name = ?
       AND phase = 'interrupted_manual_review'
     ORDER BY id DESC
     LIMIT 50`,
  ).all(agent) as Array<{
    id: number;
    turn_key: string;
    wake_source: string;
    wake_reason: string;
    message_id: number | null;
    phase: string;
    detail: string | null;
    created_at: string;
  }>;
  const result = rows.map((row) => ({
    review_summary: row.detail ?? "manual review required",
    ...row,
    checkpoint: db.prepare(
      `SELECT wake_source, wake_reason, wake_class, wake_priority, message_id, sender, layer,
              burst_count, prompt_hash, prompt_chars, envelope_status, envelope_summary, updated_at
       FROM fleet_turn_checkpoints
       WHERE agent_name = ?
         AND turn_key = ?`,
    ).get(agent, row.turn_key),
    actions: row.message_id === null ? [] : db.prepare(
      `SELECT action_index, action_type, phase, detail, replay_disposition, replay_reason, created_at
       FROM fleet_agent_action_journal
       WHERE agent_name = ?
         AND message_id = ?
       ORDER BY id ASC`,
    ).all(agent, row.message_id),
    replay_risks: row.message_id === null ? [] : db.prepare(
      `SELECT action_index, action_type, replay_disposition, replay_reason
       FROM fleet_agent_action_journal
       WHERE agent_name = ?
         AND message_id = ?
         AND phase IN ('started', 'completed')
         AND replay_disposition != 'safe'
       ORDER BY id ASC`,
    ).all(agent, row.message_id),
    job_state: row.wake_source === "internal_job" && row.message_id !== null
      ? jobs.prepare(
          `SELECT id, status, priority, claimed_at, claimed_by, completed_at, last_error, updated_at
           FROM fleet_internal_jobs
           WHERE id = ? AND target_agent = ?`,
        ).get(row.message_id, agent)
      : null,
    mail_claim_state: row.wake_source === "mail_burst" && row.message_id !== null
      ? comms.prepare(
          `SELECT claim.id, claim.status, claim.claimed_at, claim.completed_at,
                  comm.layer, comm.recipient, comm.sender, comm.body, comm.created_at
           FROM fleet_comms_claims claim
           JOIN fleet_comms comm ON comm.id = claim.message_id
           WHERE claim.message_id = ?
             AND LOWER(claim.agent_name) = LOWER(?)`,
        ).get(row.message_id, agent)
      : null,
  }));
  jobs.close();
  comms.close();
  console.log(JSON.stringify({ agent, review: result }));
}

function resolveTurn(agent: string, turnKey: string, resolution: string) {
  const row = db.prepare(
    `SELECT wake_source, wake_reason, message_id, phase
     FROM fleet_turn_journal
     WHERE agent_name = ?
       AND turn_key = ?
     ORDER BY id DESC
     LIMIT 1`,
  ).get(agent, turnKey) as { wake_source: string; wake_reason: string; message_id: number | null; phase: string } | null;
  if (!row) {
    console.log(JSON.stringify({ agent, turn_key: turnKey, resolved: false, reason: "not_found" }));
    return;
  }
  if (row.phase !== "interrupted_manual_review") {
    console.log(JSON.stringify({ agent, turn_key: turnKey, resolved: false, reason: "not_manual_review" }));
    return;
  }
  let action = "discarded";
  if (resolution === "replay" && row.message_id !== null) {
    if (row.wake_source === "internal_job") {
      execFileSync(jobsBin, ["reschedule", String(row.message_id), agent, new Date().toISOString(), "manual operator replay"], { stdio: "ignore" });
      action = "rescheduled_job";
    } else if (row.wake_source === "mail_burst") {
      execFileSync(mailBin, ["release-claim", String(row.message_id)], {
        stdio: "ignore",
        env: { ...process.env, AGENT_NAME: agent, AGENT_MAIL_DB: mailDbPath },
      });
      action = "released_mail_claim";
    }
  }
  db.prepare(
    `INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agent, turnKey, row.wake_source, row.wake_reason, row.message_id, resolution === "replay" ? "interrupted_recovered" : "failed", `manual resolution: ${action}`);
  appendReviewArtifact(
    agent,
    `resolve ${turnKey}`,
    [
      `resolution: ${resolution}`,
      `result: ${action}`,
      `wake_source: ${row.wake_source}`,
      `wake_reason: ${row.wake_reason}`,
      `message_id: ${row.message_id ?? "none"}`,
    ].join("\n"),
  );
  console.log(JSON.stringify({ agent, turn_key: turnKey, resolved: true, action }));
}

function replayTurn(agent: string, turnKey: string) {
  // Read checkpoint to reconstruct the original wake
  const checkpoint = db.prepare(
    `SELECT wake_source, wake_reason, wake_class, wake_priority, message_id, sender, layer, burst_count,
            prompt_hash, prompt_chars, envelope_status, envelope_summary
     FROM fleet_turn_checkpoints
     WHERE agent_name = ? AND turn_key = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(agent, turnKey) as {
    wake_source: string; wake_reason: string; wake_class: string; wake_priority: number;
    message_id: number | null; sender: string | null; layer: string | null;
    burst_count: number | null; prompt_hash: string | null; prompt_chars: number | null;
    envelope_status: string | null; envelope_summary: string | null;
  } | null;
  if (!checkpoint) {
    console.log(JSON.stringify({ agent, turn_key: turnKey, replayed: false, reason: "no_checkpoint" }));
    return;
  }
  // Check the last phase — don't replay completed turns by default
  const lastPhase = db.prepare(
    `SELECT phase FROM fleet_turn_journal
     WHERE agent_name = ? AND turn_key = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(agent, turnKey) as { phase: string } | null;
  if (lastPhase?.phase === "completed") {
    console.log(JSON.stringify({ agent, turn_key: turnKey, replayed: false, reason: "turn_already_completed" }));
    return;
  }
  // Determine replay action based on wake source
  let action = "";
  if (checkpoint.wake_source === "internal_job" && checkpoint.message_id) {
    // Reschedule the original job
    try {
      execFileSync(jobsBin, ["reschedule", String(checkpoint.message_id), agent, new Date().toISOString(), `manual replay of turn ${turnKey}`], { stdio: "ignore" });
      action = "rescheduled_job";
    } catch {
      // Job may already be completed/failed; queue a fresh replay job
      const replayTask = `__replay__:${checkpoint.wake_source}:${checkpoint.message_id}:${checkpoint.sender ?? "unknown"}:${checkpoint.layer ?? "internal"}`;
      execFileSync(jobsBin, ["queue", agent, agent, replayTask, "high"], { stdio: "ignore" });
      action = "queued_replay_job";
    }
  } else if (checkpoint.wake_source === "mail_burst" && checkpoint.message_id) {
    // Release the mail claim so it comes back
    try {
      execFileSync(mailBin, ["release-claim", String(checkpoint.message_id)], {
        stdio: "ignore",
        env: { ...process.env, AGENT_NAME: agent, AGENT_MAIL_DB: mailDbPath },
      });
      action = "released_mail_claim";
    } catch {
      action = "mail_release_failed";
    }
  } else {
    console.log(JSON.stringify({ agent, turn_key: turnKey, replayed: false, reason: "unknown_wake_source", wake_source: checkpoint.wake_source }));
    return;
  }
  // Record the replay in the turn journal
  db.prepare(
    `INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail)
     VALUES (?, ?, ?, ?, ?, 'interrupted_recovered', ?)`,
  ).run(agent, turnKey, checkpoint.wake_source, checkpoint.wake_reason, checkpoint.message_id, `manual replay: ${action}`);
  appendTurnArtifact(agent, {
    record_type: "phase",
    turn_key: turnKey,
    wake_source: checkpoint.wake_source,
    wake_reason: checkpoint.wake_reason,
    message_id: checkpoint.message_id,
    phase: "interrupted_recovered",
    detail: `manual replay: ${action}`,
  });
  console.log(JSON.stringify({ agent, turn_key: turnKey, replayed: true, action, checkpoint_status: checkpoint.envelope_status }));
}

if (cmd === "get") {
  if (!arg1) {
    console.error("Usage: agent-state get <agent>");
    process.exit(64);
  }
  const result = db.prepare("SELECT * FROM fleet_agent_state WHERE agent_name = ?").get(arg1);
  console.log(JSON.stringify(result ?? null));
} else if (cmd === "set") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-state set <agent> <status> [currentTask] [wakeReason] [lastError] [cooldownUntil] [lastMessageId]");
    process.exit(64);
  }
  db.run(
    `INSERT INTO fleet_agent_state (agent_name, status, current_task, wake_reason, last_error, cooldown_until, last_message_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET
       status = excluded.status,
       current_task = excluded.current_task,
       wake_reason = excluded.wake_reason,
       last_error = excluded.last_error,
       cooldown_until = excluded.cooldown_until,
       last_message_id = excluded.last_message_id,
       updated_at = CURRENT_TIMESTAMP`,
    [
      arg1,
      arg2,
      nullableArg(Bun.argv[5]),
      nullableArg(Bun.argv[6]),
      nullableArg(Bun.argv[7]),
      nullableArg(Bun.argv[8]),
      nullableArg(Bun.argv[9]) ? Number(Bun.argv[9]) : null,
    ],
  );
  appendRuntimeArtifact(arg1, {
    record_type: "runtime_state",
    status: arg2,
    current_task: nullableArg(Bun.argv[5]),
    wake_reason: nullableArg(Bun.argv[6]),
    last_error: nullableArg(Bun.argv[7]),
    cooldown_until: nullableArg(Bun.argv[8]),
    last_message_id: nullableArg(Bun.argv[9]) ? Number(Bun.argv[9]) : null,
  });
} else if (cmd === "record-action") {
  if (!arg1 || !arg2 || !Bun.argv[5] || !Bun.argv[6]) {
    console.error("Usage: agent-state record-action <agent> <actionType> <actionIndex> <phase> [detail] [messageId] [replayDisposition] [replayReason]");
    process.exit(64);
  }
  db.run(
    `INSERT INTO fleet_agent_action_journal (agent_name, message_id, action_index, action_type, phase, detail, replay_disposition, replay_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      arg1,
      nullableArg(Bun.argv[8]) ? Number(Bun.argv[8]) : null,
      Number(Bun.argv[5]),
      arg2,
      Bun.argv[6],
      nullableArg(Bun.argv[7]),
      nullableArg(Bun.argv[9]) ?? "manual_review",
      nullableArg(Bun.argv[10]),
    ],
  );
  appendActionArtifact(arg1, {
    record_type: "action",
    message_id: nullableArg(Bun.argv[8]) ? Number(Bun.argv[8]) : null,
    action_index: Number(Bun.argv[5]),
    action_type: arg2,
    phase: Bun.argv[6],
    detail: nullableArg(Bun.argv[7]),
    replay_disposition: nullableArg(Bun.argv[9]) ?? "manual_review",
    replay_reason: nullableArg(Bun.argv[10]),
  });
} else if (cmd === "record-actions-batch") {
  if (!arg1 || !Bun.argv[4]) {
    console.error("Usage: agent-state record-actions-batch <agent> <jsonRecords>");
    process.exit(64);
  }
  const records = JSON.parse(Bun.argv[4]) as Array<{
    action_type: string;
    action_index: number;
    phase: string;
    detail?: string | null;
    message_id?: number | null;
    replay_disposition?: string;
    replay_reason?: string | null;
  }>;
  const insert = db.prepare(
    `INSERT INTO fleet_agent_action_journal (agent_name, message_id, action_index, action_type, phase, detail, replay_disposition, replay_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const record of records) {
      insert.run(
        arg1,
        record.message_id ?? null,
        record.action_index,
        record.action_type,
        record.phase,
        record.detail ?? null,
        record.replay_disposition ?? "manual_review",
        record.replay_reason ?? null,
      );
      appendActionArtifact(arg1, {
        record_type: "action",
        message_id: record.message_id ?? null,
        action_index: record.action_index,
        action_type: record.action_type,
        phase: record.phase,
        detail: record.detail ?? null,
        replay_disposition: record.replay_disposition ?? "manual_review",
        replay_reason: record.replay_reason ?? null,
      });
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
} else if (cmd === "record-turn-events-batch") {
  if (!arg1 || !Bun.argv[4]) {
    console.error("Usage: agent-state record-turn-events-batch <agent> <jsonPayload>");
    process.exit(64);
  }
  const payload = JSON.parse(Bun.argv[4]) as {
    phases?: Array<{
      turn_key: string;
      wake_source: string;
      wake_reason: string;
      message_id?: number | null;
      phase: string;
      detail?: string | null;
    }>;
    checkpoints?: Array<{
      turn_key: string;
      wake_source: string;
      wake_reason: string;
      wake_class: string;
      wake_priority: number;
      message_id?: number | null;
      sender: string;
      layer: string;
      burst_count: number;
      prompt_hash?: string | null;
      prompt_chars: number;
      envelope_status: string;
      envelope_summary?: string | null;
    }>;
  };
  const phaseInsert = db.prepare(
    `INSERT INTO fleet_turn_journal (agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const checkpointInsert = db.prepare(
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
  );
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const phase of payload.phases ?? []) {
      phaseInsert.run(
        arg1,
        phase.turn_key,
        phase.wake_source,
        phase.wake_reason,
        phase.message_id ?? null,
        phase.phase,
        phase.detail ?? null,
      );
      appendTurnArtifact(arg1, {
        record_type: "phase",
        turn_key: phase.turn_key,
        wake_source: phase.wake_source,
        wake_reason: phase.wake_reason,
        message_id: phase.message_id ?? null,
        phase: phase.phase,
        detail: phase.detail ?? null,
      });
    }
    for (const checkpoint of payload.checkpoints ?? []) {
      checkpointInsert.run(
        arg1,
        checkpoint.turn_key,
        checkpoint.wake_source,
        checkpoint.wake_reason,
        checkpoint.wake_class,
        checkpoint.wake_priority,
        checkpoint.message_id ?? null,
        checkpoint.sender,
        checkpoint.layer,
        checkpoint.burst_count,
        checkpoint.prompt_hash ?? null,
        checkpoint.prompt_chars,
        checkpoint.envelope_status,
        checkpoint.envelope_summary ?? null,
      );
      appendTurnArtifact(arg1, {
        record_type: "checkpoint",
        turn_key: checkpoint.turn_key,
        wake_source: checkpoint.wake_source,
        wake_reason: checkpoint.wake_reason,
        wake_class: checkpoint.wake_class,
        wake_priority: checkpoint.wake_priority,
        message_id: checkpoint.message_id ?? null,
        sender: checkpoint.sender,
        layer: checkpoint.layer,
        burst_count: checkpoint.burst_count,
        prompt_hash: checkpoint.prompt_hash ?? null,
        prompt_chars: checkpoint.prompt_chars,
        envelope_status: checkpoint.envelope_status,
        envelope_summary: checkpoint.envelope_summary ?? null,
      });
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
} else if (cmd === "rebuild") {
  rebuildState(arg1);
} else if (cmd === "verify") {
  verifyState(arg1);
} else if (cmd === "list-actions") {
  if (!arg1) {
    console.error("Usage: agent-state list-actions <agent> [limit]");
    process.exit(64);
  }
  const limit = Math.max(1, Number(Bun.argv[4] || "20"));
  const result = db
    .prepare(
      "SELECT * FROM fleet_agent_action_journal WHERE agent_name = ? ORDER BY id DESC LIMIT ?",
    )
    .all(arg1, limit);
  console.log(JSON.stringify(result));
} else if (cmd === "list-turns") {
  if (!arg1) {
    console.error("Usage: agent-state list-turns <agent> [limit]");
    process.exit(64);
  }
  const limit = Math.max(1, Number(Bun.argv[4] || "20"));
  const result = db
    .prepare(
      "SELECT id, agent_name, turn_key, wake_source, wake_reason, message_id, phase, detail, created_at FROM fleet_turn_journal WHERE agent_name = ? ORDER BY id DESC LIMIT ?",
    )
    .all(arg1, limit);
  console.log(JSON.stringify(result));
} else if (cmd === "list-checkpoints") {
  if (!arg1) {
    console.error("Usage: agent-state list-checkpoints <agent> [limit]");
    process.exit(64);
  }
  const limit = Math.max(1, Number(Bun.argv[4] || "20"));
  const result = db
    .prepare(
      "SELECT id, agent_name, turn_key, wake_source, wake_reason, wake_class, wake_priority, message_id, sender, layer, burst_count, prompt_hash, prompt_chars, envelope_status, envelope_summary, created_at, updated_at FROM fleet_turn_checkpoints WHERE agent_name = ? ORDER BY id DESC LIMIT ?",
    )
    .all(arg1, limit);
  console.log(JSON.stringify(result));
} else if (cmd === "get-checkpoint") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-state get-checkpoint <agent> <turnKey>");
    process.exit(64);
  }
  const result = db
    .prepare(
      "SELECT id, agent_name, turn_key, wake_source, wake_reason, wake_class, wake_priority, message_id, sender, layer, burst_count, prompt_hash, prompt_chars, envelope_status, envelope_summary, created_at, updated_at FROM fleet_turn_checkpoints WHERE agent_name = ? AND turn_key = ? LIMIT 1",
    )
    .get(arg1, arg2);
  console.log(JSON.stringify(result ?? null));
} else if (cmd === "recover-turns") {
  if (!arg1) {
    console.error("Usage: agent-state recover-turns <agent>");
    process.exit(64);
  }
  recoverTurns(arg1);
} else if (cmd === "review-turns") {
  if (!arg1) {
    console.error("Usage: agent-state review-turns <agent>");
    process.exit(64);
  }
  reviewTurns(arg1);
} else if (cmd === "resolve-turn") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-state resolve-turn <agent> <turnKey> <replay|discard>");
    process.exit(64);
  }
  resolveTurn(arg1, arg2, Bun.argv[5] || "discard");
} else if (cmd === "replay-turn") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-state replay-turn <agent> <turnKey>");
    process.exit(64);
  }
  replayTurn(arg1, arg2);
} else {
  usage();
}
