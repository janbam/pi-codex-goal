import assert from "node:assert/strict";
import test from "node:test";

import { isGoalCustomEntry } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import {
  assistantMessage,
  createRuntimeHarness,
} from "./support/runtime-harness.js";

test("pause_goal pauses an active goal and persists a tool-sourced paused snapshot", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  assert.equal(harness.snapshot().goal?.status, "active");

  const result = (await harness.runTool("pause_goal", {
    reason: "missing deploy credentials",
  })) as { content: Array<{ text: string }>; details: { goal: { status: string } | null } };

  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "paused");
  assert.equal(result.details.goal?.status, "paused");
  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, /missing deploy credentials/);
  assert.match(text, /\/goal resume/);

  // The persisted snapshot must record the tool as the pause source so
  // session replay distinguishes agent pauses from command pauses.
  const pauseEntries = harness.entries.flatMap((entry) =>
    entry.type === "custom" &&
    entry.customType === CUSTOM_ENTRY_TYPE &&
    isGoalCustomEntry(entry.data) &&
    entry.data.kind === "set" &&
    entry.data.source === "tool"
      ? [entry.data]
      : [],
  );
  assert.equal(pauseEntries.length, 1);
  assert.equal(pauseEntries[0]?.goal.status, "paused");
});

test("pause_goal rejects when no goal exists", async () => {
  const harness = createRuntimeHarness();

  await assert.rejects(
    () => harness.runTool("pause_goal", { reason: "blocked" }),
    /No active goal exists\./,
  );
});

test("pause_goal rejects a completed goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("update_goal", { status: "complete" });

  await assert.rejects(
    () => harness.runTool("pause_goal", { reason: "blocked" }),
    /Only active goals can be paused \(current status: complete\)\./,
  );
});

test("pause_goal flushes turn usage into the persisted paused snapshot", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  // A clean stop keeps the goal active while accounting the turn's tokens.
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 40, output: 2 }),
    toolResults: [],
  });
  assert.equal(harness.snapshot().goal?.status, "active");

  await harness.runTool("pause_goal", { reason: "waiting on vendor response" });

  const paused = harness.snapshot().goal;
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.usage.tokensUsed, 42);

  // The persisted paused entry must carry the flushed usage, not zeros.
  const pauseEntries = harness.entries.flatMap((entry) =>
    entry.type === "custom" &&
    entry.customType === CUSTOM_ENTRY_TYPE &&
    isGoalCustomEntry(entry.data) &&
    entry.data.kind === "set" &&
    entry.data.source === "tool"
      ? [entry.data]
      : [],
  );
  assert.equal(pauseEntries.length, 1);
  assert.equal(pauseEntries[0]?.goal.usage.tokensUsed, 42);
});

test("resume_goal reactivates a tool-paused goal and persists a tool-sourced active snapshot", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("pause_goal", { reason: "missing deploy credentials" });
  assert.equal(harness.snapshot().goal?.status, "paused");

  const result = (await harness.runTool("resume_goal", {
    reason: "user confirmed credentials were added",
  })) as { content: Array<{ text: string }>; details: { goal: { status: string } | null } };

  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(result.details.goal?.status, "active");
  const text = result.content.map((part) => part.text).join("\n");
  assert.match(text, /user confirmed credentials were added/);
  assert.match(text, /Continue working toward the objective\./);

  // Both agent-driven transitions persist with source "tool" so replay can
  // distinguish them from command and runtime transitions.
  const toolEntries = harness.entries.flatMap((entry) =>
    entry.type === "custom" &&
    entry.customType === CUSTOM_ENTRY_TYPE &&
    isGoalCustomEntry(entry.data) &&
    entry.data.kind === "set" &&
    entry.data.source === "tool"
      ? [entry.data]
      : [],
  );
  assert.equal(toolEntries.length, 2);
  assert.equal(toolEntries[0]?.goal.status, "paused");
  assert.equal(toolEntries[1]?.goal.status, "active");
});

test("resume_goal rejects an active goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await assert.rejects(
    () => harness.runTool("resume_goal", { reason: "unblocked" }),
    /Only paused goals can be resumed \(current status: active\)\./,
  );
});

test("resume_goal rejects a budgetLimited goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });

  // Spend up to the budget so accounting flips the goal to budgetLimited.
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 8, output: 2 }),
    toolResults: [],
  });
  assert.equal(harness.snapshot().goal?.status, "budgetLimited");

  await assert.rejects(
    () => harness.runTool("resume_goal", { reason: "want to continue" }),
    /Only paused goals can be resumed \(current status: budgetLimited\)\.[\s\S]*raise or replace/,
  );
});
