export type RetrievalMode = "local" | "global" | "mix";
export type TurnProfile = "light" | "full" | "max";
export type WakeSource = "internal_job" | "mail_burst";
export type WakeSourceGroup = "internal" | "urgent" | "direct" | "social" | "ambient";
export type TurnProfileConfig = {
  model: string | null;
  reasoning_effort: string | null;
  timeout_ms: number;
};
export type RetryConfig = {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
};
export type LimitCooldownState = "quota_exhausted" | "transient_capacity";
export type CooldownRange = {
  minMs: number;
  maxMs: number;
};
export type RetrievalPolicyBurst = {
  primary: { layer: string };
  messages: Array<{ body: string }>;
};
export type RetrievalWakeSource = WakeSource;
export type TurnPolicyBurst = {
  primary: { layer: string };
  messages: Array<{ body: string }>;
};
export type TurnWakeSource = WakeSource;

const GLOBAL_HINT = /\b(plan|roadmap|design|architecture|summarize|summary|overview|status|state of|big picture|broadly)\b/i;
const LOCAL_HINT = /\b(fix|bug|error|trace|specific|exactly|where|which file|why did|urgent|private)\b/i;
const LIGHT_HINT = /\b(status|overview|ack|noted|receipt|heartbeat|check-in|fyi)\b/i;
const MAX_HINT = /\b(urgent|escalate|critical|broken|production|deadlock|stuck|outage|security)\b/i;

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? Math.max(15_000, parsed) : fallback;
}

export function turnProfileConfig(
  profile: TurnProfile,
  env: Record<string, string | undefined> = process.env,
): TurnProfileConfig {
  const defaultTimeoutMs = parseTimeoutMs(env.INFERENCE_TURN_TIMEOUT_MS, 120_000);

  if (profile === "light") {
    return {
      model: env.INFERENCE_LOCAL_SMALL_MODEL ?? null,
      reasoning_effort: env.INFERENCE_LOCAL_SMALL_REASONING_EFFORT ?? "low",
      timeout_ms: parseTimeoutMs(env.INFERENCE_LOCAL_SMALL_TIMEOUT_MS, defaultTimeoutMs),
    };
  }

  if (profile === "max") {
    return {
      model: env.INFERENCE_CLOUD_MAX_MODEL ?? env.INFERENCE_CLOUD_MODEL ?? null,
      reasoning_effort: env.INFERENCE_CLOUD_MAX_REASONING_EFFORT ?? "high",
      timeout_ms: parseTimeoutMs(env.INFERENCE_CLOUD_MAX_TIMEOUT_MS, defaultTimeoutMs),
    };
  }

  return {
    model: env.INFERENCE_CLOUD_MODEL ?? null,
    reasoning_effort: env.INFERENCE_CLOUD_REASONING_EFFORT ?? "medium",
    timeout_ms: parseTimeoutMs(env.INFERENCE_CLOUD_TIMEOUT_MS, defaultTimeoutMs),
  };
}

export function classifySourceGroup(source: WakeSource, primaryLayer: string): WakeSourceGroup {
  if (source === "internal_job") return "internal";

  const layer = primaryLayer.toLowerCase();
  if (layer === "urgent") return "urgent";
  if (layer === "private") return "direct";
  if (layer === "public") return "social";
  return "ambient";
}

export function chooseRetrievalMode(source: RetrievalWakeSource, burst: RetrievalPolicyBurst): RetrievalMode {
  const primaryLayer = burst.primary.layer.toLowerCase();
  const body = burst.messages.map((entry) => entry.body.toLowerCase()).join("\n");

  if (source === "internal_job") {
    if (GLOBAL_HINT.test(body)) return "global";
    return "local";
  }

  if (primaryLayer === "urgent" || primaryLayer === "private") return "local";
  if (GLOBAL_HINT.test(body)) return "global";
  if (LOCAL_HINT.test(body)) return "local";
  return "mix";
}

export function chooseTurnProfile(source: TurnWakeSource, burst: TurnPolicyBurst): TurnProfile {
  const primaryLayer = burst.primary.layer.toLowerCase();
  const body = burst.messages.map((entry) => entry.body.toLowerCase()).join("\n");

  if (primaryLayer === "urgent" || MAX_HINT.test(body)) return "max";
  if (primaryLayer === "private") return "full";
  if (source === "internal_job") {
    if (GLOBAL_HINT.test(body) || LOCAL_HINT.test(body)) return "full";
    if (LIGHT_HINT.test(body)) return "light";
    return "full";
  }
  if (LIGHT_HINT.test(body) && !GLOBAL_HINT.test(body) && !LOCAL_HINT.test(body)) return "light";
  return "full";
}

export function retryConfig(profile: TurnProfile): RetryConfig {
  if (profile === "light") return { maxAttempts: 2, backoffMs: 1_000, backoffMultiplier: 1.5 };
  if (profile === "max") return { maxAttempts: 4, backoffMs: 3_000, backoffMultiplier: 2.0 };
  return { maxAttempts: 3, backoffMs: 2_000, backoffMultiplier: 2.0 };
}

export function cooldownRange(limitState: LimitCooldownState): CooldownRange {
  if (limitState === "quota_exhausted") {
    return { minMs: 60 * 60 * 1000, maxMs: 60 * 60 * 1000 };
  }

  return { minMs: 10_000, maxMs: 30_000 };
}

export function randomizedCooldownMs(
  limitState: LimitCooldownState,
  random: () => number = Math.random,
): number {
  const { minMs, maxMs } = cooldownRange(limitState);
  if (minMs === maxMs) return minMs;

  const sample = Math.min(1, Math.max(0, random()));
  return minMs + Math.round((maxMs - minMs) * sample);
}
