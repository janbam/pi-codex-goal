import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGoalPersistence } from "../src/goal-persistence.js";
import { createGoalStateController } from "../src/goal-state-controller.js";
import {
  createGoalRecoveryMachine,
  recoveryPhaseNeedsUserStartTurn,
} from "../src/recovery-machine.js";
import type { StatusContext } from "../src/goal-runtime-status.js";
import { isGoalCustomEntry } from "../src/state.js";
import type { ThreadGoal } from "../src/types.js";

const activeGoal: ThreadGoal = {
  goalId: "goal-a",
  objective: "ship it",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  createdAt: 0,
  updatedAt: 0,
};

function createStateControllerTestHarness(goal: ThreadGoal | null = activeGoal) {
  const recoveryState = createGoalRecoveryMachine();
  const entries: unknown[] = [];
  const pi = {
    appendEntry(_type: string, data: unknown) {
      entries.push(data);
    },
  } satisfies Pick<ExtensionAPI, "appendEntry">;

  const persistence = createGoalPersistence({ pi });
  if (goal) {
    persistence.setGoalSnapshot(goal);
  }

  let refreshCount = 0;
  const ctx = {
    ui: { setStatus() {} },
  } satisfies StatusContext;

  // Record applied transition effects so tests can assert the effect bundle,
  // not just the persisted snapshot.
  const effectCalls: string[] = [];
  const record = (name: string) => () => {
    effectCalls.push(name);
  };

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => recoveryState,
    transitionEffectHandlers: {
      clearContinuation: record("clearContinuation"),
      clearActiveAccounting: record("clearActiveAccounting"),
      resetRecovery: record("resetRecovery"),
      clearBudgetWarning: record("clearBudgetWarning"),
      clearHostOverflowRecovery: record("clearHostOverflowRecovery"),
      setRecoveryPausedAttention: record("setRecoveryPausedAttention"),
      markContinuationQueued: record("markContinuationQueued"),
      stopStatusRefresh: record("stopStatusRefresh"),
    },
    refreshUi: () => {
      refreshCount += 1;
    },
  });

  return {
    ctx,
    stateController,
    entries,
    persistence,
    effectCalls,
    get refreshCount() {
      return refreshCount;
    },
    get recoveryState() {
      return recoveryState;
    },
  };
}

test("goal snapshots are cloned at persistence and controller boundaries", () => {
  const sourceGoal: ThreadGoal = {
    ...activeGoal,
    goalId: "clone-boundary",
    usage: { tokensUsed: 1, activeSeconds: 2 },
  };
  const harness = createStateControllerTestHarness(sourceGoal);

  sourceGoal.objective = "mutated source";
  sourceGoal.usage.tokensUsed = 999;

  const firstRead = harness.stateController.getGoal();
  assert.ok(firstRead);
  assert.equal(firstRead.objective, "ship it");
  assert.equal(firstRead.usage.tokensUsed, 1);

  firstRead.objective = "mutated read";
  firstRead.usage.tokensUsed = 123;

  const secondRead = harness.stateController.getGoal();
  assert.ok(secondRead);
  assert.equal(secondRead.objective, "ship it");
  assert.equal(secondRead.usage.tokensUsed, 1);

  const directRead = harness.persistence.getGoal();
  assert.ok(directRead);
  directRead.usage.activeSeconds = 456;
  assert.equal(harness.persistence.getGoal()?.usage.activeSeconds, 2);
});

