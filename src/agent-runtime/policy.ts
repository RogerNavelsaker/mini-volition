export type RetrievalMode = "local" | "global" | "mix";
export type TurnProfile = "light" | "full" | "max";
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
