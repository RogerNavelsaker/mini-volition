import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  detectNoisyChannels,
  ensureFocusSchema,
  suspendChannel,
  resumeChannel,
  applyDirectives,
  checkExpiredSuspensions,
  isSuspended,
  listFocusEntries,
  getFocusEntry,
} from "./focus";
import type { ChannelEvent, FocusConfig } from "./focus";

const NOW = "2026-04-18T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const CONFIG: FocusConfig = {
  window_ms: 60_000,
  burst_threshold: 5,
  suspend_ms: 300_000,
};

function makeDb(): Database {
  const db = new Database(":memory:");
  ensureFocusSchema(db);
  return db;
}

function ts(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function events(channel: string, count: number, startOffset = -50_000): ChannelEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    channel,
    timestamp: ts(startOffset + i * 1000),
  }));
}

describe("detectNoisyChannels", () => {
  it("returns empty when no events", () => {
    expect(detectNoisyChannels([], CONFIG, NOW)).toHaveLength(0);
  });

  it("does not flag channels below threshold", () => {
    const result = detectNoisyChannels(events("chat:general", 4), CONFIG, NOW);
    expect(result).toHaveLength(0);
  });

  it("flags channels at threshold", () => {
    const result = detectNoisyChannels(events("chat:general", 5), CONFIG, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe("chat:general");
    expect(result[0].count).toBe(5);
  });

  it("flags channels above threshold", () => {
    const result = detectNoisyChannels(events("chat:general", 10), CONFIG, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(10);
  });

  it("excludes events outside the window", () => {
    // All 10 events are before the window start (no event falls within)
    const oldEvts: ChannelEvent[] = Array.from({ length: 10 }, (_, i) => ({
      channel: "chat:old",
      timestamp: ts(-(CONFIG.window_ms + 10_000 + i * 100)),
    }));
    const result = detectNoisyChannels(oldEvts, CONFIG, NOW);
    expect(result).toHaveLength(0);
  });

  it("computes resume_at = now + suspend_ms", () => {
    const result = detectNoisyChannels(events("chan", 5), CONFIG, NOW);
    const expected = new Date(NOW_MS + CONFIG.suspend_ms).toISOString();
    expect(result[0].resume_at).toBe(expected);
  });

  it("handles multiple channels independently", () => {
    const evts = [
      ...events("chat:noisy", 8),
      ...events("chat:quiet", 2),
      ...events("chat:medium", 5),
    ];
    const result = detectNoisyChannels(evts, CONFIG, NOW);
    expect(result).toHaveLength(2);
    const channels = result.map((d) => d.channel);
    expect(channels).toContain("chat:noisy");
    expect(channels).toContain("chat:medium");
  });

  it("sorts directives by count descending", () => {
    const evts = [
      ...events("chan-a", 6),
      ...events("chan-b", 10),
    ];
    const result = detectNoisyChannels(evts, CONFIG, NOW);
    expect(result[0].channel).toBe("chan-b");
    expect(result[1].channel).toBe("chan-a");
  });

  it("includes reason string", () => {
    const result = detectNoisyChannels(events("chan", 5), CONFIG, NOW);
    expect(result[0].reason).toContain("burst");
    expect(result[0].reason).toContain("5");
  });
});

describe("suspendChannel / resumeChannel", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("creates a suspended entry", () => {
    const entry = suspendChannel(db, "claude", "chat:general", ts(300_000), "burst: 5", NOW);
    expect(entry.status).toBe("suspended");
    expect(entry.agent_name).toBe("claude");
    expect(entry.channel).toBe("chat:general");
    expect(entry.reason).toBe("burst: 5");
  });

  it("updates existing entry on re-suspend", () => {
    suspendChannel(db, "claude", "chat:general", ts(300_000), "first", NOW);
    const entry = suspendChannel(db, "claude", "chat:general", ts(600_000), "second", NOW);
    expect(entry.reason).toBe("second");
  });

  it("resumeChannel sets status=active and clears fields", () => {
    suspendChannel(db, "claude", "chat:general", ts(300_000), "burst", NOW);
    const entry = resumeChannel(db, "claude", "chat:general", NOW);
    expect(entry?.status).toBe("active");
    expect(entry?.resume_at).toBeNull();
    expect(entry?.suspended_at).toBeNull();
    expect(entry?.reason).toBeNull();
  });

  it("resumeChannel creates active entry if none exists", () => {
    const entry = resumeChannel(db, "claude", "chat:new", NOW);
    expect(entry?.status).toBe("active");
  });
});

describe("isSuspended", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns false for unknown channel", () => {
    expect(isSuspended(db, "claude", "chat:x", NOW)).toBe(false);
  });

  it("returns true while suspension is active", () => {
    suspendChannel(db, "claude", "chat:general", ts(300_000), "burst", NOW);
    expect(isSuspended(db, "claude", "chat:general", NOW)).toBe(true);
  });

  it("returns false when resume_at is in the past", () => {
    suspendChannel(db, "claude", "chat:general", ts(-1000), "burst", NOW);
    expect(isSuspended(db, "claude", "chat:general", NOW)).toBe(false);
  });

  it("returns false after resumeChannel", () => {
    suspendChannel(db, "claude", "chat:general", ts(300_000), "burst", NOW);
    resumeChannel(db, "claude", "chat:general", NOW);
    expect(isSuspended(db, "claude", "chat:general", NOW)).toBe(false);
  });
});

