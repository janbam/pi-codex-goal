import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalToolResponse, toToolText, type GoalToolResponse } from "./format.js";
import { createGoal, replaceGoal } from "./state.js";
import { TOOL_PROMPT_GUIDELINES } from "./prompts.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

const EmptyParams = Type.Object({});

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue until completion.",
  }),
  token_budget: Type.Optional(
    Type.Integer({
      description: "Optional positive integer token budget.",
      minimum: 1,
    }),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        "Replace an existing non-complete goal. Use only when the user explicitly asks to set a new goal over the current one.",
    }),
  ),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete"] as const, {
    description: "Only complete is accepted. Do not call this until no required work remains.",
  }),
});

const PauseGoalParams = Type.Object({
  reason: Type.String({
    description:
      "Concrete description of the hard block and what would unblock the goal. Reported to the user.",
  }),
});

const ResumeGoalParams = Type.Object({
  reason: Type.String({
    description:
      "What resolved the hard block that caused the pause, such as the user confirming credentials were added or a blocked dependency is available again. Reported to the user.",
  }),
});

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  pauseGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  resumeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current Codex-style goal and usage for this pi session.",
    promptSnippet: "Inspect the current goal, status, token budget, tokens used, and active elapsed time.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: EmptyParams,
    async execute() {
      const goal = host.getGoal();
      return textResult(toToolText(goal), goal);
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a Codex-style long-running goal for this pi session.",
    promptSnippet:
      "Create one goal with an objective and optional positive token budget. Fails when a non-complete goal already exists unless replace_existing is true; replaces a completed goal.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: CreateGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const shouldReplaceExisting = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = shouldReplaceExisting
        ? replaceGoal(params.objective, params.token_budget ?? null)
        : createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      host.setGoal(result.goal, "tool", ctx);
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  // Agent-initiated pause is policy-gated here and in the host: it exists for
  // hard blocks only, so the description carries the contract the model sees.
  pi.registerTool({
    name: "pause_goal",
    label: "Pause Goal",
    description:
      "Pause the current Codex-style goal when it has hit a hard block that no available action can resolve, such as missing credentials or permissions, a required external service being down, a needed user decision, or a broken environment. Never use this tool merely because work is stopping, the token budget is low, progress is partial, or you are uncertain; in those cases keep working, or call update_goal only if the goal is truly complete. The user resumes a paused goal with /goal resume.",
    promptSnippet:
      "Pause the current goal only after it hits a hard block that no available action can resolve; include the blocking reason. The user resumes with /goal resume.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: PauseGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = host.pauseGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const text = [`Goal paused. Reason: ${params.reason}`, "", toToolText(result.goal), "", "The user can resume this goal with /goal resume."].join("\n");
      return { content: [{ type: "text", text }], details: { ...goalToolResponse(result.goal), error: null } };
    },
  });

  // Agent-initiated resume is the counterpart to pause_goal: it reactivates a
  // goal only once the hard block that caused the pause is actually resolved.
  pi.registerTool({
    name: "resume_goal",
    label: "Resume Goal",
    description:
      "Resume a Codex-style goal that was previously paused on a hard block. Only use this tool when the blocking issue has actually been resolved, for example because the user confirmed that credentials were added, a required service is back up, or a pending decision was made; state what resolved the block. Never use this tool merely because you want to keep working, and note that it cannot resume a budgetLimited goal: an exhausted token budget must be raised or replaced by the user first.",
    promptSnippet:
      "Resume a paused goal only once its hard block has actually been resolved, then continue working toward the objective.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: ResumeGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = host.resumeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      const text = [`Goal resumed. Reason: ${params.reason}`, "", toToolText(result.goal), "", "Continue working toward the objective."].join("\n");
      return { content: [{ type: "text", text }], details: { ...goalToolResponse(result.goal), error: null } };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the current Codex-style goal complete only after the objective is actually achieved and no required work remains. Do not use this tool just because work is stopping, budget is low, or partial progress looks sufficient.",
    promptSnippet: "Mark the current goal complete only after an evidence-backed completion audit proves no required work remains.",
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: UpdateGoalParams,
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = host.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      return textResult(toToolText(result.goal, true), result.goal, true);
    },
  });
}
