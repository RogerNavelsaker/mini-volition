import { Database } from "bun:sqlite";
import { createConnection } from "net";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { relationForItemKinds, upsertMemoryLink, invalidateMemoryLinks, timelineQueryTokens } from "./links";
import { deriveFacts, invalidateMemoryFacts, upsertMemoryFact } from "./facts";
import { ensureSchema } from "./schema";
import { appendMemoryArtifact, appendMemorySourceArtifact } from "../state-artifacts/lib";
import type {
  ArtifactRow,
  CompactResponse,
  CurrentFactRow,
  DecomposeKeywordsResponse,
  EmbedResponse,
  ExtractEntitiesResponse,
  HydeResponse,
  LinkedLookupRow,
  MemoryKind,
  RecentInvalidationRow,
  RefreshStateRow,
  RerankResult,
  RetrievalMode,
  TimelineEvent,
  TraceRow,
} from "./types";

const dbPath = process.env.AGENT_MEMORY_DB || "runtime/agent-memory.db";
const db = new Database(dbPath);
const embedSocket = process.env.FLEET_EMBED_SOCKET || "runtime/embed.sock";
const e4bSocket = process.env.FLEET_E4B_SOCKET || "runtime/e4b.sock";
const rerankSocket = process.env.FLEET_RERANK_SOCKET || "runtime/rerank.sock";

const SKILL = `---
name: agent-memory
description: Async memory indexing and retrieval helper for fleet agents
binary: agent-memory
source: src/agent-memory/main.ts
---

# Agent Memory

Binary: \`agent-memory\`
Source: \`src/agent-memory/main.ts\`

Indexes promoted memory artifacts out of band and serves retrieval lookups for the harness.
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const [, , cmd, arg1, arg2] = Bun.argv;
const staleAfterSeconds = Math.max(30, parseInt(process.env.FLEET_MEMORY_STALE_AFTER_SEC || "900", 10) || 900);
const decayGraceDays = Math.max(0, parseInt(process.env.FLEET_MEMORY_DECAY_GRACE_DAYS || "7", 10) || 7);
const decayFloor = Math.max(0, Math.min(1, parseFloat(process.env.FLEET_MEMORY_DECAY_FLOOR || "0.1") || 0.1));
const rrfK = Math.max(1, parseInt(process.env.FLEET_MEMORY_RRF_K || "60", 10) || 60);

function usage(): never {
  console.error("Usage: agent-memory <refresh|repair|reinforce|decay|rebalance|compact|lookup|invalidate|timeline|status|rebuild|list|skill> ...");
  process.exit(64);
}

function stateDir(...parts: string[]) {
  return join(resolve(process.cwd(), process.env.FLEET_STATE_DIR || "state"), ...parts);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const IMPORTANCE_WEIGHTS: Record<string, number> = {
  critical: 0,
  high: 0.25,
  normal: 1.0,
  low: 2.0,
};

function clampStrength(value: number): number {
  return Math.max(decayFloor, Math.min(10, value));
}

function parseEmbedding(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => Number(value) || 0) : [];
  } catch {
    return [];
  }
}

function dotProduct(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < len; i += 1) total += (left[i] || 0) * (right[i] || 0);
  return total;
}

function reciprocalRankFuse(rank: number): number {
  return 1 / (rrfK + rank + 1);
}

function calculateDecayScore(daysSinceAccess: number, accessCount: number, importance: string): number {
  const weight = IMPORTANCE_WEIGHTS[importance] ?? IMPORTANCE_WEIGHTS.normal;
  if (weight === 0) return 1.0;
  if (daysSinceAccess <= decayGraceDays) return 1.0;

  const effectiveDays = daysSinceAccess - decayGraceDays;
  const accessBuffer = Math.log2(Math.max(accessCount, 1) + 1);
  const decayRate = weight * 0.05;
  const score = accessBuffer / (accessBuffer + decayRate * effectiveDays);
  return Math.max(score, 0);
}

function classifyImportance(kind: MemoryKind): string {
  if (kind === "archival") return "high";
  if (kind === "episodic") return "normal";
  return "low";
}

function recommendedImportance(kind: MemoryKind, recallCount: number, strength: number, decayScore: number): string {
  if (kind === "archival" && recallCount >= 6 && strength >= 3 && decayScore >= 0.9) return "critical";
  if ((kind === "archival" && recallCount >= 3) || strength >= 2.5 || decayScore >= 0.85) return "high";
  if (recallCount <= 1 && strength <= 0.6 && decayScore <= 0.4) return "low";
  return kind === "digest" ? "low" : "normal";
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${hash >>> 0}`;
}

function requestEmbed(texts: string[]): Promise<EmbedResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(embedSocket);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Inference timeout"))), 10000);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "embed", texts })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      finish(() => {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.error) reject(new Error(String(parsed.error)));
          else resolve(parsed as EmbedResponse);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () => {
      if (!settled) finish(() => reject(new Error("Inference socket closed before responding")));
    });
  });
}

type RerankResult = { index: number; text: string; score: number };

function requestRerank(query: string, passages: string[]): Promise<RerankResult[] | null> {
  return new Promise((resolve) => {
    const socket = createConnection(rerankSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: RerankResult[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "rerank", query, passages, top_k: passages.length })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        if (parsed?.error) finish(null);
        else finish(Array.isArray(parsed?.results) ? parsed.results : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function requestExtractEntities(text: string): Promise<ExtractEntitiesResponse | null> {
  return new Promise((resolve) => {
    const socket = createConnection(e4bSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: ExtractEntitiesResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 15000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "extract_entities", text: text.slice(0, 2400) })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        if (parsed?.error) finish(null);
        else finish(parsed as ExtractEntitiesResponse);
      } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function requestHyde(query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createConnection(e4bSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 12000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "hyde", query: query.slice(0, 1200) })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        if (parsed?.error) finish(null);
        else finish(typeof parsed?.hypothesis === "string" ? parsed.hypothesis : null);
      } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

const e2bSocket = process.env.FLEET_E2B_SOCKET || "runtime/e2b.sock";

function requestDecomposeKeywords(text: string): Promise<DecomposeKeywordsResponse | null> {
  return new Promise((resolve) => {
    const socket = createConnection(e2bSocket);
    let buffer = "";
    let settled = false;
    const finish = (value: DecomposeKeywordsResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "decompose_keywords", text: text.slice(0, 1800) })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline).trim());
        if (parsed?.error) finish(null);
        else if (Array.isArray(parsed?.high_level) && Array.isArray(parsed?.low_level)) finish(parsed as DecomposeKeywordsResponse);
        else finish(null);
      } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => finish(null));
  });
}

function upsertSearchIndex(
  recordKind: string,
  recordId: number,
  agentName: string | null,
  sourceKind: MemoryKind,
  content: string,
  embedding: number[] | null,
) {
  db.run(
    `INSERT INTO agent_memory_search_index (record_kind, record_id, agent_name, source_kind, content, embedding_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(record_kind, record_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       source_kind = excluded.source_kind,
       content = excluded.content,
       embedding_json = excluded.embedding_json,
       updated_at = CURRENT_TIMESTAMP`,
    [recordKind, recordId, agentName, sourceKind, content, embedding ? JSON.stringify(embedding) : null],
  );
  const searchRow = db.prepare(
    "SELECT id FROM agent_memory_search_index WHERE record_kind = ? AND record_id = ?",
  ).get(recordKind, recordId) as { id: number } | null;
  if (searchRow?.id) {
    db.run(
      "INSERT OR REPLACE INTO agent_memory_search_fts(rowid, content, source_kind, record_kind, record_id, agent_name) VALUES (?, ?, ?, ?, ?, ?)",
      [searchRow.id, content, sourceKind, recordKind, recordId, agentName],
    );
  }
}

function snapshotArtifact(id: number) {
  return db.prepare("SELECT * FROM agent_memory_artifacts WHERE id = ?").get(id) as Record<string, unknown> | null;
}

function snapshotRefreshState(agentName: string) {
  return db.prepare("SELECT * FROM agent_memory_refresh_state WHERE agent_name = ?").get(agentName) as Record<string, unknown> | null;
}

function snapshotCompaction(id: number) {
  return db.prepare("SELECT * FROM agent_memory_compactions WHERE id = ?").get(id) as Record<string, unknown> | null;
}

function snapshotCompactionItem(id: number) {
  return db.prepare("SELECT * FROM agent_memory_compaction_items WHERE id = ?").get(id) as Record<string, unknown> | null;
}

function snapshotFact(id: number) {
  return db.prepare("SELECT * FROM agent_memory_facts WHERE id = ?").get(id) as Record<string, unknown> | null;
}

function snapshotLink(id: number) {
  return db.prepare("SELECT * FROM agent_memory_links WHERE id = ?").get(id) as Record<string, unknown> | null;
}

function requestCompact(entries: string[], goal: string): Promise<CompactResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(e4bSocket);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Inference timeout"))), 15000);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "compact", entries, goal })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      finish(() => {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.error) reject(new Error(String(parsed.error)));
          else resolve(parsed as CompactResponse);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("end", () => {
      if (!settled) finish(() => reject(new Error("Inference socket closed before responding")));
    });
  });
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
}

function overlapScore(query: string, content: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  let matches = 0;
  for (const token of tokenize(content)) {
    if (q.has(token)) matches += 1;
  }
  return matches / q.size;
}