describe("applyDirectives", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("applies all directives", () => {
    const directives = detectNoisyChannels(
      [...events("chan-a", 8), ...events("chan-b", 6)],
      CONFIG, NOW,
    );
    const entries = applyDirectives(db, "claude", directives, NOW);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.status === "suspended")).toBe(true);
  });

  it("returns empty array when no directives", () => {
    expect(applyDirectives(db, "claude", [], NOW)).toHaveLength(0);
  });
});

describe("checkExpiredSuspensions", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("resumes channels whose resume_at has passed", () => {
    suspendChannel(db, "claude", "chan-a", ts(-1000), "burst", ts(-60_000));
    suspendChannel(db, "claude", "chan-b", ts(-500), "burst", ts(-60_000));
    const resumed = checkExpiredSuspensions(db, "claude", NOW);
    expect(resumed).toHaveLength(2);
    expect(resumed.every((e) => e.status === "active")).toBe(true);
  });

  it("does not touch channels whose suspension is still active", () => {
    suspendChannel(db, "claude", "chan-still", ts(300_000), "burst", NOW);
    const resumed = checkExpiredSuspensions(db, "claude", NOW);
    expect(resumed).toHaveLength(0);
    expect(isSuspended(db, "claude", "chan-still", NOW)).toBe(true);
  });

  it("returns empty when no suspended channels", () => {
    expect(checkExpiredSuspensions(db, "claude", NOW)).toHaveLength(0);
  });
});

describe("listFocusEntries / getFocusEntry", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty for agent with no entries", () => {
    expect(listFocusEntries(db, "claude")).toHaveLength(0);
  });

  it("lists all entries for agent", () => {
    suspendChannel(db, "claude", "chan-a", ts(300_000), "burst", NOW);
    resumeChannel(db, "claude", "chan-b", NOW);
    const entries = listFocusEntries(db, "claude");
    expect(entries).toHaveLength(2);
  });

  it("does not include other agents' entries", () => {
    suspendChannel(db, "claude", "chan", ts(300_000), "burst", NOW);
    suspendChannel(db, "gemini", "chan", ts(300_000), "burst", NOW);
    expect(listFocusEntries(db, "claude")).toHaveLength(1);
  });

  it("getFocusEntry returns null for unknown", () => {
    expect(getFocusEntry(db, "claude", "unknown")).toBeNull();
  });

  it("getFocusEntry returns the entry", () => {
    suspendChannel(db, "claude", "chan", ts(300_000), "burst", NOW);
    const entry = getFocusEntry(db, "claude", "chan");
    expect(entry?.channel).toBe("chan");
  });
});
