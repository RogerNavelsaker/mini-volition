import { join } from "path";
import { Database } from "bun:sqlite";
import { ensureDigestSchema, pollBurstEvents, deadLetterSweep } from "./core";
import { ensureMailSchema } from "../agent-mail/core";
import { ensureSchema as ensureMemorySchema } from "../agent-memory/schema";

const fleetDbPath = process.env.FLEET_DB || join(process.env.META_REPO_ROOT || ".", "runtime/fleet.db");
const mailDbPath = process.env.AGENT_MAIL_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-mail.db");
const memoryDbPath = process.env.AGENT_MEMORY_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-memory.db");
const digestDbPath = process.env.FLEET_DIGEST_DB || join(process.env.META_REPO_ROOT || ".", "runtime/fleet-digest.db");

const pollIntervalMs = Math.max(50, parseInt(process.env.FLEET_DIGEST_POLL_MS || "200", 10) || 200);
const deadLetterIntervalMs = Math.max(60_000, parseInt(process.env.FLEET_DIGEST_DEAD_LETTER_MS || "300000", 10) || 300000);
const deadLetterWindowMin = Math.max(1, parseInt(process.env.FLEET_DIGEST_DEAD_LETTER_WINDOW_MIN || "10", 10) || 10);

const SKILL = `---
name: fleet-digest
description: Reactive social digest — converts burst_flushed events into public_digests records
binary: fleet-digest
source: src/fleet-digest/main.ts
---

# Fleet Digest

Binary: \`fleet-digest\`
Source: \`src/fleet-digest/main.ts\`

Polls \`fleet_event_log\` for \`burst_flushed\` events and writes a \`public_digests\` record for each burst.
Dead-letter sweep every 5 minutes for completed bursts that were not signalled.
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const fleetDb = new Database(fleetDbPath);
const mailDb = new Database(mailDbPath);
const memoryDb = new Database(memoryDbPath);
const digestDb = new Database(digestDbPath);

for (const db of [fleetDb, mailDb, memoryDb, digestDb]) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

ensureMailSchema(mailDb);
ensureMemorySchema(memoryDb);
ensureDigestSchema(digestDb);

console.log(`[DIGEST] Started. poll_ms=${pollIntervalMs} dead_letter_ms=${deadLetterIntervalMs}`);

let lastDeadLetterAt = 0;

while (true) {
  try {
    pollBurstEvents(fleetDb, mailDb, memoryDb, digestDb);
  } catch (error) {
    console.error("[DIGEST] poll error:", error);
  }

  const now = Date.now();
  if (now - lastDeadLetterAt >= deadLetterIntervalMs) {
    try {
      const created = deadLetterSweep(mailDb, memoryDb, digestDb, deadLetterWindowMin);
      if (created > 0) console.log(`[DIGEST] dead-letter created ${created} digest(s)`);
    } catch (error) {
      console.error("[DIGEST] dead-letter error:", error);
    }
    lastDeadLetterAt = now;
  }

  await Bun.sleep(pollIntervalMs);
}
