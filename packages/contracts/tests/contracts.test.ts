import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  AgentStatusSchema,
  ApiErrorResponseSchema,
  BrowserWaitSchema,
  ConversationSchema,
  CreateMessageRequestSchema,
  ExecutionConditionSchema,
  HarnessSummarySchema,
  MessageSchema,
  ResourceSummarySchema,
  RunSummarySchema,
  SaveWorkflowRequestSchema,
  ScenarioSelectionSchema,
  WorkflowDefinitionSchema,
  WorkspaceDetailsResponseSchema,
} from "../src/index.js";

const condition = { kind: "manual" as const };
const agent = { id: "agent-1", name: "Researcher" };
const workflow = {
  id: "workflow-1",
  workspaceId: "workspace-1",
  name: "Research workflow",
  executionCondition: condition,
  nodes: [{ id: "node-1", agentId: "agent-1", name: "Research" }],
  edges: [],
};

describe("neutral product contracts", () => {
  it("accepts the required workspace, agent, workflow and conversation scenario", () => {
    expect(
      WorkspaceDetailsResponseSchema.parse({
        workspace: { id: "workspace-1", name: "Demo" },
        agents: [agent],
        workflows: [workflow],
        runs: [],
        resources: [],
      }),
    ).toMatchObject({ workspace: { id: "workspace-1" } });

    expect(
      AgentSchema.parse({
        ...agent,
        role: "researcher",
        executionState: "available",
        activeRunId: "run-1",
        harnessSummary: { status: "ready", label: "Local harness", runnerId: "runner-1" },
      }),
    ).toMatchObject({ role: "researcher", executionState: "available", activeRunId: "run-1" });
    for (const executionState of [
      "available",
      "working",
      "waiting_browser",
      "auth_required",
      "interrupted",
      "disconnected",
    ] as const) {
      expect(AgentSchema.parse({ ...agent, executionState }).executionState).toBe(executionState);
    }
    expect(WorkflowDefinitionSchema.parse({
      ...workflow,
      nodes: [{ ...workflow.nodes[0], width: 280, height: 140 }],
    }).nodes[0]).toMatchObject({ agentId: "agent-1", width: 280, height: 140 });
    expect(WorkflowDefinitionSchema.safeParse({
      ...workflow,
      nodes: [{ ...workflow.nodes[0], width: 0 }],
    }).success).toBe(false);
    expect(
      ConversationSchema.parse({ id: "conversation-1", workspaceId: "workspace-1", agentId: "agent-operator" }),
    ).toEqual({ id: "conversation-1", workspaceId: "workspace-1", agentId: "agent-operator" });
    expect(ConversationSchema.safeParse({ id: "conversation-1", workspaceId: "workspace-1" }).success).toBe(false);
  });

  it("keeps workflow node identity separate from an Agent", () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...workflow,
        nodes: [{ id: "node-1", name: "Research", agent: agent }],
      }).success,
    ).toBe(false);
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...workflow,
        nodes: [{ id: "node-1", name: "Research", agentId: "agent-1" }],
      }).success,
    ).toBe(true);
  });

  it("requires an explicit execution condition", () => {
    expect(ExecutionConditionSchema.safeParse({}).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ ...workflow, executionCondition: undefined }).success).toBe(
      false,
    );
  });

  it("does not conflate interruption, outcome, browser waits or runner health", () => {
    const result = RunSummarySchema.safeParse({
      id: "run-1",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      executionCondition: condition,
      executionState: "interrupted",
      outcome: "pending",
      authRequired: true,
      browserWait: {
        reason: "auth_required",
        resourceHolder: "operator",
        resourceId: "browser-github",
        resourceName: "GitHub browser profile",
        holderId: "agent-operator",
        holderLabel: "Operator",
        executionId: "run-1",
        executionLabel: "Research run",
      },
      runnerHealth: { status: "degraded" },
    });
    expect(result.success).toBe(true);
    expect(
      RunSummarySchema.safeParse({
        id: "run-1",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        executionCondition: condition,
        executionState: "interrupted",
        outcome: "interrupted",
        authRequired: true,
        browserWait: null,
        runnerHealth: { status: "healthy" },
      }).success,
    ).toBe(false);
    expect(BrowserWaitSchema.safeParse({ reason: "auth_required" }).success).toBe(false);
    expect(AgentStatusSchema.safeParse("idle").success).toBe(false);
    expect(HarnessSummarySchema.safeParse({ status: "ready", resourceId: "browser-github" }).success).toBe(false);
  });

  it("validates API errors and endpoint request/response shapes", () => {
    expect(
      ApiErrorResponseSchema.parse({ error: { code: "WORKSPACE_NOT_FOUND", message: "Not found" } }),
    ).toEqual({ error: { code: "WORKSPACE_NOT_FOUND", message: "Not found" } });
    expect(
      SaveWorkflowRequestSchema.safeParse({ workspaceId: "workspace-2", workflow }).success,
    ).toBe(false);
    expect(
      CreateMessageRequestSchema.safeParse({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        role: "user",
        content: "Hello",
      }).success,
    ).toBe(true);
    expect(MessageSchema.safeParse({ id: "message-1", conversationId: "conversation-1", role: "user" }).success).toBe(
      false,
    );
    expect(
      ResourceSummarySchema.safeParse({
        id: "browser-1",
        kind: "browser",
        name: "Chrome",
        status: "available",
        resourceHolder: "none",
        authRequired: false,
      }).success,
    ).toBe(true);
    expect(ScenarioSelectionSchema.parse({ scenarioId: "workflow-editor", workflowId: "workflow-1" })).toEqual({
      scenarioId: "workflow-editor",
      workflowId: "workflow-1",
    });
  });
});
