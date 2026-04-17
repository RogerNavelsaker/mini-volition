import { Database } from "bun:sqlite";
import { buildBurstFromPrimary, claimBurst, completeBurst, countUnread, ensureMailSchema, peekBurst, reclaimStaleClaims, releaseClaims, type BurstEnvelope, type FleetMessage, unreadQueryFor } from "./core";
import { appendMailArtifact } from "../state-artifacts/lib";
import { getSubscriptions } from "../agent-state/schema";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const dbPath = process.env.AGENT_MAIL_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-mail.db");
const stateDbPath = process.env.AGENT_STATE_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-state.db");
const db = new Database(dbPath);
let stateDb: Database | null = null;
try {
  if (existsSync(stateDbPath)) stateDb = new Database(stateDbPath, { readonly: true, create: false });
} catch { /* state db unavailable — subscriptions disabled */ }

function loadSubscriptions(agentName: string): string[] | undefined {
  if (!stateDb) return undefined;
  try {
    const layers = getSubscriptions(stateDb, agentName);
    return layers.length > 0 ? layers : undefined;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isBusyError = (error: unknown) =>
  error instanceof Error &&
  ("code" in error || "message" in error) &&
  ((error as { code?: string }).code === "SQLITE_BUSY" ||
    error.message.includes("database is locked"));

const withBusyRetry = async <T>(fn: () => T, retries = 50): Promise<T> => {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt === retries - 1) {
        throw error;
      }
      await sleep(100);
    }
  }

  throw new Error("unreachable");
};

db.exec("PRAGMA busy_timeout = 5000;");

await withBusyRetry(() => {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  ensureMailSchema(db);
});

const SKILL = `---
name: agent-mail
description: SQLite-backed message bus for inter-agent communication in the fleet
binary: agent-mail
source: src/agent-mail/main.ts
---

# Agent Mail

Binary: \`agent-mail\`
Source: \`src/agent-mail/main.ts\`

SQLite mail bus for the fleet. Compiled with Bun, stores state in \`runtime/agent-mail.db\`.

## Commands

- \`agent-mail send <recipient> <layer> "<message>"\` — send a message
- \`AGENT_NAME=<name> agent-mail listen\` — block until an unread message arrives, print as JSON
- \`AGENT_NAME=<name> agent-mail listen-burst [limit] [windowSec]\` — claim a same-channel burst of unread messages
- \`agent-mail tail <layer>\` — stream messages on a layer
- \`agent-mail skill\` — print this skill document to stdout

## Transport layers

- \`private\` — direct 1:1 coordination
- \`public\` — shared status and passive awareness
- \`urgent\` — urgent interrupts

## Integrity rule

Reply on the same layer you were contacted on.`;

const [, , cmd, arg1, arg2, arg3] = Bun.argv;
const sender = process.env.AGENT_NAME || "operator";

const formatMessage = (msg: FleetMessage) => {
  const timeStr = msg.created_at.endsWith("Z") ? msg.created_at : msg.created_at + "Z";
  const time = new Date(timeStr).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const target = msg.recipient.toLowerCase() === "all" ? "" : ` -> ${msg.recipient}`;
  return `[${time}] <${msg.sender}${target}> ${msg.body}`;
};

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

