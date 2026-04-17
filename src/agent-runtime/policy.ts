export type RetrievalMode = "local" | "global" | "mix";
export type TurnProfile = "light" | "full" | "max";
export type TurnProfileConfig = {
  model: string | null;
  reasoning_effort: string | null;
  timeout_ms: number;
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
