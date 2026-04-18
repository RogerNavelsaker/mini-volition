import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";

function makeStateDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS fleet_channel_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'subscribed',
    resume_at TEXT,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_name, channel)
  );`);
  return db;
}

function applyFocus(db: Database, agentName: string, channels: string[], durationSec: number) {
  const resumeAt = new Date(Date.now() + durationSec * 1000).toISOString();
  for (const channel of channels) {
    db.prepare(
      `INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note, created_at, updated_at)
       VALUES (?, ?, 'unsubscribed', ?, 'focus', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_name, channel) DO UPDATE SET
         status = 'unsubscribed',
         resume_at = excluded.resume_at,
         note = 'focus',
         updated_at = CURRENT_TIMESTAMP`,
    ).run(agentName, channel, resumeAt);
  }
  return resumeAt;
}

function resumeExpired(db: Database, agentName: string, now: string): number {
  const expired = db.prepare(
    `SELECT channel FROM fleet_channel_subscriptions
     WHERE agent_name = ? AND status = 'unsubscribed' AND note = 'focus' AND resume_at <= ?`,
  ).all(agentName, now) as Array<{ channel: string }>;
  for (const row of expired) {
    db.prepare(
      `UPDATE fleet_channel_subscriptions SET status = 'subscribed', resume_at = NULL, note = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE agent_name = ? AND channel = ? AND status = 'unsubscribed' AND note = 'focus'`,
    ).run(agentName, row.channel);
  }
  return expired.length;
}

function getRow(db: Database, agentName: string, channel: string): any {
  return db.prepare("SELECT * FROM fleet_channel_subscriptions WHERE agent_name = ? AND channel = ?").get(agentName, channel);
}

describe("focus action — subscription writes", () => {
  it("sets channel to unsubscribed", () => {
    const db = makeStateDb();
    applyFocus(db, "claude", ["public"], 60);
    const row = getRow(db, "claude", "public");
    expect(row.status).toBe("unsubscribed");
  });

  it("sets note to 'focus'", () => {
    const db = makeStateDb();
    applyFocus(db, "claude", ["public"], 60);
    expect(getRow(db, "claude", "public").note).toBe("focus");
  });

  it("sets resume_at in the future", () => {
    const db = makeStateDb();
    applyFocus(db, "claude", ["public"], 60);
    const resumeAt = getRow(db, "claude", "public").resume_at;
    expect(new Date(resumeAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("handles multiple channels", () => {
    const db = makeStateDb();
    applyFocus(db, "claude", ["public", "ambient"], 120);
    expect(getRow(db, "claude", "public").status).toBe("unsubscribed");
    expect(getRow(db, "claude", "ambient").status).toBe("unsubscribed");
  });

  it("overwrites existing subscription for same channel", () => {
    const db = makeStateDb();
    db.prepare("INSERT INTO fleet_channel_subscriptions (agent_name, channel, status) VALUES (?, ?, 'subscribed')").run("claude", "public");
    applyFocus(db, "claude", ["public"], 60);
    expect(getRow(db, "claude", "public").status).toBe("unsubscribed");
  });

  it("does not affect other agents", () => {
    const db = makeStateDb();
    db.prepare("INSERT INTO fleet_channel_subscriptions (agent_name, channel, status) VALUES (?, ?, 'subscribed')").run("gemini", "public");
    applyFocus(db, "claude", ["public"], 60);
    expect(getRow(db, "gemini", "public").status).toBe("subscribed");
  });
});

describe("resumeExpiredFocusWindows", () => {
  it("resumes expired focus subscriptions", () => {
    const db = makeStateDb();
    const past = new Date(Date.now() - 10000).toISOString();
    db.prepare(
      "INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES (?, ?, 'unsubscribed', ?, 'focus')",
    ).run("claude", "public", past);
    const resumed = resumeExpired(db, "claude", new Date().toISOString());
    expect(resumed).toBe(1);
    expect(getRow(db, "claude", "public").status).toBe("subscribed");
  });

  it("does not resume future focus windows", () => {
    const db = makeStateDb();
    const future = new Date(Date.now() + 60000).toISOString();
    db.prepare(
      "INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES (?, ?, 'unsubscribed', ?, 'focus')",
    ).run("claude", "public", future);
    const resumed = resumeExpired(db, "claude", new Date().toISOString());
    expect(resumed).toBe(0);
    expect(getRow(db, "claude", "public").status).toBe("unsubscribed");
  });

  it("does not resume manually unsubscribed (non-focus) channels", () => {
    const db = makeStateDb();
    const past = new Date(Date.now() - 10000).toISOString();
    db.prepare(
      "INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES (?, ?, 'unsubscribed', ?, 'manual')",
    ).run("claude", "public", past);
    const resumed = resumeExpired(db, "claude", new Date().toISOString());
    expect(resumed).toBe(0);
  });

  it("clears resume_at and note after resuming", () => {
    const db = makeStateDb();
    const past = new Date(Date.now() - 10000).toISOString();
    db.prepare(
      "INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES (?, ?, 'unsubscribed', ?, 'focus')",
    ).run("claude", "ambient", past);
    resumeExpired(db, "claude", new Date().toISOString());
    const row = getRow(db, "claude", "ambient");
    expect(row.resume_at).toBeNull();
    expect(row.note).toBeNull();
  });

  it("returns count of resumed channels", () => {
    const db = makeStateDb();
    const past = new Date(Date.now() - 10000).toISOString();
    db.prepare("INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES (?, 'ch1', 'unsubscribed', ?, 'focus')").run("claude", past);
    db.prepare("INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES (?, 'ch2', 'unsubscribed', ?, 'focus')").run("claude", past);
    const resumed = resumeExpired(db, "claude", new Date().toISOString());
    expect(resumed).toBe(2);
  });

  it("does not resume channels of other agents", () => {
    const db = makeStateDb();
    const past = new Date(Date.now() - 10000).toISOString();
    db.prepare("INSERT INTO fleet_channel_subscriptions (agent_name, channel, status, resume_at, note) VALUES ('gemini', 'public', 'unsubscribed', ?, 'focus')").run(past);
    const resumed = resumeExpired(db, "claude", new Date().toISOString());
    expect(resumed).toBe(0);
    expect(getRow(db, "gemini", "public").status).toBe("unsubscribed");
  });
});

describe("focus action — parseAction validation", () => {
  function parseFocus(value: unknown): { type: "focus"; channels: string[]; duration_sec: number } | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (v.type !== "focus") return null;
    if (!Array.isArray(v.channels) || v.channels.length === 0) return null;
    const channels = (v.channels as unknown[]).filter((c) => typeof c === "string" && (c as string).trim()).map((c) => (c as string).trim());
    if (channels.length === 0) return null;
    const durationSec = typeof v.duration_sec === "number" ? Math.floor(v.duration_sec) : NaN;
    if (!Number.isFinite(durationSec) || durationSec < 1) return null;
    return { type: "focus", channels, duration_sec: durationSec };
  }

  it("parses valid focus action", () => {
    const result = parseFocus({ type: "focus", channels: ["public"], duration_sec: 300 });
    expect(result).not.toBeNull();
    expect(result!.channels).toEqual(["public"]);
    expect(result!.duration_sec).toBe(300);
  });

  it("rejects empty channels array", () => {
    expect(parseFocus({ type: "focus", channels: [], duration_sec: 60 })).toBeNull();
  });

  it("rejects channels with only whitespace strings", () => {
    expect(parseFocus({ type: "focus", channels: ["  "], duration_sec: 60 })).toBeNull();
  });

  it("rejects duration_sec < 1", () => {
    expect(parseFocus({ type: "focus", channels: ["public"], duration_sec: 0 })).toBeNull();
  });

  it("rejects non-numeric duration_sec", () => {
    expect(parseFocus({ type: "focus", channels: ["public"], duration_sec: "60" })).toBeNull();
  });

  it("floors fractional duration_sec", () => {
    const result = parseFocus({ type: "focus", channels: ["public"], duration_sec: 59.9 });
    expect(result!.duration_sec).toBe(59);
  });

  it("trims whitespace from channel names", () => {
    const result = parseFocus({ type: "focus", channels: [" public "], duration_sec: 60 });
    expect(result!.channels).toEqual(["public"]);
  });

  it("accepts multiple channels", () => {
    const result = parseFocus({ type: "focus", channels: ["public", "ambient"], duration_sec: 60 });
    expect(result!.channels).toEqual(["public", "ambient"]);
  });
});
