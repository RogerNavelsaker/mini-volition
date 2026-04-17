import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureMailSchema, getUnread, countUnread, peekBurst, claimBurst, type FleetMessage } from "./core";
import { ensureSchema, getSubscriptions } from "../agent-state/schema";

function makeMailDb(): Database {
  const db = new Database(":memory:");
  ensureMailSchema(db);
  return db;
}

function makeStateDb(): Database {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertMsg(db: Database, sender: string, recipient: string, layer: string, body: string): number {
  const result = db.prepare(
    `INSERT INTO fleet_comms (sender, recipient, layer, body) VALUES (?, ?, ?, ?)`,
  ).run(sender, recipient, layer, body);
  return Number(result.lastInsertRowid);
}

describe("agent_channel_subscriptions schema", () => {
  it("creates the table", () => {
    const db = makeStateDb();
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_channel_subscriptions'`).get();
    expect(row).not.toBeNull();
  });

  it("enforces UNIQUE(agent_name, layer)", () => {
    const db = makeStateDb();
    db.run(`INSERT INTO agent_channel_subscriptions (agent_name, layer) VALUES ('agent-a', 'public')`);
    expect(() => {
      db.run(`INSERT INTO agent_channel_subscriptions (agent_name, layer) VALUES ('agent-a', 'public')`);
    }).toThrow();
  });
});

describe("getSubscriptions", () => {
  it("returns empty array when no subscriptions", () => {
    const db = makeStateDb();
    expect(getSubscriptions(db, "agent-a")).toEqual([]);
  });

  it("returns subscribed layers for agent", () => {
    const db = makeStateDb();
    db.run(`INSERT INTO agent_channel_subscriptions (agent_name, layer) VALUES ('agent-a', 'public')`);
    db.run(`INSERT INTO agent_channel_subscriptions (agent_name, layer) VALUES ('agent-a', 'urgent')`);
    expect(getSubscriptions(db, "agent-a")).toEqual(["public", "urgent"]);
  });

  it("does not return other agents' subscriptions", () => {
    const db = makeStateDb();
    db.run(`INSERT INTO agent_channel_subscriptions (agent_name, layer) VALUES ('agent-b', 'private')`);
    expect(getSubscriptions(db, "agent-a")).toEqual([]);
  });
});

describe("getUnread — subscription filtering", () => {
  let mailDb: Database;

  beforeEach(() => { mailDb = makeMailDb(); });

  it("returns all messages when no subscriptions", () => {
    insertMsg(mailDb, "sender", "agent-a", "public", "pub msg");
    insertMsg(mailDb, "sender", "agent-a", "private", "priv msg");
    const msgs = getUnread(mailDb, "agent-a");
    expect(msgs).toHaveLength(2);
  });

  it("filters broadcast messages to subscribed layers", () => {
    insertMsg(mailDb, "sender", "all", "public", "pub broadcast");
    insertMsg(mailDb, "sender", "all", "private", "priv broadcast");
    const msgs = getUnread(mailDb, "agent-a", ["public"]);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as FleetMessage).layer).toBe("public");
  });

  it("always includes direct messages regardless of subscription", () => {
    insertMsg(mailDb, "sender", "agent-a", "noise", "direct message");
    const msgs = getUnread(mailDb, "agent-a", ["public"]);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as FleetMessage).layer).toBe("noise");
  });

  it("returns nothing for broadcast when subscribed to different layer", () => {
    insertMsg(mailDb, "sender", "all", "private", "private broadcast");
    const msgs = getUnread(mailDb, "agent-a", ["public"]);
    expect(msgs).toHaveLength(0);
  });

  it("empty subscription array has same effect as no subscriptions", () => {
    insertMsg(mailDb, "sender", "all", "public", "pub msg");
    insertMsg(mailDb, "sender", "all", "private", "priv msg");
    const noFilter = getUnread(mailDb, "agent-a");
    const emptyFilter = getUnread(mailDb, "agent-a", []);
    expect(emptyFilter).toHaveLength(noFilter.length);
  });

  it("excludes sender's own messages", () => {
    insertMsg(mailDb, "agent-a", "all", "public", "my own message");
    const msgs = getUnread(mailDb, "agent-a", ["public"]);
    expect(msgs).toHaveLength(0);
  });
});

describe("countUnread with subscriptions", () => {
  it("counts only subscribed broadcast messages", () => {
    const mailDb = makeMailDb();
    insertMsg(mailDb, "sender", "all", "public", "pub");
    insertMsg(mailDb, "sender", "all", "private", "priv");
    expect(countUnread(mailDb, "agent-a", ["public"])).toBe(1);
    expect(countUnread(mailDb, "agent-a")).toBe(2);
  });
});

describe("peekBurst and claimBurst with subscriptions", () => {
  it("peekBurst returns null when no messages on subscribed layer", () => {
    const mailDb = makeMailDb();
    insertMsg(mailDb, "sender", "all", "private", "private msg");
    const burst = peekBurst(mailDb, "agent-a", 6, 300, ["public"]);
    expect(burst).toBeNull();
  });

  it("claimBurst only claims messages on subscribed layer", () => {
    const mailDb = makeMailDb();
    insertMsg(mailDb, "sender", "all", "public", "pub msg");
    insertMsg(mailDb, "sender", "all", "private", "priv msg");
    const burst = claimBurst(mailDb, "agent-a", 6, 300, undefined, ["public"]);
    expect(burst).not.toBeNull();
    expect(burst!.messages).toHaveLength(1);
    expect(burst!.messages[0].layer).toBe("public");
  });
});
