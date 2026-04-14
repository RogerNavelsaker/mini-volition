import { Database } from "bun:sqlite";
import { createConnection } from "net";
import { ensureSchema as ensureMemorySchema } from "../agent-memory/schema";
import { appendMemorySourceArtifact } from "../state-artifacts/lib";

const SKILL = `---
name: fleet-digest
description: Long-running worker loop that listens to public broadcasts and creates episodic digests
binary: fleet-digest
source: src/fleet-digest/main.ts
---

# Fleet Digest

Binary: \`fleet-digest\`
Source: \`src/fleet-digest/main.ts\`

Long-running worker loop for generating tier 2 episodic memories.
Monitors the 'public' layer, batches conversation bursts, summarizes them, and stores them in the \`public_digests\` table.
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const commsDbPath = process.env.AGENT_MAIL_DB || "runtime/agent-mail.db";
const memoryDbPath = process.env.AGENT_MEMORY_DB || "runtime/agent-memory.db";
const stateDbPath = process.env.AGENT_STATE_DB || "runtime/agent-state.db";
const e2bSocket = process.env.FLEET_E2B_SOCKET || "runtime/e2b.sock";
const commsDb = new Database(commsDbPath);
const memoryDb = new Database(memoryDbPath);
const stateDb = new Database(stateDbPath);

for (const db of [commsDb, memoryDb, stateDb]) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}
ensureMemorySchema(memoryDb);
stateDb.run(`CREATE TABLE IF NOT EXISTS fleet_agent_state (
  agent_name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  current_task TEXT,
  wake_reason TEXT,
  last_error TEXT,
  cooldown_until DATETIME,
  last_message_id INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`);

type FleetMessage = {
  id: number;
  layer: string;
  recipient: string;
  sender: string;
  body: string;
  created_at: string;
};

type DigestSummary = {
  summary: string;
  decisions: string[];
  source: string;
};

function runSql(query: string, ...args: string[]): any[] {
  try {
    return commsDb.prepare(query).all(...args);
  } catch (e) {
    console.error(`Failed to run SQL: ${query}`, e);
    return [];
  }
}

function runMemoryInsert(query: string, ...args: string[]) {
  try {
    memoryDb.prepare(query).run(...args);
  } catch (e) {
    console.error(`Failed to insert: ${query}`, e);
  }
}

function setServiceState(
  status: string,
  currentTask: string | null = null,
  wakeReason: string | null = null,
  lastError: string | null = null,
) {
  try {
    stateDb.prepare(
    `INSERT INTO fleet_agent_state (agent_name, status, current_task, wake_reason, last_error, cooldown_until, last_message_id, updated_at)
     VALUES ('digest', ?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name) DO UPDATE SET
       status = excluded.status,
       current_task = excluded.current_task,
       wake_reason = excluded.wake_reason,
       last_error = excluded.last_error,
       updated_at = CURRENT_TIMESTAMP`,
    ).run(status, currentTask ?? "", wakeReason ?? "", lastError ?? "");
  } catch (e) {
    console.error("Failed to set digest runtime state", e);
  }
}

function heuristicSummary(messages: FleetMessage[]): DigestSummary {
  const actors = [...new Set(messages.map((m) => m.sender))];
  const bodies = messages.map((m) => m.body.toLowerCase()).join("\n");
  const mentionsStatus = /\b(status|done|finished|sleep|stand down|awake)\b/.test(bodies);
  const mentionsCode = /\b(bug|fix|compile|build|test|function|error|retry)\b/.test(bodies);
  const mentionsDecision = /\b(decide|decision|should|will|plan)\b/.test(bodies);

  let summary = `Public burst with ${messages.length} message(s) from ${actors.join(", ")}. `;
  if (mentionsCode) {
    summary += "Primary topic: implementation or debugging work.";
  } else if (mentionsStatus) {
    summary += "Primary topic: status reporting and coordination.";
  } else {
    summary += "Primary topic: general coordination.";
  }

  const decisions = mentionsDecision
    ? ["One or more explicit decisions or plans were discussed."]
    : ["No explicit decision detected; treat as situational awareness."];

  return { summary, decisions, source: "heuristic" };
}

function requestSummary(messages: FleetMessage[]): Promise<DigestSummary> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(e2bSocket);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "summarize", messages })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      const line = buffer.slice(0, newline).trim();
      socket.end();
      if (!line) {
        reject(new Error("Inference server returned empty response"));
        return;
      }

      try {
        const parsed = JSON.parse(line) as DigestSummary & { error?: string };
        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        if (!parsed.summary || !Array.isArray(parsed.decisions)) {
          reject(new Error("Inference server returned malformed summary"));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });

    socket.on("error", reject);
  });
}

async function summarizeBurst(messages: FleetMessage[]) {
  setServiceState("working", "summarize_public_burst", `burst:${messages.length}`);
  const actors = [...new Set(messages.flatMap((m) => [m.sender, m.recipient]).filter((name) => name && name.toLowerCase() !== "all"))];
  const startTime = new Date(messages[0].created_at + "Z").getTime();
  const endTime = new Date(messages[messages.length - 1].created_at + "Z").getTime();
  const durationSec = Math.floor((endTime - startTime) / 1000);

  let result: DigestSummary;
  try {
    result = await requestSummary(messages);
  } catch (error) {
    console.error(`[DIGEST] Inference socket summarization failed, falling back to heuristic: ${error}`);
    result = heuristicSummary(messages);
  }

  const summary = `${result.summary}${result.decisions.length ? ` Decisions: ${result.decisions.join(" | ")}` : ""}`;
  console.log(`[DIGEST] ${result.source} summary for ${actors.join(", ")}: ${summary}`);

  runMemoryInsert("INSERT INTO public_digests (summary, actors, type) VALUES (?, ?, ?)", summary, actors.join(", "), `burst:${result.source}`);
  appendMemorySourceArtifact("digests", "public", {
    record_type: "public_digest",
    summary,
    actors: actors.join(", "),
    type: `burst:${result.source}`,
  });
  for (const actor of actors) {
    runMemoryInsert(
      "INSERT INTO tier2_episodic (agent_name, summary, duration_asleep, actors) VALUES (?, ?, ?, ?)",
      actor,
      `Ear digest: ${summary}`,
      String(durationSec),
      actors.join(", "),
    );
    appendMemorySourceArtifact("episodic", actor, {
      record_type: "tier2_episodic",
      agent_name: actor,
      summary: `Ear digest: ${summary}`,
      duration_asleep: durationSec,
      actors: actors.join(", "),
    });
  }
  setServiceState("idle", "awaiting_public_burst", `completed:${messages[messages.length - 1].id}`);
}

function shouldFlushBurst(messages: FleetMessage[]) {
  if (messages.length >= 5) return true;
  if (messages.length === 0) return false;
  const oldest = messages[0];
  const oldestAgeSec = Math.floor((Date.now() - new Date(`${oldest.created_at}Z`).getTime()) / 1000);
  return oldestAgeSec > 10;
}

async function main() {
  let lastProcessedId = 0;
  const maxRec = runSql("SELECT MAX(id) as id FROM fleet_comms WHERE layer = 'public'")[0];
  if (maxRec && maxRec.id) {
    lastProcessedId = maxRec.id;
  }

  setServiceState("idle", "awaiting_public_burst", "startup");
  console.log(`[DIGEST] Service started. Listening for public bursts via ${e2bSocket}`);

  while (true) {
    const newMessages = runSql("SELECT * FROM fleet_comms WHERE layer = 'public' AND id > ? ORDER BY id ASC", lastProcessedId.toString()) as FleetMessage[];
    if (shouldFlushBurst(newMessages)) {
      await summarizeBurst(newMessages);
      lastProcessedId = newMessages[newMessages.length - 1].id;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

main();
