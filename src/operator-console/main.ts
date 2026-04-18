import { Database } from "bun:sqlite";
import { join } from "path";
import { emitKeypressEvents } from "readline";
import { ensureMailSchema, type FleetMessage } from "../agent-mail/core";
import { ensureJobSchema } from "../agent-jobs/core";
import { createInitialState, reduceTuiState, renderScreen, type AgentQueueRow, type OperatorAgentRow, type OperatorSnapshot } from "./tui";

const SKILL = `---
name: operator-console
description: Full-screen operator console for fleet overview, mail, and compose
binary: operator-console
source: src/operator-console/main.ts
---

# Operator Console

Binary: \`operator-console\`
Source: \`src/operator-console/main.ts\`

Full-screen TUI for the human operator.

## Usage

\`\`\`
operator-console skill
operator-console
\`\`\`

## Modes

- \`overview\` — fleet runtime state and queue totals
- \`mail\` — recent operator-facing traffic
- \`compose\` — send direct or \`all\` messages
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const root = process.env.META_REPO_ROOT || ".";
const mailDbPath = process.env.AGENT_MAIL_DB || join(root, "runtime/agent-mail.db");
const stateDbPath = process.env.AGENT_STATE_DB || join(root, "runtime/agent-state.db");
const jobsDbPath = process.env.AGENT_JOBS_DB || join(root, "runtime/agent-jobs.db");

const mailDb = new Database(mailDbPath);
const stateDb = new Database(stateDbPath);
const jobsDb = new Database(jobsDbPath);

for (const db of [mailDb, stateDb, jobsDb]) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

ensureMailSchema(mailDb);
ensureJobSchema(jobsDb);
ensureStateSchema(stateDb);

const sender = "operator";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isBusyError = (error: unknown) =>
  error instanceof Error &&
  (("code" in error && (error as { code?: string }).code === "SQLITE_BUSY") || error.message.includes("database is locked"));

const withBusyRetry = async <T>(fn: () => T, retries = 50): Promise<T> => {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt === retries - 1) throw error;
      await sleep(100);
    }
  }
  throw new Error("unreachable");
};

function ensureStateSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS fleet_agent_state (
    agent_name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    current_task TEXT,
    wake_reason TEXT,
    last_error TEXT,
    cooldown_until DATETIME,
    last_message_id INTEGER,
    transition_hash TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    health_status TEXT NOT NULL DEFAULT 'dead',
    health_updated_at DATETIME
  );`);
}

function send(recipient: string, body: string) {
  const layer = recipient === "all" ? "public" : "private";
  return withBusyRetry(() =>
    mailDb.run(
      "INSERT INTO fleet_comms (recipient, layer, sender, body) VALUES (?, ?, ?, ?)",
      [recipient, layer, sender, body],
    ),
  );
}

function queryAgents(): OperatorAgentRow[] {
  return stateDb
    .prepare(
      `SELECT agent_name, status, health_status, current_task, wake_reason, cooldown_until, updated_at
       FROM fleet_agent_state
       ORDER BY agent_name ASC`,
    )
    .all() as OperatorAgentRow[];
}

function queryQueueByAgent(): AgentQueueRow[] {
  const rows = jobsDb
    .prepare(
      `WITH job_counts AS (
         SELECT target_agent AS agent_name, COUNT(*) AS jobs
         FROM fleet_internal_jobs
         WHERE status = 'queued'
           AND datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP
         GROUP BY target_agent
       ),
       alarm_counts AS (
         SELECT target_agent AS agent_name, COUNT(*) AS alarms
         FROM fleet_job_alarms
         WHERE status = 'pending'
           AND datetime(due_at) <= CURRENT_TIMESTAMP
         GROUP BY target_agent
       ),
       event_counts AS (
         SELECT target_agent AS agent_name, COUNT(*) AS events
         FROM fleet_local_events
         WHERE status = 'queued'
           AND datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP
         GROUP BY target_agent
       ),
       names AS (
         SELECT agent_name FROM job_counts
         UNION
         SELECT agent_name FROM alarm_counts
         UNION
         SELECT agent_name FROM event_counts
       )
       SELECT
         names.agent_name,
         COALESCE(job_counts.jobs, 0) AS jobs,
         COALESCE(alarm_counts.alarms, 0) AS alarms,
         COALESCE(event_counts.events, 0) AS events
       FROM names
       LEFT JOIN job_counts ON job_counts.agent_name = names.agent_name
       LEFT JOIN alarm_counts ON alarm_counts.agent_name = names.agent_name
       LEFT JOIN event_counts ON event_counts.agent_name = names.agent_name
       ORDER BY names.agent_name ASC`,
    )
    .all() as AgentQueueRow[];
  return rows;
}

