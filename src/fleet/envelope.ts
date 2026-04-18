export const ENVELOPE_VERSION = "1" as const;

export type ReplyAction = { type: "reply"; content: string; layer?: string };
export type NoopAction = { type: "noop"; reason?: string };
export type NoteAction = { type: "note"; content: string };
export type SleepUntilAction = { type: "sleep_until"; iso: string };
export type QueueTaskAction = { type: "queue_task"; task: string; priority?: "low" | "normal" | "high" | "urgent" };
export type EscalateAction = { type: "escalate"; reason: string; severity?: "low" | "normal" | "high" | "critical" };
export type ScratchpadAction = { type: "scratchpad"; op: "append" | "replace" | "clear"; content?: string };
export type SpawnScribeAction = { type: "spawn_scribe"; scribe: string; prompt: string; reply_channel?: string };
export type SubscribeAction = { type: "subscribe_channel"; channel: string; note?: string };
export type UnsubscribeAction = { type: "unsubscribe_channel"; channel: string; resume_at?: string; note?: string };

export type EnvelopeAction =
  | ReplyAction
  | NoopAction
  | NoteAction
  | SleepUntilAction
  | QueueTaskAction
  | EscalateAction
  | ScratchpadAction
  | SpawnScribeAction
  | SubscribeAction
  | UnsubscribeAction;

export type ActionType = EnvelopeAction["type"];

export const ACTION_TYPES: readonly ActionType[] = [
  "reply",
  "noop",
  "note",
  "sleep_until",
  "queue_task",
  "escalate",
  "scratchpad",
  "spawn_scribe",
  "subscribe_channel",
  "unsubscribe_channel",
];

export type Envelope = {
  version: typeof ENVELOPE_VERSION;
  actions: EnvelopeAction[];
};

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isActionType(v: unknown): v is ActionType {
  return isString(v) && (ACTION_TYPES as readonly string[]).includes(v);
}

function validateAction(raw: unknown, index: number): EnvelopeAction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`action[${index}]: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (!isActionType(obj.type)) {
    throw new Error(`action[${index}]: unknown type '${String(obj.type)}'`);
  }

  switch (obj.type) {
    case "reply":
      if (!isString(obj.content) || !obj.content.trim()) throw new Error(`action[${index}]: reply.content required`);
      return { type: "reply", content: obj.content, layer: isString(obj.layer) ? obj.layer : undefined };

    case "noop":
      return { type: "noop", reason: isString(obj.reason) ? obj.reason : undefined };

    case "note":
      if (!isString(obj.content) || !obj.content.trim()) throw new Error(`action[${index}]: note.content required`);
      return { type: "note", content: obj.content };

    case "sleep_until":
      if (!isString(obj.iso) || !obj.iso.trim()) throw new Error(`action[${index}]: sleep_until.iso required`);
      if (!Number.isFinite(Date.parse(obj.iso))) throw new Error(`action[${index}]: sleep_until.iso is not a valid ISO date`);
      return { type: "sleep_until", iso: obj.iso };

    case "queue_task": {
      if (!isString(obj.task) || !obj.task.trim()) throw new Error(`action[${index}]: queue_task.task required`);
      const priority = obj.priority;
      if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(String(priority))) {
        throw new Error(`action[${index}]: queue_task.priority must be low|normal|high|urgent`);
      }
      return { type: "queue_task", task: obj.task, priority: priority as QueueTaskAction["priority"] };
    }

    case "escalate": {
      if (!isString(obj.reason) || !obj.reason.trim()) throw new Error(`action[${index}]: escalate.reason required`);
      const severity = obj.severity;
      if (severity !== undefined && !["low", "normal", "high", "critical"].includes(String(severity))) {
        throw new Error(`action[${index}]: escalate.severity must be low|normal|high|critical`);
      }
      return { type: "escalate", reason: obj.reason, severity: severity as EscalateAction["severity"] };
    }

    case "scratchpad": {
      const op = obj.op;
      if (!["append", "replace", "clear"].includes(String(op))) throw new Error(`action[${index}]: scratchpad.op must be append|replace|clear`);
      if (op !== "clear" && (!isString(obj.content) || !obj.content.trim())) {
        throw new Error(`action[${index}]: scratchpad.content required for op '${String(op)}'`);
      }
      return { type: "scratchpad", op: op as ScratchpadAction["op"], content: isString(obj.content) ? obj.content : undefined };
    }

    case "spawn_scribe":
      if (!isString(obj.scribe) || !obj.scribe.trim()) throw new Error(`action[${index}]: spawn_scribe.scribe required`);
      if (!isString(obj.prompt) || !obj.prompt.trim()) throw new Error(`action[${index}]: spawn_scribe.prompt required`);
      return { type: "spawn_scribe", scribe: obj.scribe, prompt: obj.prompt, reply_channel: isString(obj.reply_channel) ? obj.reply_channel : undefined };

    case "subscribe_channel":
      if (!isString(obj.channel) || !obj.channel.trim()) throw new Error(`action[${index}]: subscribe_channel.channel required`);
      return { type: "subscribe_channel", channel: obj.channel, note: isString(obj.note) ? obj.note : undefined };

    case "unsubscribe_channel":
      if (!isString(obj.channel) || !obj.channel.trim()) throw new Error(`action[${index}]: unsubscribe_channel.channel required`);
      if (obj.resume_at !== undefined && (!isString(obj.resume_at) || !Number.isFinite(Date.parse(obj.resume_at)))) {
        throw new Error(`action[${index}]: unsubscribe_channel.resume_at must be a valid ISO date`);
      }
      return { type: "unsubscribe_channel", channel: obj.channel, resume_at: isString(obj.resume_at) ? obj.resume_at : undefined, note: isString(obj.note) ? obj.note : undefined };
  }
}

export function parseEnvelope(raw: unknown): ParseResult {
  try {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return { ok: false, error: "envelope is not valid JSON" };
      }
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "envelope must be a JSON object" };
    }
    const obj = raw as Record<string, unknown>;
    if (obj.version !== ENVELOPE_VERSION) {
      return { ok: false, error: `envelope.version must be '${ENVELOPE_VERSION}', got '${String(obj.version)}'` };
    }
    if (!Array.isArray(obj.actions)) {
      return { ok: false, error: "envelope.actions must be an array" };
    }
    if (obj.actions.length === 0) {
      return { ok: false, error: "envelope.actions must not be empty" };
    }
    const actions = obj.actions.map((action, i) => validateAction(action, i));
    return { ok: true, envelope: { version: ENVELOPE_VERSION, actions } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function hasActionType(envelope: Envelope, type: ActionType): boolean {
  return envelope.actions.some((a) => a.type === type);
}

export function filterActions<T extends EnvelopeAction>(envelope: Envelope, type: T["type"]): T[] {
  return envelope.actions.filter((a): a is T => a.type === type);
}
