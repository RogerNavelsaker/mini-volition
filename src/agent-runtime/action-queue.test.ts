import { describe, test, expect } from "bun:test";
import { executeActionQueue, loadCompletedActionIndexes, HaltError, type ActionRecord, type ActionQueueCallbacks } from "./action-queue";

function makeCallbacks(overrides: Partial<ActionQueueCallbacks> = {}): ActionQueueCallbacks & { journal: jest.Mock; log: jest.Mock } {
  const journaled: Array<[string, number, string, string | null]> = [];
  const logged: string[] = [];
  return {
    journal: (type, idx, phase, detail) => journaled.push([type, idx, phase, detail]),
    execute: async () => null,
    escalate: () => {},
    log: (msg) => logged.push(msg),
    _journaled: journaled,
    _logged: logged,
    ...overrides,
  } as any;
}

describe("executeActionQueue", () => {
  test("executes all known actions in order", async () => {
    const executed: string[] = [];
    const cbs = makeCallbacks({
      execute: async (action) => { executed.push(action.type); return null; },
    });
    const actions: ActionRecord[] = [
      { type: "note" },
      { type: "reply" },
      { type: "queue_task" },
    ];
    const result = await executeActionQueue(actions, cbs);
    expect(result.executed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.halted).toBe(false);
    expect(executed).toEqual(["note", "reply", "queue_task"]);
  });

  test("journals planned → started → completed for each action", async () => {
    const journaled: Array<[string, number, string, string | null]> = [];
    const cbs = makeCallbacks({
      journal: (type, idx, phase, detail) => journaled.push([type, idx, phase, detail]),
    });
    await executeActionQueue([{ type: "note" }], cbs);
    expect(journaled.map(([, , phase]) => phase)).toEqual(["planned", "started", "completed"]);
    expect(journaled.every(([, idx]) => idx === 1)).toBe(true);
  });

  test("skips completed indexes from prior run", async () => {
    const executed: number[] = [];
    const cbs = makeCallbacks({
      execute: async (_, idx) => { executed.push(idx); return null; },
    });
    const actions: ActionRecord[] = [
      { type: "reply" },
      { type: "note" },
      { type: "queue_task" },
    ];
    const result = await executeActionQueue(actions, cbs, new Set([1, 3]));
    expect(result.executed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(executed).toEqual([2]);
  });

  test("journals 'skipped' phase for completed indexes", async () => {
    const journaled: Array<[string, number, string, string | null]> = [];
    const cbs = makeCallbacks({
      journal: (type, idx, phase, detail) => journaled.push([type, idx, phase, detail]),
    });
    await executeActionQueue([{ type: "note" }, { type: "reply" }], cbs, new Set([2]));
    const phases = journaled.map(([, , phase]) => phase);
    expect(phases).toContain("skipped");
    // Action 1 (note) runs normally; action 2 (reply) is skipped — no planned/started for index 2
    const skippedEntry = journaled.find(([, , phase]) => phase === "skipped");
    expect(skippedEntry?.[1]).toBe(2);
    const action2Phases = journaled.filter(([, idx]) => idx === 2).map(([, , phase]) => phase);
    expect(action2Phases).toEqual(["skipped"]);
  });

  test("halts and escalates on unknown action type", async () => {
    let escalated = "";
    const cbs = makeCallbacks({ escalate: (msg) => { escalated = msg; } });
    const result = await executeActionQueue([{ type: "unknown_action" }], cbs);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toContain("unknown_action");
    expect(escalated).toContain("unknown_action");
  });

  test("does not execute actions after an unknown action", async () => {
    const executed: string[] = [];
    const cbs = makeCallbacks({
      execute: async (action) => { executed.push(action.type); return null; },
      escalate: () => {},
    });
    const actions: ActionRecord[] = [
      { type: "note" },
      { type: "bad_type" },
      { type: "reply" },
    ];
    const result = await executeActionQueue(actions, cbs);
    expect(result.halted).toBe(true);
    expect(executed).toEqual(["note"]);
  });

  test("journals 'failed' phase on unknown action type", async () => {
    const journaled: Array<[string, number, string, string | null]> = [];
    const cbs = makeCallbacks({
      journal: (type, idx, phase, detail) => journaled.push([type, idx, phase, detail]),
      escalate: () => {},
    });
    await executeActionQueue([{ type: "alien_action" }], cbs);
    expect(journaled.some(([, , phase]) => phase === "failed")).toBe(true);
  });

  test("journals 'failed' and rethrows on execute error", async () => {
    const journaled: Array<[string, number, string, string | null]> = [];
    const cbs = makeCallbacks({
      journal: (type, idx, phase, detail) => journaled.push([type, idx, phase, detail]),
      execute: async () => { throw new Error("exec-boom"); },
    });
    await expect(executeActionQueue([{ type: "reply" }], cbs)).rejects.toThrow("exec-boom");
    expect(journaled.some(([, , phase]) => phase === "failed")).toBe(true);
    const failEntry = journaled.find(([, , phase]) => phase === "failed");
    expect(failEntry?.[3]).toContain("exec-boom");
  });

  test("stops executing after execute throws — subsequent actions not run", async () => {
    const executed: number[] = [];
    const cbs = makeCallbacks({
      execute: async (_, idx) => {
        if (idx === 1) throw new Error("fail-at-1");
        executed.push(idx);
        return null;
      },
    });
    const actions: ActionRecord[] = [{ type: "note" }, { type: "reply" }];
    await expect(executeActionQueue(actions, cbs)).rejects.toThrow("fail-at-1");
    expect(executed).toEqual([]);
  });

  test("returns halted=false haltReason=null on clean run", async () => {
    const cbs = makeCallbacks();
    const result = await executeActionQueue([{ type: "noop" }], cbs);
    expect(result.halted).toBe(false);
    expect(result.haltReason).toBeNull();
  });

  test("empty action list runs without error", async () => {
    const cbs = makeCallbacks();
    const result = await executeActionQueue([], cbs);
    expect(result.executed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.halted).toBe(false);
  });

  test("all known action types pass the type guard", async () => {
    const knownTypes = ["reply", "note", "noop", "sleep_until", "queue_task", "escalate", "scratchpad", "spawn_scribe"];
    for (const type of knownTypes) {
      const cbs = makeCallbacks();
      const result = await executeActionQueue([{ type }], cbs);
      expect(result.halted).toBe(false, `type '${type}' should be known`);
    }
  });
});

describe("loadCompletedActionIndexes", () => {
  test("returns empty set when no completed rows", () => {
    const result = loadCompletedActionIndexes(() => [], "agent-a", 42);
    expect(result.size).toBe(0);
  });

  test("returns set of completed action_index values", () => {
    const rows = [
      { action_index: 1, phase: "completed" },
      { action_index: 3, phase: "completed" },
    ];
    const result = loadCompletedActionIndexes(() => rows, "agent-a", 42);
    expect(result).toEqual(new Set([1, 3]));
  });

  test("passes correct query args", () => {
    let capturedArgs: unknown[] = [];
    loadCompletedActionIndexes((query, ...args) => {
      capturedArgs = args;
      return [];
    }, "my-agent", 99);
    expect(capturedArgs).toEqual(["my-agent", 99]);
  });
});
