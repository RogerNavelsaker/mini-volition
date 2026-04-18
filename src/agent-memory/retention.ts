import type { Database } from "bun:sqlite";
import type { MemoryKind } from "./types";

const MEMORY_KINDS: MemoryKind[] = ["digest", "episodic", "archival", "verbatim"];
const IMPORTANCE_LEVELS = ["low", "normal", "high", "critical"] as const;
type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

export type RetentionPolicyRow = {
  agent_name: string;
  source_kind: MemoryKind;
  min_importance: ImportanceLevel;
  max_age_days: number | null;
  max_items: number | null;
  compact_after_days: number | null;
  archive_after_days: number | null;
  prune_after_days: number | null;
  enabled: number;
  created_at?: string;
  updated_at?: string;
};

type RetentionDefaults = Omit<RetentionPolicyRow, "agent_name" | "created_at" | "updated_at">;

const DEFAULT_RETENTION_BY_KIND: Record<MemoryKind, RetentionDefaults> = {
  digest: {
    source_kind: "digest",
    min_importance: "low",
    max_age_days: 21,
    max_items: 200,
    compact_after_days: 2,
    archive_after_days: 7,
    prune_after_days: 30,
    enabled: 1,
  },
  episodic: {
    source_kind: "episodic",
    min_importance: "normal",
    max_age_days: 30,
    max_items: 250,
    compact_after_days: 7,
    archive_after_days: 14,
    prune_after_days: 60,
    enabled: 1,
  },
  archival: {
    source_kind: "archival",
    min_importance: "high",
    max_age_days: 365,
    max_items: 1000,
    compact_after_days: null,
    archive_after_days: null,
    prune_after_days: 730,
    enabled: 1,
  },
  verbatim: {
    source_kind: "verbatim",
    min_importance: "normal",
    max_age_days: 14,
    max_items: 500,
    compact_after_days: 3,
    archive_after_days: 7,
    prune_after_days: 21,
    enabled: 1,
  },
};

function parseNullableNumber(value: string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanFlag(value: string | undefined): number {
  if (value === undefined || value === null || value === "") return 1;
  return value === "0" || value.toLowerCase() === "false" ? 0 : 1;
}

export function isMemoryKind(value: string): value is MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind);
}

export function isImportanceLevel(value: string): value is ImportanceLevel {
  return (IMPORTANCE_LEVELS as readonly string[]).includes(value);
}

export function retentionKinds(): MemoryKind[] {
  return [...MEMORY_KINDS];
}

function envKey(kind: MemoryKind, suffix: string): string {
  return `FLEET_MEMORY_RETENTION_${kind.toUpperCase()}_${suffix}`;
}

export function defaultRetentionPolicy(agentName: string, kind: MemoryKind, env: NodeJS.ProcessEnv = process.env): RetentionPolicyRow {
  const defaults = DEFAULT_RETENTION_BY_KIND[kind];
  return {
    agent_name: agentName,
    source_kind: kind,
    min_importance: isImportanceLevel(env[envKey(kind, "MIN_IMPORTANCE")] || "")
      ? (env[envKey(kind, "MIN_IMPORTANCE")] as ImportanceLevel)
      : defaults.min_importance,
    max_age_days: parseNullableNumber(env[envKey(kind, "MAX_AGE_DAYS")]) ?? defaults.max_age_days,
    max_items: parseNullableNumber(env[envKey(kind, "MAX_ITEMS")]) ?? defaults.max_items,
    compact_after_days: parseNullableNumber(env[envKey(kind, "COMPACT_AFTER_DAYS")]) ?? defaults.compact_after_days,
    archive_after_days: parseNullableNumber(env[envKey(kind, "ARCHIVE_AFTER_DAYS")]) ?? defaults.archive_after_days,
    prune_after_days: parseNullableNumber(env[envKey(kind, "PRUNE_AFTER_DAYS")]) ?? defaults.prune_after_days,
    enabled: env[envKey(kind, "ENABLED")] !== undefined ? parseBooleanFlag(env[envKey(kind, "ENABLED")]) : defaults.enabled,
  };
}

export function getRetentionPolicy(db: Database, agentName: string, kind: MemoryKind, env: NodeJS.ProcessEnv = process.env): RetentionPolicyRow {
  const row = db.prepare(
    `SELECT agent_name, source_kind, min_importance, max_age_days, max_items,
            compact_after_days, archive_after_days, prune_after_days, enabled, created_at, updated_at
     FROM agent_memory_retention_policies
     WHERE agent_name = ? AND source_kind = ?
     LIMIT 1`,
  ).get(agentName, kind) as RetentionPolicyRow | null;
  return row ?? defaultRetentionPolicy(agentName, kind, env);
}

export function listRetentionPolicies(db: Database, agentName: string, env: NodeJS.ProcessEnv = process.env): RetentionPolicyRow[] {
  return retentionKinds().map((kind) => getRetentionPolicy(db, agentName, kind, env));
}

export function upsertRetentionPolicy(
  db: Database,
  agentName: string,
  kind: MemoryKind,
  minImportance: ImportanceLevel,
  maxAgeDays: number | null,
  maxItems: number | null,
  compactAfterDays: number | null,
  archiveAfterDays: number | null,
  pruneAfterDays: number | null,
  enabled: number,
): RetentionPolicyRow {
  db.run(
    `INSERT INTO agent_memory_retention_policies (
       agent_name, source_kind, min_importance, max_age_days, max_items,
       compact_after_days, archive_after_days, prune_after_days, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_name, source_kind) DO UPDATE SET
       min_importance = excluded.min_importance,
       max_age_days = excluded.max_age_days,
       max_items = excluded.max_items,
       compact_after_days = excluded.compact_after_days,
       archive_after_days = excluded.archive_after_days,
       prune_after_days = excluded.prune_after_days,
       enabled = excluded.enabled,
       updated_at = CURRENT_TIMESTAMP`,
    [agentName, kind, minImportance, maxAgeDays, maxItems, compactAfterDays, archiveAfterDays, pruneAfterDays, enabled],
  );
  return getRetentionPolicy(db, agentName, kind);
}