function queryQueueTotals() {
  const jobs = Number((jobsDb.prepare(
    `SELECT COUNT(*) AS count
     FROM fleet_internal_jobs
     WHERE status = 'queued'
       AND datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP`,
  ).get() as { count: number } | null)?.count ?? 0);
  const alarms = Number((jobsDb.prepare(
    `SELECT COUNT(*) AS count
     FROM fleet_job_alarms
     WHERE status = 'pending'
       AND datetime(due_at) <= CURRENT_TIMESTAMP`,
  ).get() as { count: number } | null)?.count ?? 0);
  const events = Number((jobsDb.prepare(
    `SELECT COUNT(*) AS count
     FROM fleet_local_events
     WHERE status = 'queued'
       AND datetime(COALESCE(available_at, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP`,
  ).get() as { count: number } | null)?.count ?? 0);
  return { jobs, alarms, events };
}

function queryUnreadCount(): number {
  const result = mailDb.prepare(
    `SELECT COUNT(*) AS count
     FROM fleet_comms
     WHERE sender != ?
       AND (
         (LOWER(recipient) = LOWER(?) AND read_at IS NULL)
         OR
         (LOWER(recipient) = 'all' AND IFNULL(read_by, '') NOT LIKE ?)
       )`,
  ).get(sender, sender, `%|${sender}|%`) as { count: number } | null;
  return Number(result?.count ?? 0);
}

function queryRecentMail(): FleetMessage[] {
  return mailDb
    .prepare(
      `SELECT id, layer, recipient, sender, body, read_at, read_by, created_at
       FROM fleet_comms
       WHERE LOWER(recipient) = LOWER(?)
          OR LOWER(recipient) = 'all'
          OR LOWER(sender) = LOWER(?)
       ORDER BY id DESC
       LIMIT 30`,
    )
    .all(sender, sender) as FleetMessage[];
}

async function markRecentMailRead(rows: FleetMessage[]) {
  for (const row of rows) {
    if (row.sender === sender) continue;
    if (row.recipient.toLowerCase() === sender && row.read_at == null) {
      await withBusyRetry(() =>
        mailDb.run(
          `UPDATE fleet_comms
           SET read_at = CURRENT_TIMESTAMP,
               read_by = CASE
                 WHEN IFNULL(read_by, '') = '' THEN ?
                 WHEN read_by LIKE ? THEN read_by
                 ELSE read_by || ?
               END
           WHERE id = ?`,
          [sender, `%|${sender}|%`, `|${sender}|`, row.id],
        ),
      );
      continue;
    }
    if (row.recipient.toLowerCase() === "all" && !(row.read_by || "").includes(`|${sender}|`)) {
      await withBusyRetry(() =>
        mailDb.run(
          `UPDATE fleet_comms
           SET read_by = CASE
             WHEN IFNULL(read_by, '') = '' THEN ?
             WHEN read_by LIKE ? THEN read_by
             ELSE read_by || ?
           END
           WHERE id = ?`,
          [`|${sender}|`, `%|${sender}|%`, `|${sender}|`, row.id],
        ),
      );
    }
  }
}

async function snapshot(): Promise<OperatorSnapshot> {
  const recentMail = queryRecentMail();
  await markRecentMailRead(recentMail.slice(0, 5));
  return {
    agents: queryAgents(),
    queueTotals: queryQueueTotals(),
    queueByAgent: queryQueueByAgent(),
    unreadCount: queryUnreadCount(),
    recentMail: queryRecentMail(),
  };
}

function cleanup() {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

async function main() {
  let state = createInitialState();
  let data = await snapshot();

  const rerender = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(renderScreen(state, data, process.stdout.columns || 100, process.stdout.rows || 28));
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("exit", cleanup);

  process.stdout.write("\x1b[?1049h\x1b[?25l");
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  rerender();

  const interval = setInterval(async () => {
    data = await snapshot();
    rerender();
  }, 1000);

  process.stdin.on("keypress", async (sequence: string, key: { ctrl?: boolean; name?: string } = {}) => {
    const [next, effect] = reduceTuiState(state, { type: "key", sequence, ctrl: key.ctrl, name: key.name }, data);
    state = next;
    if (effect.type === "send") {
      await send(effect.recipient, effect.body);
      data = await snapshot();
    } else if (effect.type === "refresh") {
      data = await snapshot();
    } else if (effect.type === "quit") {
      clearInterval(interval);
      cleanup();
      process.exit(0);
    }
    rerender();
  });
}

await main();
