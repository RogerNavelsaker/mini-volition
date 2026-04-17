import type { Database } from "bun:sqlite";
import type { RetrievalMode } from "./types";

export function normalizeLookupQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

export function buildLookupCacheKey(query: string, limit: number, mode: RetrievalMode): string {
  return JSON.stringify({
    query: normalizeLookupQuery(query),
    limit: Math.max(1, limit),
    mode,
  });
}

export function resolveLookupExpiry(
  nowMs: number,
  stale: boolean,
  lastRefreshAt: string | null | undefined,
  staleAfterSeconds: number,
  cacheTtlSeconds: number,
): string {
  const ttlMs = Math.max(5, cacheTtlSeconds) * 1000;
  let expiresAtMs = nowMs + ttlMs;
  if (!stale && lastRefreshAt) {
    const refreshMs = new Date(lastRefreshAt.endsWith("Z") ? lastRefreshAt : `${lastRefreshAt}Z`).getTime();
    if (Number.isFinite(refreshMs)) {
      expiresAtMs = Math.min(expiresAtMs, refreshMs + Math.max(30, staleAfterSeconds) * 1000);
    }
  }
  return new Date(expiresAtMs).toISOString();
}

export function readLookupCache(
  db: Database,
  agentName: string,
  cacheKey: string,
  nowIso: string,
): string | null {
  const row = db.prepare(
    `SELECT payload_json
     FROM agent_memory_lookup_cache
     WHERE agent_name = ?
       AND cache_key = ?
       AND expires_at > ?`,
  ).get(agentName, cacheKey, nowIso) as { payload_json: string } | null;
  return row?.payload_json ?? null;
}

export function writeLookupCache(
  db: Database,
  agentName: string,
  cacheKey: string,
  payloadJson: string,
  expiresAt: string,
) {
  db.run(
    `INSERT INTO agent_memory_lookup_cache (agent_name, cache_key, payload_json, expires_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name, cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       expires_at = excluded.expires_at,
       updated_at = CURRENT_TIMESTAMP`,
    [agentName, cacheKey, payloadJson, expiresAt],
  );
}

export function invalidateLookupCache(db: Database, agentName?: string) {
  if (agentName) {
    db.run("DELETE FROM agent_memory_lookup_cache WHERE agent_name = ?", [agentName]);
    return;
  }
  db.run("DELETE FROM agent_memory_lookup_cache");
}