function appendInvalidatedRelations(agentName: string, query: string, relationPrefix: string | null = null) {
  const rows = relationPrefix
    ? db.prepare(
        `SELECT * FROM agent_memory_links
         WHERE agent_name = ?
           AND relation LIKE ?
           AND valid_to IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 32`,
      ).all(agentName, `${relationPrefix}%`)
    : db.prepare(
        `SELECT * FROM agent_memory_links
         WHERE agent_name = ?
           AND valid_to IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 32`,
      ).all(agentName);
  for (const row of rows as Array<{ evidence?: string | null } & Record<string, unknown>>) {
    if (query && row.evidence && !String(row.evidence).includes(query)) continue;
    appendMemoryArtifact(agentName, {
      record_type: "link",
      event: "invalidate",
      link: row,
    });
  }
}

function appendInvalidatedFacts(agentName: string, query: string) {
  const rows = db.prepare(
    `SELECT * FROM agent_memory_facts
     WHERE agent_name = ?
       AND valid_to IS NOT NULL
       AND (
         subject LIKE ?
         OR predicate LIKE ?
         OR object LIKE ?
         OR evidence LIKE ?
       )
     ORDER BY updated_at DESC
     LIMIT 32`,
  ).all(agentName, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  for (const row of rows as Array<Record<string, unknown>>) {
    appendMemoryArtifact(agentName, {
      record_type: "fact",
      event: "invalidate",
      fact: row,
    });
  }
}


async function refresh(agentName: string) {
  const digestRows = db.prepare(
    `SELECT id, summary AS content
     FROM public_digests
     ORDER BY id DESC
     LIMIT 24`,
  ).all() as Array<{ id: number; content: string }>;
  const episodicRows = db.prepare(
    `SELECT id, summary AS content
     FROM tier2_episodic
     WHERE agent_name = ?
     ORDER BY id DESC
     LIMIT 24`,
  ).all(agentName) as Array<{ id: number; content: string }>;
  const archivalRows = db.prepare(
    `SELECT id, reflection AS content
     FROM tier3_archival
     WHERE agent_name = ?
     ORDER BY id DESC
     LIMIT 24`,
  ).all(agentName) as Array<{ id: number; content: string }>;

  const candidates = [
    ...digestRows.map((row) => ({ agent_name: null as string | null, source_kind: "digest" as MemoryKind, source_table: "public_digests", source_id: row.id, content: row.content })),
    ...episodicRows.map((row) => ({ agent_name: agentName, source_kind: "episodic" as MemoryKind, source_table: "tier2_episodic", source_id: row.id, content: row.content })),
    ...archivalRows.map((row) => ({ agent_name: agentName, source_kind: "archival" as MemoryKind, source_table: "tier3_archival", source_id: row.id, content: row.content })),
  ]
    .map((row) => ({ ...row, content: row.content.replace(/\s+/g, " ").trim(), content_hash: hashText(row.content.replace(/\s+/g, " ").trim()) }))
    .filter((row) => row.content.length > 0);

  const stale = candidates.filter((candidate) => {
    const existing = db.prepare("SELECT content_hash FROM agent_memory_artifacts WHERE source_table = ? AND source_id = ?").get(candidate.source_table, candidate.source_id) as { content_hash?: string } | null;
    return existing?.content_hash !== candidate.content_hash;
  });

  if (stale.length === 0) {
    db.run(
      `INSERT INTO agent_memory_refresh_state (agent_name, last_refresh_at, last_status, last_error, artifact_count, source, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, 'ready', NULL, ?, 'cache', CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name) DO UPDATE SET
         last_refresh_at = CURRENT_TIMESTAMP,
         last_status = 'ready',
         last_error = NULL,
         artifact_count = excluded.artifact_count,
         source = 'cache',
         error_streak = 0,
         updated_at = CURRENT_TIMESTAMP`,
      [agentName, candidates.length],
    );
    console.log(JSON.stringify({ refreshed: 0, source: "cache", artifact_count: candidates.length }));
    return;
  }

  try {
    const embed = await requestEmbed(stale.map((entry) => entry.content.slice(0, 1200)));
    for (const [index, entry] of stale.entries()) {
      db.run(
        `INSERT INTO agent_memory_artifacts
         (agent_name, source_kind, source_table, source_id, content, content_hash, embedding_json, embedding_model, importance, strength, decay_score, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT strength FROM agent_memory_artifacts WHERE source_table = ? AND source_id = ?), 1.0), COALESCE((SELECT decay_score FROM agent_memory_artifacts WHERE source_table = ? AND source_id = ?), 1.0), COALESCE((SELECT status FROM agent_memory_artifacts WHERE source_table = ? AND source_id = ?), 'active'), CURRENT_TIMESTAMP)
         ON CONFLICT(source_table, source_id) DO UPDATE SET
           agent_name = excluded.agent_name,
           source_kind = excluded.source_kind,
           content = excluded.content,
           content_hash = excluded.content_hash,
           embedding_json = excluded.embedding_json,
           embedding_model = excluded.embedding_model,
           importance = excluded.importance,
            updated_at = CURRENT_TIMESTAMP`,
        [
          entry.agent_name,
          entry.source_kind,
          entry.source_table,
          entry.source_id,
          entry.content,
          entry.content_hash,
          JSON.stringify(embed.embeddings[index] ?? []),
          embed.source,
          classifyImportance(entry.source_kind),
          entry.source_table,
          entry.source_id,
          entry.source_table,
          entry.source_id,
          entry.source_table,
          entry.source_id,
        ],
      );
      const artifactId = db.prepare("SELECT id FROM agent_memory_artifacts WHERE source_table = ? AND source_id = ?").get(entry.source_table, entry.source_id) as { id: number } | null;
      if (artifactId?.id) {
        db.run("INSERT OR REPLACE INTO agent_memory_fts(rowid, content, source_kind) VALUES (?, ?, ?)", [artifactId.id, entry.content, entry.source_kind]);
        upsertSearchIndex("artifact", artifactId.id, entry.agent_name, entry.source_kind, entry.content, embed.embeddings[index] ?? []);
        appendMemoryArtifact(agentName, {
          record_type: "artifact",
          event: "upsert",
          artifact: snapshotArtifact(artifactId.id),
        });
      }
    }
    db.run(
      `INSERT INTO agent_memory_refresh_state (agent_name, last_refresh_at, last_status, last_error, artifact_count, source, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, 'ready', NULL, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name) DO UPDATE SET
         last_refresh_at = CURRENT_TIMESTAMP,
         last_status = 'ready',
         last_error = NULL,
         artifact_count = excluded.artifact_count,
         source = excluded.source,
         error_streak = 0,
         updated_at = CURRENT_TIMESTAMP`,
      [agentName, candidates.length, embed.source],
    );
    appendMemoryArtifact(agentName, {
      record_type: "refresh_state",
      event: "ready",
      refresh_state: snapshotRefreshState(agentName),
    });
    console.log(JSON.stringify({ refreshed: stale.length, source: embed.source, artifact_count: candidates.length }));
  } catch (error) {
    db.run(
      `INSERT INTO agent_memory_refresh_state (agent_name, last_refresh_at, last_status, last_error, artifact_count, source, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, 'error', ?, ?, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name) DO UPDATE SET
         last_refresh_at = CURRENT_TIMESTAMP,
         last_status = 'error',
         last_error = excluded.last_error,
         artifact_count = excluded.artifact_count,
         source = NULL,
         error_streak = COALESCE(agent_memory_refresh_state.error_streak, 0) + 1,
         updated_at = CURRENT_TIMESTAMP`,
      [agentName, error instanceof Error ? error.message : String(error), candidates.length],
    );
    appendMemoryArtifact(agentName, {
      record_type: "refresh_state",
      event: "error",
      refresh_state: snapshotRefreshState(agentName),
    });
    throw error;
  }
}

function reinforce(agentName: string, artifactIds: number[]) {
  const ids = [...new Set(artifactIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) {
    console.log(JSON.stringify({ reinforced: 0 }));
    return;
  }

  const placeholders = ids.map(() => "?").join(", ");
  const searchRows = db.prepare(
    `SELECT id, record_kind, record_id FROM agent_memory_search_index WHERE id IN (${placeholders}) AND (agent_name = ? OR agent_name IS NULL)`,
  ).all(...ids, agentName) as Array<{ id: number; record_kind: string; record_id: number }>;
  for (const row of searchRows) {
    if (row.record_kind === "artifact") {
      db.run(
        `UPDATE agent_memory_artifacts
         SET strength = MIN(10, strength + 1.0),
             recall_count = recall_count + 1,
             last_recalled_at = CURRENT_TIMESTAMP,
             decay_score = 1.0,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.record_id],
      );
      appendMemoryArtifact(agentName, {
        record_type: "artifact",
        event: "reinforce",
        artifact: snapshotArtifact(row.record_id),
      });
    } else if (row.record_kind === "compaction_item") {
      db.run(
        `UPDATE agent_memory_compaction_items
         SET strength = MIN(10, strength + 1.0),
             recall_count = recall_count + 1,
             last_recalled_at = CURRENT_TIMESTAMP,
             decay_score = 1.0,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.record_id],
      );
      appendMemoryArtifact(agentName, {
        record_type: "compaction_item",
        event: "reinforce",
        item: snapshotCompactionItem(row.record_id),
      });
    }
  }
  console.log(JSON.stringify({ reinforced: ids.length }));
}

function decay(agentName: string) {
  const rows = db.prepare(
    `SELECT id, strength, importance, recall_count, last_recalled_at, updated_at
     FROM agent_memory_artifacts
     WHERE (agent_name = ? OR agent_name IS NULL) AND status != 'deleted'`,
  ).all(agentName) as Array<{ id: number; strength: number; importance: string; recall_count: number; last_recalled_at: string | null; updated_at: string }>;

  let decayed = 0;
  for (const row of rows) {
    const anchor = row.last_recalled_at || row.updated_at;
    const anchorMs = new Date(anchor.endsWith("Z") ? anchor : `${anchor}Z`).getTime();
    const ageDays = Math.max(0, (Date.now() - anchorMs) / (1000 * 60 * 60 * 24));
    const nextDecayScore = calculateDecayScore(ageDays, row.recall_count, row.importance);
    const nextStrength = clampStrength(Math.max(nextDecayScore, row.strength * nextDecayScore));
    const nextStatus = nextDecayScore <= decayFloor ? "decayed" : "active";
    if (Math.abs(nextStrength - row.strength) < 0.001 && nextStatus === "active") continue;
    db.run(
      `UPDATE agent_memory_artifacts
       SET strength = ?, decay_score = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextStrength, nextDecayScore, nextStatus, row.id],
    );
    appendMemoryArtifact(agentName, {
      record_type: "artifact",
      event: "decay",
      artifact: snapshotArtifact(row.id),
    });
    decayed += 1;
  }

  const compactionItems = db.prepare(
    `SELECT id, strength, recall_count, last_recalled_at, updated_at
     FROM agent_memory_compaction_items
     WHERE agent_name = ? AND status != 'deleted'`,
  ).all(agentName) as Array<{ id: number; strength: number; recall_count: number; last_recalled_at: string | null; updated_at: string }>;
  for (const row of compactionItems) {
    const anchor = row.last_recalled_at || row.updated_at;
    const anchorMs = new Date(anchor.endsWith("Z") ? anchor : `${anchor}Z`).getTime();
    const ageDays = Math.max(0, (Date.now() - anchorMs) / (1000 * 60 * 60 * 24));
    const nextDecayScore = calculateDecayScore(ageDays, row.recall_count, "high");
    const nextStrength = clampStrength(Math.max(nextDecayScore, row.strength * nextDecayScore));
    const nextStatus = nextDecayScore <= decayFloor ? "decayed" : "active";
    db.run(
      `UPDATE agent_memory_compaction_items
       SET strength = ?, decay_score = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextStrength, nextDecayScore, nextStatus, row.id],
    );
    appendMemoryArtifact(agentName, {
      record_type: "compaction_item",
      event: "decay",
      item: snapshotCompactionItem(row.id),
    });
    decayed += 1;
  }
  console.log(JSON.stringify({ decayed, grace_days: decayGraceDays, decay_floor: decayFloor }));
}