async function rebuildMail() {
  const mailRoot = stateDir("mail");
  const files = existsSync(mailRoot)
    ? readdirSync(mailRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
    : [];
  const messages = new Map<number, any>();
  const claims = new Map<string, any>();

  for (const file of files) {
    const agent = file.replace(/\.jsonl$/, "");
    for (const row of readJsonl(stateDir("mail", file))) {
      if (row.record_type === "message" && row.event === "sent" && row.message && typeof row.message === "object") {
        const msg = row.message as any;
        if (msg.id != null) messages.set(Number(msg.id), { ...msg });
      } else if (row.record_type === "claim" && row.event === "claimed_burst" && Array.isArray(row.message_ids)) {
        for (const id of row.message_ids as unknown[]) {
          claims.set(`${agent}:${Number(id)}`, {
            message_id: Number(id),
            agent_name: agent,
            claimed_at: row.recorded_at ?? new Date().toISOString(),
            completed_at: null,
            status: "claimed",
          });
        }
      } else if (row.record_type === "claim" && row.event === "completed_burst" && Array.isArray(row.message_ids)) {
        for (const id of row.message_ids as unknown[]) {
          const key = `${agent}:${Number(id)}`;
          const current = claims.get(key) ?? {
            message_id: Number(id),
            agent_name: agent,
            claimed_at: row.recorded_at ?? new Date().toISOString(),
          };
          claims.set(key, { ...current, completed_at: row.recorded_at ?? new Date().toISOString(), status: "completed" });
          const msg = messages.get(Number(id));
          if (msg) {
            if (String(msg.recipient).toLowerCase() === "all") {
              const token = `|${agent}|`;
              msg.read_by = String(msg.read_by ?? "").includes(token) ? String(msg.read_by ?? "") : `${String(msg.read_by ?? "")}${token}`;
            } else {
              msg.read_at = row.recorded_at ?? new Date().toISOString();
            }
            messages.set(Number(id), msg);
          }
        }
      } else if (row.record_type === "claim" && row.event === "released_claim" && Array.isArray(row.message_ids)) {
        for (const id of row.message_ids as unknown[]) claims.delete(`${agent}:${Number(id)}`);
      }
    }
  }

  await withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("DELETE FROM fleet_comms_claims;");
      db.exec("DELETE FROM fleet_comms;");
      const insertMessage = db.prepare(
        `INSERT INTO fleet_comms (id, layer, recipient, sender, body, read_at, read_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const msg of [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insertMessage.run(msg.id, msg.layer, msg.recipient, msg.sender, msg.body, msg.read_at ?? null, msg.read_by ?? "", msg.created_at ?? new Date().toISOString());
      }
      const insertClaim = db.prepare(
        `INSERT INTO fleet_comms_claims (message_id, agent_name, claimed_at, completed_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const claim of claims.values()) {
        insertClaim.run(claim.message_id, claim.agent_name, claim.claimed_at, claim.completed_at ?? null, claim.status);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  });

  console.log(JSON.stringify({ rebuilt: { messages: messages.size, claims: claims.size, files: files.length } }));
}

async function verifyMail() {
  const mailRoot = stateDir("mail");
  const files = existsSync(mailRoot)
    ? readdirSync(mailRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name)
    : [];
  const expectedMessages = new Map<number, any>();
  const expectedClaims = new Map<string, any>();
  for (const file of files) {
    const agent = file.replace(/\.jsonl$/, "");
    for (const row of readJsonl(stateDir("mail", file))) {
      if (row.record_type === "message" && row.event === "sent" && row.message && typeof row.message === "object") {
        const msg = row.message as any;
        if (msg.id != null) expectedMessages.set(Number(msg.id), { ...msg });
      } else if (row.record_type === "claim" && row.event === "claimed_burst" && Array.isArray(row.message_ids)) {
        for (const id of row.message_ids as unknown[]) {
          expectedClaims.set(`${agent}:${Number(id)}`, { message_id: Number(id), agent_name: agent, status: "claimed" });
        }
      } else if (row.record_type === "claim" && row.event === "completed_burst" && Array.isArray(row.message_ids)) {
        for (const id of row.message_ids as unknown[]) {
          expectedClaims.set(`${agent}:${Number(id)}`, { message_id: Number(id), agent_name: agent, status: "completed" });
        }
      } else if (row.record_type === "claim" && row.event === "released_claim" && Array.isArray(row.message_ids)) {
        for (const id of row.message_ids as unknown[]) expectedClaims.delete(`${agent}:${Number(id)}`);
      }
    }
  }
  const actualMessages = await withBusyRetry(() => db.prepare("SELECT id, recipient, sender, layer, body, read_at, read_by FROM fleet_comms ORDER BY id ASC").all()) as any[];
  const actualClaims = await withBusyRetry(() => db.prepare("SELECT message_id, agent_name, status FROM fleet_comms_claims ORDER BY id ASC").all()) as any[];
  const actualMessageIds = new Set(actualMessages.map((row) => Number(row.id)));
  const expectedMessageIds = new Set(expectedMessages.keys());
  const actualClaimKeys = new Set(actualClaims.map((row) => `${row.agent_name}:${Number(row.message_id)}`));
  const expectedClaimKeys = new Set(expectedClaims.keys());
  const ok = [...expectedMessageIds].every((id) => actualMessageIds.has(id))
      && [...actualMessageIds].every((id) => expectedMessageIds.has(id))
      && [...expectedClaimKeys].every((key) => actualClaimKeys.has(key))
      && [...actualClaimKeys].every((key) => expectedClaimKeys.has(key));
  const missingMessageIds = [...expectedMessageIds].filter((id) => !actualMessageIds.has(id));
  const extraMessageIds = [...actualMessageIds].filter((id) => !expectedMessageIds.has(id));
  const missingClaims = [...expectedClaimKeys].filter((key) => !actualClaimKeys.has(key));
  const extraClaims = [...actualClaimKeys].filter((key) => !expectedClaimKeys.has(key));
  // Row-level content drift for messages present in both
  const messageContentDrift: string[] = [];
  const actualMessageMap = new Map(actualMessages.map((row) => [Number(row.id), row]));
  for (const [id, expected] of expectedMessages) {
    const actual = actualMessageMap.get(id);
    if (!actual) continue;
    const diffs: string[] = [];
    if (expected.sender !== actual.sender) diffs.push(`sender: ${expected.sender} vs ${actual.sender}`);
    if (expected.recipient !== actual.recipient) diffs.push(`recipient: ${expected.recipient} vs ${actual.recipient}`);
    if (expected.layer !== actual.layer) diffs.push(`layer: ${expected.layer} vs ${actual.layer}`);
    if ((expected.body ?? "").slice(0, 200) !== (actual.body ?? "").slice(0, 200)) diffs.push("body differs");
    if (diffs.length > 0) messageContentDrift.push(`msg:${id}: ${diffs.join(", ")}`);
  }
  // Row-level claim status drift
  const claimStatusDrift: string[] = [];
  const actualClaimMap = new Map(actualClaims.map((row) => [`${row.agent_name}:${Number(row.message_id)}`, row]));
  for (const [key, expected] of expectedClaims) {
    const actual = actualClaimMap.get(key);
    if (!actual) continue;
    if (expected.status !== actual.status) claimStatusDrift.push(`${key}: expected ${expected.status}, actual ${actual.status}`);
  }
  const issues = [
    missingMessageIds.length ? `missing message ids: ${missingMessageIds.join(",")}` : null,
    extraMessageIds.length ? `extra message ids: ${extraMessageIds.join(",")}` : null,
    missingClaims.length ? `missing claims: ${missingClaims.join(",")}` : null,
    extraClaims.length ? `extra claims: ${extraClaims.join(",")}` : null,
    ...messageContentDrift.map((d) => `message content drift: ${d}`),
    ...claimStatusDrift.map((d) => `claim status drift: ${d}`),
  ].filter(Boolean);
  const allOk = ok && messageContentDrift.length === 0 && claimStatusDrift.length === 0;
  console.log(JSON.stringify({
    ok: allOk,
    expected: { messages: expectedMessageIds.size, claims: expectedClaimKeys.size },
    actual: { messages: actualMessageIds.size, claims: actualClaimKeys.size },
    missing_message_ids: missingMessageIds,
    extra_message_ids: extraMessageIds,
    missing_claims: missingClaims,
    extra_claims: extraClaims,
    message_content_drift: messageContentDrift.length > 0 ? messageContentDrift : null,
    claim_status_drift: claimStatusDrift.length > 0 ? claimStatusDrift : null,
    issues,
    repair: allOk ? null : "agent-mail rebuild",
  }));
}

if (cmd === "send") {
  await withBusyRetry(() =>
    db.run(
      "INSERT INTO fleet_comms (recipient, layer, sender, body) VALUES (?, ?, ?, ?)",
      [arg1, arg2, sender, arg3],
    ),
  );
  const message = await withBusyRetry(() => db.prepare("SELECT * FROM fleet_comms WHERE id = last_insert_rowid()").get()) as FleetMessage | null;
  appendMailArtifact(arg1 || "unknown", {
    record_type: "message",
    event: "sent",
    message,
  });
} else if (cmd === "listen") {
  const subs = loadSubscriptions(sender);
  while (true) {
    const burst = await withBusyRetry(() => claimBurst(db, sender, 1, 0, undefined, subs));
    if (burst) {
      console.log(JSON.stringify(burst.primary));
      process.exit(0);
    }

    await sleep(1000);
  }
} else if (cmd === "listen-burst") {
  const maxMessages = Math.max(1, parseInt(arg1 || "6", 10) || 6);
  const windowSec = Math.max(0, parseInt(arg2 || "300", 10) || 300);
  const subs = loadSubscriptions(sender);

  while (true) {
    const burst = await withBusyRetry(() => claimBurst(db, sender, maxMessages, windowSec, undefined, subs));
    if (burst) {
      console.log(JSON.stringify(burst));
      process.exit(0);
    }

    await sleep(1000);
  }
} else if (cmd === "peek-burst") {
  const maxMessages = Math.max(1, parseInt(arg1 || "6", 10) || 6);
  const windowSec = Math.max(0, parseInt(arg2 || "300", 10) || 300);
  const burst = await withBusyRetry(() => peekBurst(db, sender, maxMessages, windowSec, loadSubscriptions(sender)));
  console.log(JSON.stringify(burst));
} else if (cmd === "claim-burst") {
  const maxMessages = Math.max(1, parseInt(arg1 || "6", 10) || 6);
  const windowSec = Math.max(0, parseInt(arg2 || "300", 10) || 300);
  const primaryId = arg3 ? Math.max(1, parseInt(arg3, 10) || 0) : undefined;
  const burst = await withBusyRetry(() => claimBurst(db, sender, maxMessages, windowSec, primaryId, loadSubscriptions(sender)));
  if (burst) {
    appendMailArtifact(sender, {
      record_type: "claim",
      event: "claimed_burst",
      primary_id: burst.primary.id,
      message_ids: burst.messages.map((msg) => msg.id),
      layer: burst.primary.layer,
      sender: burst.primary.sender,
      merged_count: burst.mergedCount,
    });
  }
  console.log(JSON.stringify(burst));
} else if (cmd === "complete-burst") {
  const ids = Bun.argv.slice(4).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  await withBusyRetry(() => completeBurst(db, sender, ids));
  if (ids.length > 0) {
    appendMailArtifact(sender, {
      record_type: "claim",
      event: "completed_burst",
      message_ids: ids,
    });
  }
  console.log(JSON.stringify({ agent: sender, completed_ids: ids }));
} else if (cmd === "reclaim-stale") {
  const ttlMs = Math.max(30_000, parseInt(arg1 || process.env.FLEET_MAIL_CLAIM_TTL_MS || "300000", 10) || 300000);
  const reclaimed = await withBusyRetry(() => reclaimStaleClaims(db, sender, ttlMs));
  if (reclaimed.length > 0) {
    appendMailArtifact(sender, {
      record_type: "claim",
      event: "reclaim_stale",
      ttl_ms: ttlMs,
      reclaimed_claim_ids: reclaimed,
    });
  }
  console.log(JSON.stringify({ agent: sender, ttl_ms: ttlMs, reclaimed_claim_ids: reclaimed }));
} else if (cmd === "release-claim") {
  const ids = Bun.argv.slice(4).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const released = await withBusyRetry(() => releaseClaims(db, sender, ids));
  if (released.length > 0) {
    appendMailArtifact(sender, {
      record_type: "claim",
      event: "released_claim",
      message_ids: released,
    });
  }
  console.log(JSON.stringify({ agent: sender, released_message_ids: released }));
} else if (cmd === "claims") {
  const limit = Math.max(1, parseInt(arg1 || "20", 10) || 20);
  const rows = await withBusyRetry(() =>
    db.prepare(
      `SELECT claim.id, claim.message_id, claim.agent_name, claim.claimed_at, claim.completed_at, claim.status,
              comm.layer, comm.recipient, comm.sender, comm.body, comm.created_at
       FROM fleet_comms_claims claim
       JOIN fleet_comms comm ON comm.id = claim.message_id
       WHERE LOWER(claim.agent_name) = LOWER(?)
       ORDER BY claim.id DESC
       LIMIT ?`,
    ).all(sender, limit),
  );
  console.log(JSON.stringify(rows));
} else if (cmd === "rebuild") {
  await rebuildMail();
} else if (cmd === "verify") {
  await verifyMail();
} else if (cmd === "sql") {
  if (!arg1) {
    console.error("Usage: agent-mail sql <query> [param1] [param2]...");
    process.exit(64);
  }
  const params = Bun.argv.slice(4);
  try {
    const result = await withBusyRetry(() => db.prepare(arg1).all(...params));
    console.log(JSON.stringify(result));
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
} else if (cmd === "insert") {
  if (!arg1) {
    console.error("Usage: agent-mail insert <query> [param1] [param2]...");
    process.exit(64);
  }
  const params = Bun.argv.slice(4);
  try {
    await withBusyRetry(() => db.prepare(arg1).run(...params));
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
} else if (cmd === "tail") {
  if (!arg1) {
    console.error("Usage: agent-mail tail <layer>");
    process.exit(64);
  }

  let lastId =
    ((await withBusyRetry(() =>
      db.prepare("SELECT MAX(id) AS id FROM fleet_comms WHERE layer = ?").get(arg1),
    )) as { id: number | null } | undefined)?.id ?? 0;

  while (true) {
    const rows = (await withBusyRetry(() =>
      db
        .prepare("SELECT * FROM fleet_comms WHERE layer = ? AND id > ? ORDER BY id ASC")
        .all(arg1, lastId),
    )) as FleetMessage[];

    for (const row of rows) {
      console.log(formatMessage(row));
      lastId = row.id;
    }

    await sleep(1000);
  }
} else if (cmd === "skill") {
  console.log(SKILL);
} else {
  console.error(
    "Usage: agent-mail send <recipient> <layer> <message> | agent-mail listen | agent-mail listen-burst [limit] [windowSec] | agent-mail peek-burst [limit] [windowSec] | agent-mail claim-burst [limit] [windowSec] [primaryId] | agent-mail complete-burst <messageId...> | agent-mail reclaim-stale [ttlMs] | agent-mail release-claim <messageId...> | agent-mail claims [limit] | agent-mail rebuild | agent-mail verify | agent-mail tail <layer> | agent-mail skill",
  );
  process.exit(64);
}
