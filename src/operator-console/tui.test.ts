import { describe, expect, test } from "bun:test";
import { createInitialState, reduceTuiState, renderScreen, type OperatorSnapshot } from "./tui";

const snapshot: OperatorSnapshot = {
  agents: [
    {
      agent_name: "claude",
      status: "thinking",
      health_status: "active",
      current_task: "investigate queue drift",
      wake_reason: "mail burst",
      cooldown_until: null,
      updated_at: "2026-04-18T12:00:00Z",
    },
    {
      agent_name: "gemini",
      status: "idle",
      health_status: "latent",
      current_task: null,
      wake_reason: null,
      cooldown_until: "2026-04-18T12:05:00Z",
      updated_at: "2026-04-18T12:01:00Z",
    },
  ],
  queueTotals: { jobs: 3, alarms: 1, events: 2 },
  queueByAgent: [
    { agent_name: "claude", jobs: 2, alarms: 1, events: 0 },
    { agent_name: "gemini", jobs: 1, alarms: 0, events: 2 },
  ],
  unreadCount: 4,
  recentMail: [
    {
      id: 1,
      layer: "private",
      recipient: "operator",
      sender: "claude",
      body: "need review",
      read_at: null,
      created_at: "2026-04-18T12:00:00Z",
    },
  ],
};

describe("operator console tui", () => {
  test("render overview includes core totals", () => {
    const screen = renderScreen(createInitialState(), snapshot, 100, 24);
    expect(screen).toContain("operator-console");
    expect(screen).toContain("agents=2");
    expect(screen).toContain("unread=4");
    expect(screen).toContain("claude");
  });

  test("mail enter primes compose reply", () => {
    let state = createInitialState();
    [state] = reduceTuiState(state, { type: "key", sequence: "2" }, snapshot);
    const [next] = reduceTuiState(state, { type: "key", sequence: "\r", name: "return" }, snapshot);
    expect(next.activeTab).toBe("compose");
    expect(next.composeRecipient).toBe("claude");
    expect(next.composeField).toBe("body");
  });

  test("compose enter emits send effect", () => {
    let state = createInitialState();
    [state] = reduceTuiState(state, { type: "key", sequence: "3" }, snapshot);
    [state] = reduceTuiState(state, { type: "key", sequence: "a" }, snapshot);
    [state] = reduceTuiState(state, { type: "key", sequence: "l" }, snapshot);
    [state] = reduceTuiState(state, { type: "key", sequence: "l" }, snapshot);
    [state] = reduceTuiState(state, { type: "key", sequence: "\n", name: "down" }, snapshot);
    [state] = reduceTuiState(state, { type: "key", sequence: "h" }, snapshot);
    [state] = reduceTuiState(state, { type: "key", sequence: "i" }, snapshot);
    const [next, effect] = reduceTuiState(state, { type: "key", sequence: "\r", name: "return" }, snapshot);
    expect(effect).toEqual({ type: "send", recipient: "all", body: "hi" });
    expect(next.composeBody).toBe("");
  });
});
