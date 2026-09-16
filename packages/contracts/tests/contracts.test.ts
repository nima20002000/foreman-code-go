import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  AgentConfigurationVersionSchema,
  AgentStatusSchema,
  ApiErrorResponseSchema,
  BrowserWaitSchema,
  ConversationSchema,
  CreateMessageRequestSchema,
  ExecutionConditionSchema,
  HarnessSummarySchema,
  HarnessExecutionRequestSchema,
  MessageSchema,
  ResourceSummarySchema,
  RunSummarySchema,
  SaveWorkflowRequestSchema,
  ScenarioSelectionSchema,
  WorkflowRunSchema,
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  WorkspaceDetailsResponseSchema,
  AgentDefaultsSchema,
  CODEX_APPROVAL_OPTIONS_FIXTURE,
  CreateConversationRequestSchema,
  DurableInteractionSchema,
  NATIVE_INTERACTION_FIXTURES,
  OPENCODE_APPROVAL_OPTIONS_FIXTURE,
  WorkflowApprovalConfigurationSchema,
  CodexHarnessConfigurationSchema,
  CodexSessionCompatibilitySchema,
  OpenCodeHarnessConfigurationSchema,
  UpdateAgentDefaultsRequestSchema,
  UpdateWorkflowDefaultsRequestSchema,
  VersionedAgentDefaultsSchema,
  VersionedWorkflowDefaultsSchema,
  DEFAULT_AGENT_DEFAULTS,
  validateHarnessWorkflowCompatibility,
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
  it("defines server-owned roles, approval assignment and truthful provider options", () => {
    expect(AgentDefaultsSchema.safeParse({
      orchestrator: { role: "orchestrator", boardAddable: true, harness: { harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard" } },
      coder: { role: "coder", boardAddable: true, harness: { harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard" } },
      operator: { role: "operator", boardAddable: false, uiEnabled: true, harness: { harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard" } },
    }).success).toBe(true);
    expect(WorkflowApprovalConfigurationSchema.safeParse({ handler: "orchestrator" }).success).toBe(false);
    expect(CODEX_APPROVAL_OPTIONS_FIXTURE.some((option) => option.semantic === "allow_session")).toBe(true);
    expect(OPENCODE_APPROVAL_OPTIONS_FIXTURE.some((option) => option.semantic === "allow_session")).toBe(false);
    expect(OPENCODE_APPROVAL_OPTIONS_FIXTURE.find((option) => option.semantic === "reject")?.affectsOtherPendingRequests).toBe(true);
    expect(DurableInteractionSchema.parse(NATIVE_INTERACTION_FIXTURES.codex).nativeRequestId).toBe("codex-request-fixture");
  });

  it("round-trips exact provider Advanced settings while preserving legacy omission", () => {
    const codex = CodexHarnessConfigurationSchema.parse({
      harness: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium", sandbox: "workspace-write", serviceTier: "standard",
      advanced: {
        approvalPolicy: "on-request", approvalsReviewer: "user", additionalWritableDirectories: ["/tmp/project"],
        workspaceWrite: { networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        sessionPersistence: "persistent", shellEnvironment: { inherit: "all", ignoreDefaultExcludes: false, filters: { "AWS_*": "exclude" }, set: {} },
        webSearch: "cached", mcpServers: { app: { enabled: true, required: true, enabledTools: ["context_get"], disabledTools: ["interaction_respond"], tools: { context_get: { enabled: true, approvalMode: "auto" } } } },
      },
    });
    expect(CodexHarnessConfigurationSchema.parse(codex)).toEqual(codex);
    expect(CodexHarnessConfigurationSchema.safeParse({ ...codex, advanced: { ...codex.advanced, mcpServers: { app: { enabled: false, required: true } } } }).success).toBe(false);
    expect(CodexHarnessConfigurationSchema.safeParse({ ...codex, sandbox: "read-only" }).success).toBe(false);

    const opencode = OpenCodeHarnessConfigurationSchema.parse({
      harness: "opencode", model: "provider/model", variant: "provider-defined-effort", nativeAgent: "build", thinking: false, autoApprove: true,
      advanced: { apiVersion: "v1", permissionRules: [
        { permission: "shell", pattern: "git *", effect: "ask" },
        { permission: "shell", pattern: "git status", effect: "allow" },
      ], permissionHandling: "native_auto", subagentDepth: 0, plugins: { mode: "inherit" },
      compaction: { auto: true, prune: false, reservedTokens: 0 }, configLoading: { mode: "native" }, mcp: { serverEnabled: { app: true } } },
    });
    expect(OpenCodeHarnessConfigurationSchema.parse(opencode).advanced?.permissionRules).toEqual(opencode.advanced?.permissionRules);
    expect(OpenCodeHarnessConfigurationSchema.safeParse({ ...opencode, autoApprove: false }).success).toBe(false);
    expect(OpenCodeHarnessConfigurationSchema.safeParse({ harness: "opencode", model: "m", variant: "custom", nativeAgent: "build", thinking: false, autoApprove: false }).success).toBe(true);
    expect(() => validateHarnessWorkflowCompatibility(opencode, "orchestrator")).toThrow();
    expect(() => validateHarnessWorkflowCompatibility(codex, "user")).not.toThrow();
  });

  it("validates versioned Settings DTOs and ephemeral Codex limitations", () => {
    const agents = VersionedAgentDefaultsSchema.parse({ value: DEFAULT_AGENT_DEFAULTS, versionId: "agent-defaults-v1", revision: 1 });
    expect(UpdateAgentDefaultsRequestSchema.parse({ value: agents.value, expectedRevision: agents.revision }).value.operator.uiEnabled).toBe(true);
    const workflows = VersionedWorkflowDefaultsSchema.parse({ value: { approvalHandler: "orchestrator" }, versionId: null, revision: 0 });
    expect(UpdateWorkflowDefaultsRequestSchema.parse({ value: workflows.value, expectedRevision: 0 })).toEqual({ value: workflows.value, expectedRevision: 0 });
    const ephemeral = CodexHarnessConfigurationSchema.parse({
      harness: "codex", model: "m", reasoningEffort: "medium", sandbox: "read-only", serviceTier: "standard",
      advanced: { approvalPolicy: "on-request", approvalsReviewer: "user", additionalWritableDirectories: [], sessionPersistence: "ephemeral", shellEnvironment: { inherit: "all", ignoreDefaultExcludes: false, filters: {}, set: {} }, webSearch: "cached", mcpServers: {} },
    });
    expect(CodexSessionCompatibilitySchema.safeParse({ configuration: ephemeral, requiresResume: true, responseOptions: [] }).success).toBe(false);
    expect(CodexSessionCompatibilitySchema.safeParse({ configuration: ephemeral, requiresResume: false, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }).success).toBe(false);
  });

  it("supports application-global Operator conversations without a fake workspace", () => {
    expect(CreateConversationRequestSchema.safeParse({
      scope: "application", agentId: "application-operator", operatorConfigurationVersionId: "operator-config-v1",
    }).success).toBe(true);
    expect(ConversationSchema.safeParse({
      id: "conversation-global", scope: "application", workspaceId: "fake", agentId: "application-operator",
      operatorConfigurationVersionId: "operator-config-v1",
    }).success).toBe(false);
  });
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
      nodes: [{
        ...workflow.nodes[0],
        width: 280,
        height: 140,
        initialPrompt: "Summarize the accepted input.",
      }],
    }).nodes[0]).toMatchObject({
      agentId: "agent-1",
      width: 280,
      height: 140,
      initialPrompt: "Summarize the accepted input.",
    });
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

  it("pins immutable workflow and agent configuration versions", () => {
    const agentConfiguration = AgentConfigurationVersionSchema.parse({
      id: "agent-config-1-v3",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      version: 3,
      prompt: { system: "Research the requested subject." },
      assignedSkills: [{ skillId: "skill-web-research", version: "2.1.0" }],
      harness: {
        harness: "codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        sandbox: "read-only",
        serviceTier: "standard",
      },
      contentHash: "sha256:agent-config",
      createdAt: "2026-09-14T00:00:00.000Z",
    });

    const versionedWorkflow = {
      ...workflow,
      version: 4,
      executionPolicy: { maxParallelism: 3, maxNodeExecutions: 12 },
      nodes: [{ ...workflow.nodes[0], join: { mode: "all" as const } }],
      edges: [],
    };
    expect(
      WorkflowVersionSchema.parse({
        id: "workflow-1-v4",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        version: 4,
        entryNodeId: "node-1",
        definition: versionedWorkflow,
        agentConfigurationVersionIds: { "agent-1": agentConfiguration.id },
        contentHash: "sha256:workflow",
        createdAt: "2026-09-14T00:00:00.000Z",
      }).agentConfigurationVersionIds,
    ).toEqual({ "agent-1": "agent-config-1-v3" });

    expect(
      WorkflowVersionSchema.safeParse({
        id: "workflow-1-v4",
        workspaceId: "workspace-1",
        workflowId: "workflow-1",
        version: 4,
        entryNodeId: "node-1",
        definition: versionedWorkflow,
        agentConfigurationVersionIds: {},
        contentHash: "sha256:workflow",
        createdAt: "2026-09-14T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("models explicit routing, bounded repeats, parallel attempts and native session input", () => {
    const routedWorkflow = WorkflowDefinitionSchema.parse({
      ...workflow,
      version: 2,
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 8 },
      nodes: [
        workflow.nodes[0],
        { id: "node-2", agentId: "agent-2", name: "Review", join: { mode: "any" } },
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-1",
          target: "node-2",
          route: {
            outcomes: ["succeeded"],
            result: { path: ["approved"], operator: "equals", value: true },
            maxTraversals: 2,
          },
        },
      ],
    });
    expect(routedWorkflow.edges[0]?.route?.maxTraversals).toBe(2);

    expect(
      WorkflowDefinitionSchema.safeParse({
        ...routedWorkflow,
        edges: [
          {
            ...routedWorkflow.edges[0],
            route: { outcomes: ["succeeded"], result: { path: ["approved"], operator: "equals" } },
          },
        ],
      }).success,
    ).toBe(false);

    const run = WorkflowRunSchema.parse({
      id: "run-2",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      workflowVersionId: "workflow-1-v2",
      executionLocation: {
        runnerId: "runner-local",
        rootPath: "/srv/project",
        locationRevision: 4,
        identityHash: `sha256:${"a".repeat(64)}`,
      },
      agentConfigurationVersionIds: {
        "agent-1": "agent-config-1-v3",
        "agent-2": "agent-config-2-v1",
      },
      executionCondition: condition,
      executionState: "running",
      outcome: "pending",
      input: { request: "Research this" },
      createdAt: "2026-09-14T00:00:00.000Z",
    });
    expect(run.workflowVersionId).toBe("workflow-1-v2");
    expect(
      WorkflowRunSchema.safeParse({
        ...run,
        executionState: "completed",
        outcome: "succeeded",
      }).success,
    ).toBe(false);

    expect(
      HarnessExecutionRequestSchema.parse({
        executionId: "execution-1",
        runId: run.id,
        workspaceId: run.workspaceId,
        workflowNodeId: "node-1",
        workingDirectory: "/tmp/graphql-run",
        runtimeDirectory: "/tmp/graphql-runtime/run-1/node-1/attempt-1",
        configuration: {
          id: "agent-config-1-v3",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          version: 3,
          prompt: { system: "Research the requested subject." },
          assignedSkills: [{ skillId: "skill-web-research", version: "2.1.0" }],
          harness: {
            harness: "codex",
            model: "gpt-5.6-luna",
            reasoningEffort: "high",
            sandbox: "read-only",
            serviceTier: "standard",
          },
          contentHash: "sha256:agent-config",
          createdAt: "2026-09-14T00:00:00.000Z",
        },
        input: run.input,
      }).configuration.assignedSkills,
    ).toEqual([{ skillId: "skill-web-research", version: "2.1.0" }]);
  });
});
