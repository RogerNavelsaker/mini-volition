import { join } from "path";
import { Database } from "bun:sqlite";
import { ensureLibrarianSchema, knownAgents, maybeQueueExtraction, maybeQueueRepair, queueMaintenanceJob, recoverStaleMaintenanceJobs } from "./maintenance";

const stateDbPath = process.env.AGENT_STATE_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-state.db");
const memoryDbPath = process.env.AGENT_MEMORY_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-memory.db");
const jobsDbPath = process.env.AGENT_JOBS_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-jobs.db");
const librarianDbPath = process.env.FLEET_LIBRARIAN_DB || join(process.env.META_REPO_ROOT || ".", "runtime/fleet-librarian.db");
const stateDb = new Database(stateDbPath);
const memoryDb = new Database(memoryDbPath);
const jobsDb = new Database(jobsDbPath);
const librarianDb = new Database(librarianDbPath);
const jobsBin = process.env.AGENT_JOBS_BIN || "agent-jobs";
const loopSleepMs = Math.max(10_000, parseInt(process.env.FLEET_LIBRARIAN_INTERVAL_MS || "60000", 10) || 60000);
const repairErrorThreshold = Math.max(1, parseInt(process.env.FLEET_MEMORY_REPAIR_AFTER_ERRORS || "3", 10) || 3);
const staleClaimMs = Math.max(30_000, parseInt(process.env.FLEET_MAINTENANCE_STALE_CLAIM_MS || "300000", 10) || 300000);

const SKILL = `---
name: fleet-librarian
description: Background memory librarian for refresh, decay, repair, and curation
binary: fleet-librarian
source: src/fleet-librarian/main.ts
---

# Fleet Librarian

Binary: \`fleet-librarian\`
Source: \`src/fleet-librarian/main.ts\`

Runs background memory upkeep across agents so refresh, decay, repair, and later compaction stay off the turn path.
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

for (const db of [stateDb, memoryDb, jobsDb, librarianDb]) {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

async function main() {
  ensureLibrarianSchema(memoryDb, librarianDb);
  console.log(`[LIBRARIAN] Started. interval_ms=${loopSleepMs} repair_after_errors=${repairErrorThreshold} stale_claim_ms=${staleClaimMs}`);
  while (true) {
    const agents = knownAgents(stateDb);
    recoverStaleMaintenanceJobs(librarianDb, jobsBin, agents, staleClaimMs);
    for (const agent of agents) {
      queueMaintenanceJob(librarianDb, jobsDb, jobsBin, agent);
      maybeQueueExtraction(memoryDb, librarianDb, jobsDb, jobsBin, agent);
      maybeQueueRepair(memoryDb, librarianDb, jobsDb, jobsBin, agent, repairErrorThreshold);
    }
    await Bun.sleep(loopSleepMs);
  }
}

await main();
