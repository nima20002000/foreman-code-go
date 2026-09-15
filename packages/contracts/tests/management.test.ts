import { describe, expect, it } from "vitest";

import {
  GraphDraftApplyInputSchema,
  ManagementPrincipalSchema,
  RunStartInputSchema,
  WorkspaceUpdateInputSchema,
} from "../src/management/index.js";

describe("management contracts", () => {
  it("rejects unknown fields and malformed scopes", () => {
    expect(() => ManagementPrincipalSchema.parse({
      id: "principal-1", name: "Owner", audience: "operator", expiresAt: "2026-10-01T00:00:00.000Z",
      revokedAt: null, grants: [{ actions: ["workspaces:read"], scope: {}, extra: true }],
    })).toThrow();
  });

  it("requires revisions for metadata writes", () => {
    expect(() => WorkspaceUpdateInputSchema.parse({
      workspaceId: "workspace-1", commandId: "command-123", name: "Renamed",
    })).toThrow();
  });

  it("accepts strict typed graph batches and rejects arbitrary patch operations", () => {
    const base = {
      workspaceId: "workspace-1", workflowId: "workflow-1", draftId: "draft-1",
      commandId: "command-123", expectedRevision: 2,
    };
    expect(GraphDraftApplyInputSchema.parse({
      ...base,
      operations: [{ type: "node.move", nodeId: "node-1", position: { x: 10, y: 20 } }],
    }).operations).toHaveLength(1);
    expect(() => GraphDraftApplyInputSchema.parse({
      ...base,
      operations: [{ type: "json.patch", path: "/name", value: "unsafe" }],
    })).toThrow();
  });

  it("requires an explicit saved workflow version when starting", () => {
    expect(() => RunStartInputSchema.parse({
      workspaceId: "workspace-1", workflowId: "workflow-1", commandId: "command-123", input: {},
    })).toThrow();
  });

  it("does not advertise unsupported OpenCode automatic approval", () => {
    expect(() => GraphDraftApplyInputSchema.parse({
      workspaceId: "workspace-1", workflowId: "workflow-1", draftId: "draft-1",
      commandId: "command-123", expectedRevision: 0,
      operations: [{
        type: "agent.configure", agentId: "agent-1", expectedAgentRevision: 0,
        configuration: {
          harness: "opencode", model: "opencode-go/deepseek-v4.1-flash", variant: "max",
          nativeAgent: "build", thinking: false, autoApprove: true,
        },
      }],
    })).toThrow();
  });
});
