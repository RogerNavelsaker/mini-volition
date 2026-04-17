export type RetrievalMode = "local" | "global" | "mix";
export type TurnProfile = "light" | "full" | "max";
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
export type RetrievalPolicyBurst = {
  primary: { layer: string };
  messages: Array<{ body: string }>;
};
export type RetrievalWakeSource = "internal_job" | "mail_burst";
export type TurnPolicyBurst = {
  primary: { layer: string };
  messages: Array<{ body: string }>;
};
export type TurnWakeSource = "internal_job" | "mail_burst";

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
  const defaultTimeoutMs = parseTimeoutMs(env.FLEET_TURN_TIMEOUT_MS, 120_000);

  if (profile === "light") {
    return {
      model: env.INFERENCE_LOCAL_SMALL_MODEL ?? null,
      reasoning_effort: env.INFERENCE_LOCAL_SMALL_REASONING_EFFORT ?? "low",
      timeout_ms: parseTimeoutMs(env.FLEET_LIGHT_TIMEOUT_MS, defaultTimeoutMs),
    };
  }

  if (profile === "max") {
    return {
      model: env.FLEET_MAX_MODEL ?? null,
      reasoning_effort: env.FLEET_MAX_REASONING_EFFORT ?? "high",
      timeout_ms: parseTimeoutMs(env.FLEET_MAX_TIMEOUT_MS, defaultTimeoutMs),
    };
  }

  return {
    model: env.FLEET_FULL_MODEL ?? null,
    reasoning_effort: env.FLEET_FULL_REASONING_EFFORT ?? "medium",
    timeout_ms: parseTimeoutMs(env.FLEET_FULL_TIMEOUT_MS, defaultTimeoutMs),
  };
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
