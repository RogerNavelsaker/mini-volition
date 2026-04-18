import { describe, it, expect } from "bun:test";
import { parseEnvelope, hasActionType, filterActions, ACTION_TYPES } from "./envelope";
import type { Envelope, SubscribeAction, UnsubscribeAction } from "./envelope";

function valid(actions: unknown[]): unknown {
  return { version: "1", actions };
}

describe("parseEnvelope — structural validation", () => {
  it("rejects non-JSON string", () => {
    const r = parseEnvelope("not json {{{");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("JSON");
  });

  it("parses valid JSON string", () => {
    const r = parseEnvelope(JSON.stringify({ version: "1", actions: [{ type: "noop" }] }));
    expect(r.ok).toBe(true);
  });

  it("rejects non-object", () => {
    expect(parseEnvelope(42).ok).toBe(false);
    expect(parseEnvelope([]).ok).toBe(false);
    expect(parseEnvelope(null).ok).toBe(false);
  });

  it("rejects wrong version", () => {
    const r = parseEnvelope({ version: "2", actions: [{ type: "noop" }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("version");
  });

  it("rejects missing version", () => {
    expect(parseEnvelope({ actions: [{ type: "noop" }] }).ok).toBe(false);
  });

  it("rejects non-array actions", () => {
    expect(parseEnvelope({ version: "1", actions: {} }).ok).toBe(false);
  });

  it("rejects empty actions", () => {
    const r = parseEnvelope({ version: "1", actions: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("empty");
  });

  it("rejects unknown action type", () => {
    const r = parseEnvelope(valid([{ type: "unknown_action" }]));
    expect(r.ok).toBe(false);
  });
});

describe("parseEnvelope — reply", () => {
  it("accepts valid reply", () => {
    const r = parseEnvelope(valid([{ type: "reply", content: "hello" }]));
    expect(r.ok).toBe(true);
  });

  it("rejects reply with empty content", () => {
    expect(parseEnvelope(valid([{ type: "reply", content: "" }])).ok).toBe(false);
  });

  it("accepts optional layer", () => {
    const r = parseEnvelope(valid([{ type: "reply", content: "hello", layer: "private" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.envelope.actions[0] as { layer?: string }).layer).toBe("private");
  });
});

describe("parseEnvelope — sleep_until", () => {
  it("accepts valid ISO date", () => {
    expect(parseEnvelope(valid([{ type: "sleep_until", iso: "2026-04-18T12:00:00.000Z" }])).ok).toBe(true);
  });

  it("rejects invalid date", () => {
    expect(parseEnvelope(valid([{ type: "sleep_until", iso: "not-a-date" }])).ok).toBe(false);
  });

  it("rejects missing iso", () => {
    expect(parseEnvelope(valid([{ type: "sleep_until" }])).ok).toBe(false);
  });
});

describe("parseEnvelope — queue_task", () => {
  it("accepts valid task", () => {
    expect(parseEnvelope(valid([{ type: "queue_task", task: "do-something" }])).ok).toBe(true);
  });

  it("rejects empty task", () => {
    expect(parseEnvelope(valid([{ type: "queue_task", task: "" }])).ok).toBe(false);
  });

  it("accepts valid priority", () => {
    for (const priority of ["low", "normal", "high", "urgent"]) {
      expect(parseEnvelope(valid([{ type: "queue_task", task: "t", priority }])).ok).toBe(true);
    }
  });

  it("rejects invalid priority", () => {
    expect(parseEnvelope(valid([{ type: "queue_task", task: "t", priority: "critical" }])).ok).toBe(false);
  });
});

describe("parseEnvelope — escalate", () => {
  it("accepts valid escalate", () => {
    expect(parseEnvelope(valid([{ type: "escalate", reason: "out of options" }])).ok).toBe(true);
  });

  it("rejects empty reason", () => {
    expect(parseEnvelope(valid([{ type: "escalate", reason: "" }])).ok).toBe(false);
  });

  it("accepts valid severity", () => {
    for (const severity of ["low", "normal", "high", "critical"]) {
      expect(parseEnvelope(valid([{ type: "escalate", reason: "r", severity }])).ok).toBe(true);
    }
  });

  it("rejects invalid severity", () => {
    expect(parseEnvelope(valid([{ type: "escalate", reason: "r", severity: "fatal" }])).ok).toBe(false);
  });
});

describe("parseEnvelope — scratchpad", () => {
  it("accepts append with content", () => {
    expect(parseEnvelope(valid([{ type: "scratchpad", op: "append", content: "notes" }])).ok).toBe(true);
  });

  it("accepts replace with content", () => {
    expect(parseEnvelope(valid([{ type: "scratchpad", op: "replace", content: "notes" }])).ok).toBe(true);
  });

  it("accepts clear without content", () => {
    expect(parseEnvelope(valid([{ type: "scratchpad", op: "clear" }])).ok).toBe(true);
  });

  it("rejects append without content", () => {
    expect(parseEnvelope(valid([{ type: "scratchpad", op: "append" }])).ok).toBe(false);
  });

  it("rejects unknown op", () => {
    expect(parseEnvelope(valid([{ type: "scratchpad", op: "delete", content: "x" }])).ok).toBe(false);
  });
});

describe("parseEnvelope — spawn_scribe", () => {
  it("accepts valid spawn_scribe", () => {
    expect(parseEnvelope(valid([{ type: "spawn_scribe", scribe: "milo", prompt: "summarize" }])).ok).toBe(true);
  });

  it("rejects missing scribe", () => {
    expect(parseEnvelope(valid([{ type: "spawn_scribe", prompt: "summarize" }])).ok).toBe(false);
  });

  it("rejects missing prompt", () => {
    expect(parseEnvelope(valid([{ type: "spawn_scribe", scribe: "milo" }])).ok).toBe(false);
  });

  it("accepts optional reply_channel", () => {
    const r = parseEnvelope(valid([{ type: "spawn_scribe", scribe: "milo", prompt: "go", reply_channel: "chan-1" }]));
    expect(r.ok).toBe(true);
  });
});

describe("parseEnvelope — subscribe_channel (new)", () => {
  it("accepts valid subscribe_channel", () => {
    const r = parseEnvelope(valid([{ type: "subscribe_channel", channel: "chat:general" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = r.envelope.actions[0] as SubscribeAction;
    expect(action.channel).toBe("chat:general");
  });

  it("rejects missing channel", () => {
    expect(parseEnvelope(valid([{ type: "subscribe_channel" }])).ok).toBe(false);
  });

  it("accepts optional note", () => {
    const r = parseEnvelope(valid([{ type: "subscribe_channel", channel: "chan", note: "tracking issue" }]));
    expect(r.ok).toBe(true);
  });
});

describe("parseEnvelope — unsubscribe_channel (new)", () => {
  it("accepts valid unsubscribe_channel", () => {
    const r = parseEnvelope(valid([{ type: "unsubscribe_channel", channel: "chat:noisy" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = r.envelope.actions[0] as UnsubscribeAction;
    expect(action.channel).toBe("chat:noisy");
  });

  it("rejects missing channel", () => {
    expect(parseEnvelope(valid([{ type: "unsubscribe_channel" }])).ok).toBe(false);
  });

  it("accepts valid resume_at ISO date", () => {
    const r = parseEnvelope(valid([{ type: "unsubscribe_channel", channel: "chan", resume_at: "2026-04-19T00:00:00.000Z" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = r.envelope.actions[0] as UnsubscribeAction;
    expect(action.resume_at).toBe("2026-04-19T00:00:00.000Z");
  });

  it("rejects invalid resume_at", () => {
    expect(parseEnvelope(valid([{ type: "unsubscribe_channel", channel: "chan", resume_at: "bad-date" }])).ok).toBe(false);
  });
});

describe("parseEnvelope — multiple actions", () => {
  it("accepts multiple valid actions", () => {
    const r = parseEnvelope(valid([
      { type: "noop" },
      { type: "note", content: "thinking" },
      { type: "subscribe_channel", channel: "chan" },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.actions).toHaveLength(3);
  });

  it("fails on first invalid action", () => {
    const r = parseEnvelope(valid([
      { type: "noop" },
      { type: "reply", content: "" },
    ]));
    expect(r.ok).toBe(false);
  });
});

describe("ACTION_TYPES", () => {
  it("includes all expected action types", () => {
    for (const t of ["reply", "noop", "note", "sleep_until", "queue_task", "escalate", "scratchpad", "spawn_scribe", "subscribe_channel", "unsubscribe_channel"]) {
      expect(ACTION_TYPES).toContain(t);
    }
  });
});

describe("hasActionType / filterActions", () => {
  it("hasActionType returns true when action present", () => {
    const r = parseEnvelope(valid([{ type: "noop" }, { type: "note", content: "x" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(hasActionType(r.envelope, "noop")).toBe(true);
    expect(hasActionType(r.envelope, "note")).toBe(true);
    expect(hasActionType(r.envelope, "reply")).toBe(false);
  });

  it("filterActions returns matching actions", () => {
    const r = parseEnvelope(valid([
      { type: "subscribe_channel", channel: "chan-a" },
      { type: "subscribe_channel", channel: "chan-b" },
      { type: "noop" },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const subscriptions = filterActions<SubscribeAction>(r.envelope, "subscribe_channel");
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map((a) => a.channel).sort()).toEqual(["chan-a", "chan-b"]);
  });
});