test("beginOverflowRecovery without an active goal records user reset only", () => {
  const harness = createStateControllerTestHarness(null);

  harness.stateController.beginOverflowRecovery(harness.ctx);
  assert.equal(harness.recoveryState.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(harness.recoveryState.attention, null);
  assert.equal(recoveryPhaseNeedsUserStartTurn(harness.recoveryState.phase), true);
  assert.equal(harness.refreshCount, 0);
  assert.equal(harness.entries.length, 1);

  harness.stateController.beginOverflowRecovery(harness.ctx);
  assert.equal(harness.entries.length, 1);
});

test("beginOverflowRecovery with a paused goal records user reset without pending attention", () => {
  const pausedGoal: ThreadGoal = { ...activeGoal, status: "paused" };
  const harness = createStateControllerTestHarness(pausedGoal);

  harness.stateController.beginOverflowRecovery(harness.ctx);
  assert.equal(harness.recoveryState.phase.kind, "hostOverflowNeedsUserStart");
  assert.equal(harness.recoveryState.attention, null);
  assert.equal(harness.refreshCount, 0);
  assert.equal(harness.entries.length, 1);
  const entry = harness.entries[0] as { kind?: string; active?: boolean };
  assert.equal(entry.kind, "host_overflow_cap_reset");
  assert.equal(entry.active, true);
});

test("beginOverflowRecovery with an active goal records pending attention and durable reset", () => {
  const harness = createStateControllerTestHarness(activeGoal);

  harness.stateController.beginOverflowRecovery(harness.ctx);
  assert.equal(harness.recoveryState.phase.kind, "hostOverflowRecoveringNeedsUserStart");
  assert.deepEqual(harness.recoveryState.attention, {
    kind: "pending",
    reason: "recovering from context overflow",
  });
  assert.equal(harness.refreshCount, 1);
  assert.equal(harness.entries.length, 1);
  const entry = harness.entries[0] as { kind?: string; active?: boolean };
  assert.equal(entry.kind, "host_overflow_cap_reset");
  assert.equal(entry.active, true);
});

test("persistHostOverflowUserReset appends only when phase changes", () => {
  const harness = createStateControllerTestHarness(null);

  harness.stateController.persistHostOverflowUserReset(true);
  assert.equal(harness.entries.length, 1);

  harness.stateController.persistHostOverflowUserReset(true);
  assert.equal(harness.entries.length, 1);

  harness.stateController.persistHostOverflowUserReset(false);
  assert.equal(harness.entries.length, 2);
  const cleared = harness.entries[1] as { kind?: string; active?: boolean };
  assert.equal(cleared.kind, "host_overflow_cap_reset");
  assert.equal(cleared.active, false);
});

test("pauseGoal transitions an active goal to paused and persists a tool-sourced snapshot", () => {
  const harness = createStateControllerTestHarness(activeGoal);

  const result = harness.stateController.pauseGoal("tool", harness.ctx);

  assert.equal(result.ok, true);
  assert.equal(result.goal?.status, "paused");
  const pauseEntries = harness.entries.flatMap((entry) =>
    isGoalCustomEntry(entry) && entry.kind === "set" && entry.source === "tool" ? [entry] : [],
  );
  assert.equal(pauseEntries.length, 1);
  assert.equal(pauseEntries[0]?.goal.status, "paused");
  // Tool pause must carry the same effect bundle as other pause paths,
  // including recovery reset, so no stale recovery state survives.
  assert.deepEqual(harness.effectCalls, [
    "clearContinuation",
    "clearActiveAccounting",
    "resetRecovery",
    "clearBudgetWarning",
  ]);
});

test("pauseGoal rejects goals that are not active", () => {
  const pausedHarness = createStateControllerTestHarness({ ...activeGoal, status: "paused" });
  assert.equal(pausedHarness.stateController.pauseGoal("tool", pausedHarness.ctx).ok, false);

  const budgetHarness = createStateControllerTestHarness({
    ...activeGoal,
    status: "budgetLimited",
    tokenBudget: 10,
    usage: { tokensUsed: 10, activeSeconds: 0 },
  });
  const result = budgetHarness.stateController.pauseGoal("tool", budgetHarness.ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /Only active goals can be paused/);
});

test("pauseGoal rejects when no goal exists", () => {
  const harness = createStateControllerTestHarness(null);

  const result = harness.stateController.pauseGoal("tool", harness.ctx);

  assert.equal(result.ok, false);
  assert.equal(result.goal, null);
});