function rebalance(agentName: string) {
  const rows = db.prepare(
    `SELECT id, source_kind, importance, strength, recall_count, decay_score
     FROM agent_memory_artifacts
     WHERE agent_name = ? OR agent_name IS NULL`,
  ).all(agentName) as Array<{
    id: number;
    source_kind: MemoryKind;
    importance: string;
    strength: number;
    recall_count: number;
    decay_score: number;
  }>;

  let updated = 0;
  for (const row of rows) {
    const nextImportance = recommendedImportance(
      row.source_kind,
      row.recall_count ?? 0,
      row.strength ?? 1,
      row.decay_score ?? 1,
    );
    if (nextImportance === row.importance) continue;
    db.run(
      `UPDATE agent_memory_artifacts
       SET importance = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextImportance, row.id],
    );
    appendMemoryArtifact(agentName, {
      record_type: "artifact",
      event: "rebalance",
      artifact: snapshotArtifact(row.id),
    });
    updated += 1;
  }

  console.log(JSON.stringify({ rebalanced: updated }));
}

async function compact(agentName: string) {
  const candidates = db.prepare(
    `SELECT id, source_kind, content, importance, strength, recall_count, decay_score
     FROM agent_memory_artifacts
     WHERE (agent_name = ? OR agent_name IS NULL)
       AND status = 'active'
       AND source_kind IN ('digest', 'episodic')
     ORDER BY importance DESC, recall_count DESC, strength DESC, decay_score DESC
     LIMIT 12`,
  ).all(agentName) as Array<{
    id: number;
    source_kind: MemoryKind;
    content: string;
    importance: string;
    strength: number;
    recall_count: number;
    decay_score: number;
  }>;

  const selected = candidates
    .filter((row) => (row.recall_count ?? 0) >= 2 || (row.strength ?? 0) >= 2 || row.importance === "high" || row.importance === "critical")
    .slice(0, 6);

  if (selected.length < 3) {
    console.log(JSON.stringify({ compacted: 0, reason: "not-enough-reinforced-candidates" }));
    return;
  }

  const signature = hashText(selected.map((row) => row.id).sort((a, b) => a - b).join(","));
  const existing = db.prepare("SELECT id FROM agent_memory_compactions WHERE agent_name = ? AND signature = ?").get(agentName, signature) as { id: number } | null;
  if (existing) {
    console.log(JSON.stringify({ compacted: 0, reason: "already-compacted", compaction_id: existing.id }));
    return;
  }

  const compacted = await requestCompact(
    selected.map((row) => row.content.slice(0, 400)),
    `Distill durable lessons for agent ${agentName}. Prefer stable patterns and decisions over transient status.`,
  );
  const archivalSummary = [
    compacted.summary,
    ...compacted.lessons.map((entry) => `Lesson: ${entry}`),
    ...compacted.facts.map((entry) => `Fact: ${entry}`),
    ...compacted.decisions.map((entry) => `Decision: ${entry}`),
    ...compacted.patterns.map((entry) => `Pattern: ${entry}`),
    ...compacted.open_risks.map((entry) => `Risk: ${entry}`),
  ].filter(Boolean).join(" ");
  const structured = JSON.stringify({
    summary: compacted.summary,
    lessons: compacted.lessons,
    facts: compacted.facts,
    decisions: compacted.decisions,
    patterns: compacted.patterns,
    open_risks: compacted.open_risks,
  });
  const taskId = `memory-compact:${signature}`;
  db.run(
    `INSERT INTO tier3_archival (agent_name, task_id, result, reflection, timestamp)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [agentName, taskId, structured, archivalSummary],
  );
  appendMemorySourceArtifact("archival", agentName, {
    record_type: "tier3_archival",
    agent_name: agentName,
    task_id: taskId,
    result: structured,
    reflection: archivalSummary,
  });
  db.run(
    `INSERT INTO agent_memory_compactions (agent_name, source_artifact_ids, signature, summary, structured_json, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [agentName, selected.map((row) => row.id).join(","), signature, archivalSummary, structured, compacted.source],
  );
  const compactionId = db.prepare(
    "SELECT id FROM agent_memory_compactions WHERE agent_name = ? AND signature = ?",
  ).get(agentName, signature) as { id: number } | null;
  if (compactionId?.id) {
    appendMemoryArtifact(agentName, {
      record_type: "compaction",
      event: "created",
      compaction: snapshotCompaction(compactionId.id),
    });
  }
  const itemSpecs = [
    ...compacted.lessons.map((content) => ({ kind: "lesson", content })),
    ...compacted.facts.map((content) => ({ kind: "fact", content })),
    ...compacted.decisions.map((content) => ({ kind: "decision", content })),
    ...compacted.patterns.map((content) => ({ kind: "pattern", content })),
    ...compacted.open_risks.map((content) => ({ kind: "open_risk", content })),
  ];
  if (compactionId?.id && itemSpecs.length) {
    const embed = await requestEmbed(itemSpecs.map((item) => item.content.slice(0, 300)));
    const createdItems: Array<{ id: number; item_kind: string; content: string }> = [];
    for (const [index, item] of itemSpecs.entries()) {
      db.run(
        `INSERT INTO agent_memory_compaction_items
         (compaction_id, agent_name, item_kind, content, strength, recall_count, decay_score, status, updated_at)
         VALUES (?, ?, ?, ?, 1.0, 0, 1.0, 'active', CURRENT_TIMESTAMP)`,
        [compactionId.id, agentName, item.kind, item.content],
      );
      const itemId = db.prepare("SELECT id FROM agent_memory_compaction_items WHERE compaction_id = ? ORDER BY id DESC LIMIT 1").get(compactionId.id) as { id: number } | null;
      if (itemId?.id) {
        upsertSearchIndex("compaction_item", itemId.id, agentName, "archival", `${item.kind}: ${item.content}`, embed.embeddings[index] ?? []);
        createdItems.push({ id: itemId.id, item_kind: item.kind, content: item.content });
        appendMemoryArtifact(agentName, {
          record_type: "compaction_item",
          event: "created",
          item: snapshotCompactionItem(itemId.id),
        });
      }
    }
    // Embed link evidence and upsert links into search index for semantic link discovery
    const linkEvidences: Array<{ fromId: number; toId: number; relation: string; evidence: string }> = [];
    for (const from of createdItems) {
      for (const to of createdItems) {
        if (from.id === to.id) continue;
        const relation = relationForItemKinds(from.item_kind, to.item_kind);
        const evidence = `compaction:${compactionId.id}`;
        upsertMemoryLink(db, agentName, from.id, to.id, relation, 0.65, evidence);
        const linkRow = db.prepare(
          `SELECT id FROM agent_memory_links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?`,
        ).get(from.id, to.id, relation) as { id: number } | null;
        if (linkRow?.id) {
          linkEvidences.push({ fromId: from.id, toId: to.id, relation, evidence: `${relation}: ${from.content.slice(0, 200)} → ${to.content.slice(0, 200)}` });
          appendMemoryArtifact(agentName, {
            record_type: "link",
            event: "upsert",
            link: snapshotLink(linkRow.id),
          });
        }
      }
    }
    // Batch-embed link evidence for semantic link retrieval
    if (linkEvidences.length > 0) {
      try {
        const linkEmbed = await requestEmbed(linkEvidences.map((le) => le.evidence.slice(0, 600)));
        for (const [i, le] of linkEvidences.entries()) {
          const linkRow = db.prepare(
            `SELECT id FROM agent_memory_links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?`,
          ).get(le.fromId, le.toId, le.relation) as { id: number } | null;
          if (linkRow?.id) {
            upsertSearchIndex("link", linkRow.id, agentName, "archival", le.evidence, linkEmbed.embeddings[i] ?? []);
          }
        }
      } catch {}
    }
    // Extract entities via LLM (fleet-e4b), fall back to regex deriveFacts
    const createdByKind = new Map(createdItems.map((item) => [`${item.item_kind}:${item.content}`, item.id]));
    const extractionText = createdItems.map((item) => `${item.item_kind}: ${item.content}`).join("\n");
    const extracted = await requestExtractEntities(extractionText);
    const derivedFacts = extracted?.entities?.length
      ? extracted.entities.map((e) => ({ subject: e.subject, predicate: e.predicate, object: e.object, evidence: e.description || `${e.subject} ${e.predicate} ${e.object}` }))
      : deriveFacts(agentName, compacted.facts, compacted.decisions);
    for (const fact of derivedFacts) {
      // For LLM-extracted entities, find best matching source item; for regex, use original evidence key
      let sourceItemId: number | undefined;
      if (extracted?.entities?.length) {
        const bestMatch = createdItems.find((item) =>
          item.content.includes(fact.subject) || item.content.includes(fact.object),
        );
        sourceItemId = bestMatch?.id;
      } else {
        const sourceKey = compacted.facts.includes(fact.evidence) ? `fact:${fact.evidence}` : `decision:${fact.evidence}`;
        sourceItemId = createdByKind.get(sourceKey);
      }
      if (!sourceItemId) continue;
      upsertMemoryFact(db, agentName, sourceItemId, fact);
      const factText = `${fact.subject} ${fact.predicate} ${fact.object}`;
      const factId = db.prepare(
        `SELECT id FROM agent_memory_facts
         WHERE agent_name = ? AND source_item_id = ? AND subject = ? AND predicate = ? AND object = ?`,
      ).get(agentName, sourceItemId, fact.subject, fact.predicate, fact.object) as { id: number } | null;
      if (factId?.id) {
        upsertSearchIndex("fact", factId.id, agentName, "archival", factText, null);
        appendMemoryArtifact(agentName, {
          record_type: "fact",
          event: "upsert",
          fact: snapshotFact(factId.id),
        });
      }
    }
    const existingItems = db.prepare(
      `SELECT id, item_kind, content
       FROM agent_memory_compaction_items
       WHERE agent_name = ? AND compaction_id != ?`,
    ).all(agentName, compactionId.id) as Array<{ id: number; item_kind: string; content: string }>;
    const newItems = db.prepare(
      `SELECT id, item_kind, content
       FROM agent_memory_compaction_items
       WHERE compaction_id = ?`,
    ).all(compactionId.id) as Array<{ id: number; item_kind: string; content: string }>;
    for (const item of newItems) {
      for (const other of existingItems) {
        const overlap = overlapScore(item.content, other.content);
        if (overlap < 0.45) continue;
        upsertMemoryLink(
          db,
          agentName,
          item.id,
          other.id,
          relationForItemKinds(item.item_kind, other.item_kind),
          overlap,
          `overlap=${overlap.toFixed(3)}`,
        );
        const linkRow = db.prepare(
          `SELECT id FROM agent_memory_links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?`,
        ).get(item.id, other.id, relationForItemKinds(item.item_kind, other.item_kind)) as { id: number } | null;
        if (linkRow?.id) {
          appendMemoryArtifact(agentName, {
            record_type: "link",
            event: "upsert",
            link: snapshotLink(linkRow.id),
          });
        }
      }
    }
  }

  console.log(JSON.stringify({ compacted: 1, source: compacted.source, signature }));
}

async function extractEntities(agentName: string) {
  // Find compaction items that have no associated facts yet
  const unextracted = db.prepare(
    `SELECT ci.id, ci.item_kind, ci.content, ci.compaction_id
     FROM agent_memory_compaction_items ci
     LEFT JOIN agent_memory_facts f ON f.source_item_id = ci.id AND f.agent_name = ci.agent_name
     WHERE ci.agent_name = ?
       AND ci.status = 'active'
       AND f.id IS NULL
     ORDER BY ci.id DESC
     LIMIT 24`,
  ).all(agentName) as Array<{ id: number; item_kind: string; content: string; compaction_id: number }>;
  if (unextracted.length === 0) {
    console.log(JSON.stringify({ extracted: 0, reason: "no-unextracted-items" }));
    return;
  }
  const text = unextracted.map((item) => `${item.item_kind}: ${item.content}`).join("\n");
  const result = await requestExtractEntities(text);
  if (!result?.entities?.length) {
    console.log(JSON.stringify({ extracted: 0, reason: "extraction-failed-or-empty" }));
    return;
  }
  let stored = 0;
  for (const entity of result.entities) {
    const bestMatch = unextracted.find((item) =>
      item.content.includes(entity.subject) || item.content.includes(entity.object),
    );
    if (!bestMatch) continue;
    upsertMemoryFact(db, agentName, bestMatch.id, {
      subject: entity.subject,
      predicate: entity.predicate,
      object: entity.object,
      evidence: entity.description || `${entity.subject} ${entity.predicate} ${entity.object}`,
    });
    const factText = `${entity.subject} ${entity.predicate} ${entity.object}`;
    const factId = db.prepare(
      `SELECT id FROM agent_memory_facts
       WHERE agent_name = ? AND source_item_id = ? AND subject = ? AND predicate = ? AND object = ?`,
    ).get(agentName, bestMatch.id, entity.subject, entity.predicate, entity.object) as { id: number } | null;
    if (factId?.id) {
      upsertSearchIndex("fact", factId.id, agentName, "archival", factText, null);
      appendMemoryArtifact(agentName, {
        record_type: "fact",
        event: "upsert",
        fact: snapshotFact(factId.id),
      });
      stored++;
    }
  }
  console.log(JSON.stringify({ extracted: stored, total_entities: result.entities.length, source: result.source }));
}

async function lookup(agentName: string, query: string, limit = 3, mode: RetrievalMode = "mix") {
  const rows = db.prepare(
    `SELECT si.id, si.record_kind, si.agent_name, si.source_kind, si.content, si.embedding_json,
            COALESCE(a.importance, 'high') AS importance,
            COALESCE(a.strength, ci.strength, 1.0) AS strength,
            COALESCE(a.recall_count, ci.recall_count, 0) AS recall_count,
            COALESCE(a.last_recalled_at, ci.last_recalled_at) AS last_recalled_at,
            COALESCE(a.decay_score, ci.decay_score, 1.0) AS decay_score,
            COALESCE(a.status, ci.status, CASE WHEN facts.valid_to IS NULL THEN 'active' ELSE 'decayed' END, 'active') AS status
     FROM agent_memory_search_index si
     LEFT JOIN agent_memory_artifacts a ON si.record_kind = 'artifact' AND si.record_id = a.id
     LEFT JOIN agent_memory_compaction_items ci ON si.record_kind = 'compaction_item' AND si.record_id = ci.id
     LEFT JOIN agent_memory_facts facts ON si.record_kind = 'fact' AND si.record_id = facts.id
     WHERE si.agent_name = ? OR si.agent_name IS NULL
     ORDER BY si.updated_at DESC
     LIMIT 160`,
  ).all(agentName) as ArtifactRow[];
  const refreshState = db.prepare("SELECT * FROM agent_memory_refresh_state WHERE agent_name = ?").get(agentName) as RefreshStateRow | null;
  const lastRefreshMs = refreshState?.last_refresh_at ? new Date(refreshState.last_refresh_at.endsWith("Z") ? refreshState.last_refresh_at : `${refreshState.last_refresh_at}Z`).getTime() : 0;
  const stale = !lastRefreshMs || (Date.now() - lastRefreshMs) > staleAfterSeconds * 1000;

  const activeRows = rows.filter((row) => row.status !== "deleted");
  // Primary FTS pass on literal query
  const ftsRows = db.prepare(
    `SELECT rowid AS id, bm25(agent_memory_search_fts) AS score
     FROM agent_memory_search_fts
     WHERE agent_memory_search_fts MATCH ?
     LIMIT 30`,
  ).all(query) as Array<{ id: number; score: number }>;
  // Dual keyword decomposition: extra FTS passes on HL/LL keywords when available
  let hlFtsRows: Array<{ id: number; score: number }> = [];
  let llFtsRows: Array<{ id: number; score: number }> = [];
  const decomposed = await requestDecomposeKeywords(query);
  if (decomposed) {
    for (const kw of decomposed.high_level.slice(0, 4)) {
      try {
        const rows = db.prepare(
          `SELECT rowid AS id, bm25(agent_memory_search_fts) AS score
           FROM agent_memory_search_fts
           WHERE agent_memory_search_fts MATCH ?
           LIMIT 10`,
        ).all(kw) as Array<{ id: number; score: number }>;
        hlFtsRows.push(...rows);
      } catch {}
    }
    for (const kw of decomposed.low_level.slice(0, 4)) {
      try {
        const rows = db.prepare(
          `SELECT rowid AS id, bm25(agent_memory_search_fts) AS score
           FROM agent_memory_search_fts
           WHERE agent_memory_search_fts MATCH ?
           LIMIT 10`,
        ).all(kw) as Array<{ id: number; score: number }>;
        llFtsRows.push(...rows);
      } catch {}
    }
  }
  const linkRows = db.prepare(
    `SELECT from_index.id AS from_search_id, to_index.id AS to_search_id, links.weight
     FROM agent_memory_links links
     JOIN agent_memory_search_index from_index
       ON from_index.record_kind IN ('compaction_item', 'link') AND from_index.record_id = links.from_item_id
     JOIN agent_memory_search_index to_index
       ON to_index.record_kind IN ('compaction_item', 'link') AND to_index.record_id = links.to_item_id
     WHERE links.agent_name = ?
       AND (links.valid_from IS NULL OR links.valid_from <= CURRENT_TIMESTAMP)
       AND (links.valid_to IS NULL OR links.valid_to > CURRENT_TIMESTAMP)`,
  ).all(agentName) as Array<{ from_search_id: number; to_search_id: number; weight: number }>;

  // HyDE: generate hypothetical answer doc, embed that for vector search; fall back to literal query
  let vectorRanking: Array<{ id: number; score: number }> = [];
  try {
    const hydeDoc = await requestHyde(query);
    const embedText = hydeDoc || query.slice(0, 1200);
    const embed = await requestEmbed([embedText.slice(0, 1200)]);
    const queryEmbedding = embed.embeddings[0] ?? [];
    vectorRanking = activeRows
      .map((row) => ({
        id: row.id,
        score: dotProduct(queryEmbedding, parseEmbedding(row.embedding_json)),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 30);
  } catch {}

  const fused = new Map<number, { score: number; topBonus: number }>();
  // Fuse primary FTS
  ftsRows
    .sort((left, right) => Math.abs(left.score) - Math.abs(right.score))
    .forEach((row, index) => {
      const current = fused.get(row.id) ?? { score: 0, topBonus: 0 };
      current.score += reciprocalRankFuse(index);
      if (index === 0) current.topBonus += 0.05;
      else if (index < 3) current.topBonus += 0.02;
      fused.set(row.id, current);
    });
  // Fuse HL keyword FTS (global/thematic) — weighted lower since these are supplementary
  hlFtsRows
    .sort((left, right) => Math.abs(left.score) - Math.abs(right.score))
    .forEach((row, index) => {
      const current = fused.get(row.id) ?? { score: 0, topBonus: 0 };
      current.score += reciprocalRankFuse(index) * 0.6;
      fused.set(row.id, current);
    });
  // Fuse LL keyword FTS (local/specific) — weighted for precision
  llFtsRows
    .sort((left, right) => Math.abs(left.score) - Math.abs(right.score))
    .forEach((row, index) => {
      const current = fused.get(row.id) ?? { score: 0, topBonus: 0 };
      current.score += reciprocalRankFuse(index) * 0.7;
      fused.set(row.id, current);
    });
  // Fuse vector ranking (now HyDE-enhanced when available)
  vectorRanking.forEach((row, index) => {
    const current = fused.get(row.id) ?? { score: 0, topBonus: 0 };
    current.score += reciprocalRankFuse(index);
    if (index === 0) current.topBonus += 0.05;
    else if (index < 3) current.topBonus += 0.02;
    fused.set(row.id, current);
  });
  for (const row of linkRows) {
    if (fused.has(row.from_search_id)) {
      const current = fused.get(row.to_search_id) ?? { score: 0, topBonus: 0 };
      current.score += Math.max(0, row.weight) * 0.08;
      fused.set(row.to_search_id, current);
    }
    if (fused.has(row.to_search_id)) {
      const current = fused.get(row.from_search_id) ?? { score: 0, topBonus: 0 };
      current.score += Math.max(0, row.weight) * 0.08;
      fused.set(row.from_search_id, current);
    }
  }

  const linkBoosts = new Map<number, number>();
  for (const row of linkRows) {
    if (fused.has(row.from_search_id)) {
      const boosted = (linkBoosts.get(row.to_search_id) ?? 0) + Math.max(0, row.weight) * 0.08;
      linkBoosts.set(row.to_search_id, boosted);
      const current = fused.get(row.to_search_id) ?? { score: 0, topBonus: 0 };
      current.score += Math.max(0, row.weight) * 0.08;
      fused.set(row.to_search_id, current);
    }
    if (fused.has(row.to_search_id)) {
      const boosted = (linkBoosts.get(row.from_search_id) ?? 0) + Math.max(0, row.weight) * 0.08;
      linkBoosts.set(row.from_search_id, boosted);
      const current = fused.get(row.from_search_id) ?? { score: 0, topBonus: 0 };
      current.score += Math.max(0, row.weight) * 0.08;
      fused.set(row.from_search_id, current);
    }
  }

  const ranked = activeRows
    .map((row) => {
      const fusedScore = fused.get(row.id);
      const lexicalScore = overlapScore(query, row.content);
      const decayScore = row.decay_score ?? 1;
      const linkBoost = linkBoosts.get(row.id) ?? 0;
      return {
        ...row,
        lexical_score: lexicalScore,
        fused_score: fusedScore?.score ?? 0,
        top_bonus: fusedScore?.topBonus ?? 0,
        link_boost: linkBoost,
        score: (fusedScore?.score ?? 0) + (fusedScore?.topBonus ?? 0) + lexicalScore * 0.1 + (row.strength ?? 1) * 0.03 + decayScore * 0.1,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);

  // Precision rerank top candidates via fleet-rerank when available
  let finalRanked = ranked;
  if (ranked.length > 5) {
    const rerankCandidates = ranked.slice(0, 20);
    const passages = rerankCandidates.map((row) => row.content.slice(0, 512));
    try {
      const rerankResults = await requestRerank(query.slice(0, 512), passages);
      if (rerankResults && rerankResults.length > 0) {
        const rerankedSet = new Set(rerankResults.map((r) => rerankCandidates[r.index]?.id).filter(Boolean));
        const rerankedRows = rerankResults.map((r) => rerankCandidates[r.index]).filter(Boolean);
        const remainder = ranked.filter((row) => !rerankedSet.has(row.id));
        finalRanked = [...rerankedRows, ...remainder];
      }
    } catch {}
  }

  const localRanked = finalRanked.filter((row) => row.record_kind === "compaction_item" || (row.link_boost ?? 0) > 0 || (row.lexical_score ?? 0) > 0.12);
  const globalRanked = finalRanked.filter((row) => row.source_kind === "digest" || row.source_kind === "episodic" || row.record_kind === "artifact");
  const selectedRanked = mode === "local"
    ? (localRanked.length ? localRanked : finalRanked)
    : mode === "global"
    ? (globalRanked.length ? globalRanked : finalRanked)
    : finalRanked;

  const digests = selectedRanked.filter((row) => row.source_kind === "digest").slice(0, limit).map((row) => ({ id: row.id, summary: row.content }));
  const episodic = selectedRanked.filter((row) => row.source_kind === "episodic").slice(0, limit).map((row) => ({ id: row.id, summary: row.content }));
  const archival = selectedRanked.filter((row) => row.source_kind === "archival").slice(0, limit).map((row) => ({ id: row.id, reflection: row.content }));
  const currentFacts = db.prepare(
    `SELECT id, subject, predicate, object, valid_from
     FROM agent_memory_facts
     WHERE agent_name = ?
       AND valid_to IS NULL
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  ).all(agentName, Math.max(limit * 2, 6)) as CurrentFactRow[];
  const recentInvalidations = [
    ...(db.prepare(
      `SELECT 'link' AS kind,
              links.relation AS relation,
              from_item.content AS from_content,
              to_item.content AS to_content,
              links.valid_to AS valid_to
       FROM agent_memory_links links
       JOIN agent_memory_compaction_items from_item ON from_item.id = links.from_item_id
       JOIN agent_memory_compaction_items to_item ON to_item.id = links.to_item_id
       WHERE links.agent_name = ?
         AND links.valid_to IS NOT NULL
       ORDER BY links.valid_to DESC
       LIMIT ?`,
    ).all(agentName, Math.max(limit, 4)) as Array<RecentInvalidationRow>),
    ...(db.prepare(
      `SELECT 'fact' AS kind,
              subject,
              predicate,
              object,
              valid_to
       FROM agent_memory_facts
       WHERE agent_name = ?
         AND valid_to IS NOT NULL
       ORDER BY valid_to DESC
       LIMIT ?`,
    ).all(agentName, Math.max(limit, 4)) as Array<RecentInvalidationRow>),
  ]
    .sort((left, right) => String(right.valid_to ?? "").localeCompare(String(left.valid_to ?? "")))
    .slice(0, Math.max(limit * 2, 6));
  const traces: TraceRow[] = selectedRanked.slice(0, Math.max(limit * 3, 8)).map((row) => ({
    id: row.id,
    record_kind: row.record_kind ?? "artifact",
    source_kind: row.source_kind,
    score: Number(row.score.toFixed(4)),
    fused_score: Number((row.fused_score ?? 0).toFixed(4)),
    top_bonus: Number((row.top_bonus ?? 0).toFixed(4)),
    lexical_score: Number((row.lexical_score ?? 0).toFixed(4)),
    link_boost: Number((row.link_boost ?? 0).toFixed(4)),
    strength: Number((row.strength ?? 1).toFixed(4)),
    decay_score: Number((row.decay_score ?? 1).toFixed(4)),
  }));
  const topCompactionTraceIds = traces
    .filter((row) => row.record_kind === "compaction_item")
    .slice(0, Math.max(limit, 2))
    .map((row) => row.id);
  let linkedArchival: LinkedLookupRow[] = [];
  if (topCompactionTraceIds.length) {
    const placeholders = topCompactionTraceIds.map(() => "?").join(", ");
    linkedArchival = db.prepare(
      `SELECT linked_index.id AS id,
              links.relation AS relation,
              MAX(links.weight) AS weight,
              linked_item.content AS reflection
       FROM agent_memory_search_index seed_index
       JOIN agent_memory_links links
         ON (
           (seed_index.record_id = links.from_item_id AND seed_index.record_kind = 'compaction_item')
           OR
           (seed_index.record_id = links.to_item_id AND seed_index.record_kind = 'compaction_item')
         )
       JOIN agent_memory_compaction_items linked_item
         ON linked_item.id = CASE
           WHEN seed_index.record_id = links.from_item_id THEN links.to_item_id
           ELSE links.from_item_id
         END
       JOIN agent_memory_search_index linked_index
         ON linked_index.record_kind = 'compaction_item' AND linked_index.record_id = linked_item.id
       WHERE seed_index.id IN (${placeholders})
         AND links.agent_name = ?
         AND (links.valid_from IS NULL OR links.valid_from <= CURRENT_TIMESTAMP)
         AND (links.valid_to IS NULL OR links.valid_to > CURRENT_TIMESTAMP)
         AND linked_index.id NOT IN (${placeholders})
         AND linked_item.status = 'active'
       GROUP BY linked_index.id, links.relation, linked_item.content
       ORDER BY weight DESC, linked_index.id DESC
       LIMIT ?`,
    ).all(...topCompactionTraceIds, agentName, ...topCompactionTraceIds, Math.max(limit * 2, 4)) as LinkedLookupRow[];
  }
  console.log(JSON.stringify({
    recentDigests: digests,
    episodic,
    archival,
    currentFacts,
    recentInvalidations,
    linkedArchival,
    traces,
    memorySelection: rows.length === 0
      ? "memory artifacts unavailable"
      : ranked.length === 0
      ? `memory artifacts available${stale ? " but stale" : ""}; ${mode} retrieval match empty`
      : `memory artifacts available${stale ? " but stale" : ""}; ${mode} fts+vector+link retrieval`,
    retrievalMode: mode,
    freshness: {
      stale,
      stale_after_seconds: staleAfterSeconds,
      last_refresh_at: refreshState?.last_refresh_at ?? null,
      last_status: refreshState?.last_status ?? null,
      last_error: refreshState?.last_error ?? null,
      artifact_count: refreshState?.artifact_count ?? rows.length,
      source: refreshState?.source ?? null,
    },
  }));
}

function invalidate(agentName: string, query: string, relationPrefix: string | null = null) {
  const tokens = timelineQueryTokens(query, tokenize);
  if (tokens.length === 0) {
    console.log(JSON.stringify({ invalidated: 0, reason: "empty-query" }));
    return;
  }
  const where = tokens.map(() => "content LIKE ?").join(" OR ");
  const tokenArgs = tokens.map((token) => `%${token}%`);
  const items = db.prepare(
    `SELECT id
     FROM agent_memory_compaction_items
     WHERE agent_name = ?
       AND status = 'active'
       AND (${where})
     ORDER BY updated_at DESC
     LIMIT 24`,
  ).all(agentName, ...tokenArgs) as Array<{ id: number }>;

  let invalidated = 0;
  for (const item of items) {
    const before = db.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_memory_links
       WHERE agent_name = ?
         AND (from_item_id = ? OR to_item_id = ?)
         AND valid_to IS NULL
         ${relationPrefix ? "AND relation LIKE ?" : ""}`,
    ).get(...(relationPrefix ? [agentName, item.id, item.id, `${relationPrefix}%`] : [agentName, item.id, item.id])) as { count: number };
    invalidateMemoryLinks(db, agentName, item.id, relationPrefix);
    appendInvalidatedRelations(agentName, query, relationPrefix);
    invalidated += before.count ?? 0;
  }
  invalidateMemoryFacts(db, agentName, query);
  appendInvalidatedFacts(agentName, query);

  console.log(JSON.stringify({ invalidated, items: items.length, relation_prefix: relationPrefix }));
}

function timeline(agentName: string, query: string, limit = 12) {
  const tokens = timelineQueryTokens(query, tokenize);
  if (tokens.length === 0) {
    console.log(JSON.stringify({ query, events: [] }));
    return;
  }
  const where = tokens.map(() => "ci.content LIKE ?").join(" OR ");
  const tokenArgs = tokens.map((token) => `%${token}%`);
  const seedItems = db.prepare(
    `SELECT ci.id, ci.item_kind, ci.content
     FROM agent_memory_compaction_items ci
     WHERE ci.agent_name = ?
       AND ci.status = 'active'
       AND (${where})
     ORDER BY ci.updated_at DESC
     LIMIT ?`,
  ).all(agentName, ...tokenArgs, Math.max(limit, 4)) as Array<{ id: number; item_kind: string; content: string }>;

  const seedIds = seedItems.map((row) => row.id);
  if (seedIds.length === 0) {
    console.log(JSON.stringify({ query, events: [] }));
    return;
  }

  const placeholders = seedIds.map(() => "?").join(", ");
  const events = db.prepare(
    `SELECT links.id,
            links.relation,
            links.weight,
            links.evidence,
            links.valid_from,
            links.valid_to,
            from_item.id AS from_id,
            from_item.item_kind AS from_kind,
            from_item.content AS from_content,
            to_item.id AS to_id,
            to_item.item_kind AS to_kind,
            to_item.content AS to_content
     FROM agent_memory_links links
     JOIN agent_memory_compaction_items from_item ON from_item.id = links.from_item_id
     JOIN agent_memory_compaction_items to_item ON to_item.id = links.to_item_id
     WHERE links.agent_name = ?
       AND (links.from_item_id IN (${placeholders}) OR links.to_item_id IN (${placeholders}))
     ORDER BY COALESCE(links.valid_from, links.created_at) DESC, links.id DESC
     LIMIT ?`,
  ).all(agentName, ...seedIds, ...seedIds, limit).map((row: any): TimelineEvent => ({
    id: row.id,
    relation: row.relation,
    weight: row.weight,
    evidence: row.evidence,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    from: { id: row.from_id, kind: row.from_kind, content: row.from_content },
    to: { id: row.to_id, kind: row.to_kind, content: row.to_content },
  }));

  console.log(JSON.stringify({ query, events }));
}

function rebuildMemory(agentName?: string) {
  const memoryRoot = stateDir("memory");
  const sourceRoot = stateDir("memory-source");
  const discoveredAgents = new Set<string>();
  if (!agentName) {
    if (existsSync(memoryRoot)) {
      for (const entry of readdirSync(memoryRoot, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) discoveredAgents.add(entry.name.replace(/\.jsonl$/, ""));
      }
    }
    for (const kind of ["working", "episodic", "archival"] as const) {
      const dir = join(sourceRoot, kind);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) discoveredAgents.add(entry.name.replace(/\.jsonl$/, ""));
      }
    }
  }
  const agents = agentName ? [agentName] : [...discoveredAgents];

  const summary: Array<Record<string, unknown>> = [];
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (agentName) {
      db.prepare("DELETE FROM tier1_working WHERE agent_name = ?").run(agentName);
      db.prepare("DELETE FROM tier2_episodic WHERE agent_name = ?").run(agentName);
      db.prepare("DELETE FROM tier3_archival WHERE agent_name = ?").run(agentName);
    } else {
      db.exec("DELETE FROM tier1_working;");
      db.exec("DELETE FROM tier2_episodic;");
      db.exec("DELETE FROM tier3_archival;");
    }
    db.exec("DELETE FROM public_digests;");
    db.exec("DELETE FROM agent_memory_search_fts;");
    db.exec("DELETE FROM agent_memory_search_index;");
    db.exec("DELETE FROM agent_memory_facts;");
    db.exec("DELETE FROM agent_memory_links;");
    db.exec("DELETE FROM agent_memory_compaction_items;");
    db.exec("DELETE FROM agent_memory_compactions;");
    db.exec("DELETE FROM agent_memory_artifacts;");
    if (agents.length > 0) {
      const placeholders = agents.map(() => "?").join(", ");
      db.prepare(`DELETE FROM agent_memory_refresh_state WHERE agent_name IN (${placeholders})`).run(...agents);
    } else {
      db.exec("DELETE FROM agent_memory_refresh_state;");
    }

    for (const name of agents) {
      const workingRows = readJsonl(stateDir("memory-source", "working", `${name}.jsonl`));
      const episodicRows = readJsonl(stateDir("memory-source", "episodic", `${name}.jsonl`));
      const archivalRows = readJsonl(stateDir("memory-source", "archival", `${name}.jsonl`));
      const rows = readJsonl(stateDir("memory", `${name}.jsonl`));
      const artifacts = new Map<number, any>();
      const refreshStates = new Map<string, any>();
      const compactions = new Map<number, any>();
      const compactionItems = new Map<number, any>();
      const links = new Map<number, any>();
      const facts = new Map<number, any>();

      const insertWorking = db.prepare(
        `INSERT INTO tier1_working (agent_name, role, content, timestamp)
         VALUES (?, ?, ?, ?)`,
      );
      for (const row of workingRows) {
        if (row.record_type !== "tier1_working") continue;
        insertWorking.run(name, row.role ?? "system", row.content ?? "", row.recorded_at ?? new Date().toISOString());
      }

      const insertEpisodic = db.prepare(
        `INSERT INTO tier2_episodic (agent_name, summary, duration_asleep, actors, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of episodicRows) {
        if (row.record_type !== "tier2_episodic") continue;
        insertEpisodic.run(
          name,
          row.summary ?? "",
          row.duration_asleep ?? 0,
          row.actors ?? "",
          row.recorded_at ?? new Date().toISOString(),
        );
      }

      const insertArchival = db.prepare(
        `INSERT INTO tier3_archival (agent_name, task_id, result, reflection, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of archivalRows) {
        if (row.record_type !== "tier3_archival") continue;
        insertArchival.run(
          name,
          row.task_id ?? "",
          row.result ?? "",
          row.reflection ?? "",
          row.recorded_at ?? new Date().toISOString(),
        );
      }

      for (const row of rows) {
        if (row.record_type === "artifact" && row.artifact && typeof row.artifact === "object") {
          const value = row.artifact as any;
          if (value.id != null) artifacts.set(Number(value.id), value);
        } else if (row.record_type === "refresh_state" && row.refresh_state && typeof row.refresh_state === "object") {
          const value = row.refresh_state as any;
          if (value.agent_name) refreshStates.set(String(value.agent_name), value);
        } else if (row.record_type === "compaction" && row.compaction && typeof row.compaction === "object") {
          const value = row.compaction as any;
          if (value.id != null) compactions.set(Number(value.id), value);
        } else if (row.record_type === "compaction_item" && row.item && typeof row.item === "object") {
          const value = row.item as any;
          if (value.id != null) compactionItems.set(Number(value.id), value);
        } else if (row.record_type === "link" && row.link && typeof row.link === "object") {
          const value = row.link as any;
          if (value.id != null) links.set(Number(value.id), value);
        } else if (row.record_type === "fact" && row.fact && typeof row.fact === "object") {
          const value = row.fact as any;
          if (value.id != null) facts.set(Number(value.id), value);
        }
      }

      const insertArtifact = db.prepare(
        `INSERT INTO agent_memory_artifacts (
           id, agent_name, source_kind, source_table, source_id, content, content_hash, embedding_json, embedding_model,
           importance, strength, recall_count, last_recalled_at, decay_score, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const artifact of [...artifacts.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insertArtifact.run(
          artifact.id, artifact.agent_name ?? null, artifact.source_kind, artifact.source_table, artifact.source_id,
          artifact.content, artifact.content_hash, artifact.embedding_json ?? null, artifact.embedding_model ?? null,
          artifact.importance ?? "normal", artifact.strength ?? 1.0, artifact.recall_count ?? 0,
          artifact.last_recalled_at ?? null, artifact.decay_score ?? 1.0, artifact.status ?? "active",
          artifact.created_at ?? artifact.updated_at ?? new Date().toISOString(),
          artifact.updated_at ?? artifact.created_at ?? new Date().toISOString(),
        );
        db.run("INSERT OR REPLACE INTO agent_memory_fts(rowid, content, source_kind) VALUES (?, ?, ?)", [artifact.id, artifact.content, artifact.source_kind]);
        upsertSearchIndex("artifact", artifact.id, artifact.agent_name ?? null, artifact.source_kind, artifact.content, parseEmbedding(artifact.embedding_json ?? null));
      }

      const insertRefresh = db.prepare(
        `INSERT INTO agent_memory_refresh_state (agent_name, last_refresh_at, last_status, last_error, artifact_count, source, error_streak, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const state of refreshStates.values()) {
        insertRefresh.run(
          state.agent_name, state.last_refresh_at ?? null, state.last_status ?? null, state.last_error ?? null,
          state.artifact_count ?? 0, state.source ?? null, state.error_streak ?? 0,
          state.updated_at ?? state.last_refresh_at ?? new Date().toISOString(),
        );
      }

      const insertCompaction = db.prepare(
        `INSERT INTO agent_memory_compactions (id, agent_name, source_artifact_ids, signature, summary, structured_json, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const compaction of [...compactions.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insertCompaction.run(
          compaction.id, compaction.agent_name, compaction.source_artifact_ids, compaction.signature,
          compaction.summary, compaction.structured_json ?? null, compaction.source ?? null,
          compaction.created_at ?? new Date().toISOString(),
        );
      }

      const insertItem = db.prepare(
        `INSERT INTO agent_memory_compaction_items (id, compaction_id, agent_name, item_kind, content, strength, recall_count, last_recalled_at, decay_score, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of [...compactionItems.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insertItem.run(
          item.id, item.compaction_id, item.agent_name, item.item_kind, item.content,
          item.strength ?? 1.0, item.recall_count ?? 0, item.last_recalled_at ?? null,
          item.decay_score ?? 1.0, item.status ?? "active",
          item.created_at ?? item.updated_at ?? new Date().toISOString(),
          item.updated_at ?? item.created_at ?? new Date().toISOString(),
        );
        upsertSearchIndex("compaction_item", item.id, item.agent_name, "archival", `${item.item_kind}: ${item.content}`, []);
      }

      const insertLink = db.prepare(
        `INSERT INTO agent_memory_links (id, agent_name, from_item_id, to_item_id, relation, weight, evidence, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const link of [...links.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insertLink.run(
          link.id, link.agent_name, link.from_item_id, link.to_item_id, link.relation, link.weight ?? 0.0,
          link.evidence ?? null, link.valid_from ?? null, link.valid_to ?? null,
          link.created_at ?? link.updated_at ?? new Date().toISOString(),
          link.updated_at ?? link.created_at ?? new Date().toISOString(),
        );
      }

      const insertFact = db.prepare(
        `INSERT INTO agent_memory_facts (id, agent_name, source_item_id, subject, predicate, object, evidence, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const fact of [...facts.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
        insertFact.run(
          fact.id, fact.agent_name, fact.source_item_id, fact.subject, fact.predicate, fact.object,
          fact.evidence ?? null, fact.valid_from ?? null, fact.valid_to ?? null,
          fact.created_at ?? fact.updated_at ?? new Date().toISOString(),
          fact.updated_at ?? fact.created_at ?? new Date().toISOString(),
        );
        upsertSearchIndex("fact", fact.id, fact.agent_name, "archival", `${fact.subject} ${fact.predicate} ${fact.object}`, []);
      }

      summary.push({
        agent: name,
        source_working: workingRows.length,
        source_episodic: episodicRows.length,
        source_archival: archivalRows.length,
        artifact_records: artifacts.size,
        refresh_records: refreshStates.size,
        compactions: compactions.size,
        compaction_items: compactionItems.size,
        links: links.size,
        facts: facts.size,
      });
    }

    const digestRows = readJsonl(stateDir("memory-source", "digests", "public.jsonl"));
    const insertDigest = db.prepare(
      `INSERT INTO public_digests (summary, actors, type, timestamp)
       VALUES (?, ?, ?, ?)`,
    );
    for (const row of digestRows) {
      if (row.record_type !== "public_digest") continue;
      insertDigest.run(
        row.summary ?? "",
        row.actors ?? "",
        row.type ?? "",
        row.recorded_at ?? new Date().toISOString(),
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  console.log(JSON.stringify({ rebuilt: summary, public_digests: readJsonl(stateDir("memory-source", "digests", "public.jsonl")).length }));
}

function verifyMemory(agentName?: string) {
  const sourceRoot = stateDir("memory-source");
  const memoryRoot = stateDir("memory");
  const discoveredAgents = new Set<string>();
  if (!agentName) {
    for (const root of [join(sourceRoot, "working"), join(sourceRoot, "episodic"), join(sourceRoot, "archival"), memoryRoot]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) discoveredAgents.add(entry.name.replace(/\.jsonl$/, ""));
      }
    }
  }
  const agents = agentName ? [agentName] : [...discoveredAgents];
  const verified = agents.map((name) => {
    const expectedWorking = readJsonl(stateDir("memory-source", "working", `${name}.jsonl`)).filter((row) => row.record_type === "tier1_working").length;
    const expectedEpisodic = readJsonl(stateDir("memory-source", "episodic", `${name}.jsonl`)).filter((row) => row.record_type === "tier2_episodic").length;
    const expectedArchival = readJsonl(stateDir("memory-source", "archival", `${name}.jsonl`)).filter((row) => row.record_type === "tier3_archival").length;
    const expectedDerived = readJsonl(stateDir("memory", `${name}.jsonl`));
    const expectedArtifacts = expectedDerived.filter((row) => row.record_type === "artifact").length;
    const expectedRefresh = expectedDerived.filter((row) => row.record_type === "refresh_state").length;
    const expectedCompactions = expectedDerived.filter((row) => row.record_type === "compaction").length;
    const expectedItems = expectedDerived.filter((row) => row.record_type === "compaction_item").length;
    const expectedLinks = expectedDerived.filter((row) => row.record_type === "link").length;
    const expectedFacts = expectedDerived.filter((row) => row.record_type === "fact").length;
    const actual = {
      working: Number((db.prepare("SELECT COUNT(*) AS count FROM tier1_working WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      episodic: Number((db.prepare("SELECT COUNT(*) AS count FROM tier2_episodic WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      archival: Number((db.prepare("SELECT COUNT(*) AS count FROM tier3_archival WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      artifacts: Number((db.prepare("SELECT COUNT(*) AS count FROM agent_memory_artifacts WHERE agent_name = ? OR agent_name IS NULL").get(name) as { count: number } | null)?.count ?? 0),
      refresh: Number((db.prepare("SELECT COUNT(*) AS count FROM agent_memory_refresh_state WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      compactions: Number((db.prepare("SELECT COUNT(*) AS count FROM agent_memory_compactions WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      items: Number((db.prepare("SELECT COUNT(*) AS count FROM agent_memory_compaction_items WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      links: Number((db.prepare("SELECT COUNT(*) AS count FROM agent_memory_links WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
      facts: Number((db.prepare("SELECT COUNT(*) AS count FROM agent_memory_facts WHERE agent_name = ?").get(name) as { count: number } | null)?.count ?? 0),
    };
    const expected = {
      working: expectedWorking,
      episodic: expectedEpisodic,
      archival: expectedArchival,
      artifacts: expectedArtifacts,
      refresh: Math.min(expectedRefresh, 1),
      compactions: expectedCompactions,
      items: expectedItems,
      links: expectedLinks,
      facts: expectedFacts,
    };
    const driftFields = Object.keys(expected).filter((key) => (expected as any)[key] !== (actual as any)[key]);
    // Row-level content drift: sample recent compaction items and facts
    const contentDrift: string[] = [];
    const derivedItems = expectedDerived.filter((row) => row.record_type === "compaction_item" && row.event === "created" && row.item);
    for (const row of derivedItems.slice(-8)) {
      const item = row.item as { id?: number; content?: string; item_kind?: string } | null;
      if (!item?.id) continue;
      const actual = db.prepare("SELECT content, item_kind FROM agent_memory_compaction_items WHERE id = ?").get(item.id) as { content: string; item_kind: string } | null;
      if (!actual) { contentDrift.push(`compaction_item:${item.id} missing from db`); continue; }
      if (actual.item_kind !== item.item_kind) contentDrift.push(`compaction_item:${item.id} item_kind: ${item.item_kind} vs ${actual.item_kind}`);
      if ((actual.content ?? "").slice(0, 100) !== (item.content ?? "").slice(0, 100)) contentDrift.push(`compaction_item:${item.id} content differs`);
    }
    const derivedFacts = expectedDerived.filter((row) => row.record_type === "fact" && row.event === "upsert" && row.fact);
    for (const row of derivedFacts.slice(-8)) {
      const fact = row.fact as { id?: number; subject?: string; predicate?: string; object?: string } | null;
      if (!fact?.id) continue;
      const actual = db.prepare("SELECT subject, predicate, object FROM agent_memory_facts WHERE id = ?").get(fact.id) as { subject: string; predicate: string; object: string } | null;
      if (!actual) { contentDrift.push(`fact:${fact.id} missing from db`); continue; }
      if (actual.subject !== fact.subject || actual.predicate !== fact.predicate || actual.object !== fact.object) {
        contentDrift.push(`fact:${fact.id} SPO differs: expected ${fact.subject}/${fact.predicate}/${fact.object}, actual ${actual.subject}/${actual.predicate}/${actual.object}`);
      }
    }
    return {
      agent: name,
      ok: driftFields.length === 0 && contentDrift.length === 0,
      expected,
      actual,
      content_drift: contentDrift.length > 0 ? contentDrift : null,
      issues: [
        ...driftFields.map((field) => `memory drift: ${field} expected ${(expected as any)[field]} actual ${(actual as any)[field]}`),
        ...contentDrift.map((d) => `content drift: ${d}`),
      ],
      repair: driftFields.length === 0 && contentDrift.length === 0 ? null : `agent-memory rebuild ${name}`,
    };
  });
  const expectedDigests = readJsonl(stateDir("memory-source", "digests", "public.jsonl")).filter((row) => row.record_type === "public_digest").length;
  const actualDigests = Number((db.prepare("SELECT COUNT(*) AS count FROM public_digests").get() as { count: number } | null)?.count ?? 0);
  console.log(JSON.stringify({
    verified,
    public_digests: {
      ok: expectedDigests === actualDigests,
      expected: expectedDigests,
      actual: actualDigests,
      issues: expectedDigests === actualDigests ? [] : [`public digest drift: expected ${expectedDigests}, actual ${actualDigests}`],
      repair: expectedDigests === actualDigests ? null : "agent-memory rebuild",
    },
  }));
}

ensureSchema();

if (cmd === "refresh") {
  if (!arg1) {
    console.error("Usage: agent-memory refresh <agent>");
    process.exit(64);
  }
  await refresh(arg1);
} else if (cmd === "repair") {
  if (!arg1) {
    console.error("Usage: agent-memory repair <agent>");
    process.exit(64);
  }
  db.run(
    `DELETE FROM agent_memory_artifacts
     WHERE (agent_name = ? AND source_table IN ('tier2_episodic', 'tier3_archival'))
        OR (agent_name IS NULL AND source_table = 'public_digests')`,
    [arg1],
  );
  await refresh(arg1);
} else if (cmd === "reinforce") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-memory reinforce <agent> <artifactIdsCsv>");
    process.exit(64);
  }
  reinforce(arg1, arg2.split(",").map((value) => parseInt(value, 10)));
} else if (cmd === "decay") {
  if (!arg1) {
    console.error("Usage: agent-memory decay <agent>");
    process.exit(64);
  }
  decay(arg1);
} else if (cmd === "rebalance") {
  if (!arg1) {
    console.error("Usage: agent-memory rebalance <agent>");
    process.exit(64);
  }
  rebalance(arg1);
} else if (cmd === "compact") {
  if (!arg1) {
    console.error("Usage: agent-memory compact <agent>");
    process.exit(64);
  }
  await compact(arg1);
} else if (cmd === "extract") {
  if (!arg1) {
    console.error("Usage: agent-memory extract <agent>");
    process.exit(64);
  }
  await extractEntities(arg1);
} else if (cmd === "lookup") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-memory lookup <agent> <query> [limit] [mode]");
    process.exit(64);
  }
  const modeArg = Bun.argv[6];
  const mode: RetrievalMode = modeArg === "local" || modeArg === "global" || modeArg === "mix" ? modeArg : "mix";
  await lookup(arg1, arg2, Math.max(1, parseInt(Bun.argv[5] || "3", 10) || 3), mode);
} else if (cmd === "invalidate") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-memory invalidate <agent> <query> [relationPrefix]");
    process.exit(64);
  }
  invalidate(arg1, arg2, Bun.argv[5] || null);
} else if (cmd === "timeline") {
  if (!arg1 || !arg2) {
    console.error("Usage: agent-memory timeline <agent> <query> [limit]");
    process.exit(64);
  }
  timeline(arg1, arg2, Math.max(1, parseInt(Bun.argv[5] || "12", 10) || 12));
} else if (cmd === "status") {
  if (!arg1) {
    console.error("Usage: agent-memory status <agent>");
    process.exit(64);
  }
  console.log(JSON.stringify(db.prepare("SELECT * FROM agent_memory_refresh_state WHERE agent_name = ?").get(arg1) ?? null));
} else if (cmd === "rebuild") {
  rebuildMemory(arg1);
} else if (cmd === "verify") {
  verifyMemory(arg1);
} else if (cmd === "list") {
  const limit = Math.max(1, parseInt(arg2 || "20", 10) || 20);
  if (arg1) {
    console.log(JSON.stringify(db.prepare("SELECT * FROM agent_memory_artifacts WHERE agent_name = ? OR agent_name IS NULL ORDER BY id DESC LIMIT ?").all(arg1, limit)));
  } else {
    console.log(JSON.stringify(db.prepare("SELECT * FROM agent_memory_artifacts ORDER BY id DESC LIMIT ?").all(limit)));
  }
} else {
  usage();
}
