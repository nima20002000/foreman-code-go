import { describe, expect, it } from "vitest";

import {
  HarnessExecutionSchema,
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  type WorkflowVersion,
} from "../src/index.js";

const timestamp = "2026-09-14T12:00:00.000Z";
const version: WorkflowVersion = {
  id: "version-1",
  workspaceId: "workspace-1",
  workflowId: "workflow-1",
  version: 1,
  entryNodeId: "node-1",
  definition: {
    id: "workflow-1",
    workspaceId: "workspace-1",
    name: "Review",
    version: 1,
    executionCondition: { kind: "manual" },
    executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
    nodes: [
      { id: "node-1", agentId: "agent-1", name: "Research" },
      { id: "node-2", agentId: "agent-2", name: "Review" },
    ],
    edges: [{
      id: "edge-1", source: "node-1", target: "node-2",
      route: { outcomes: ["succeeded"], maxTraversals: 2 },
    }],
  },
  agentConfigurationVersionIds: { "agent-1": "config-1", "agent-2": "config-2" },
  contentHash: "test-hash",
  createdAt: timestamp,
};

describe("executable workflow graph integrity", () => {
  it("accepts a valid pinned graph", () => {
    expect(WorkflowVersionSchema.safeParse(version).success).toBe(true);
  });

  it.each(["source", "target"] as const)("rejects a missing %s", (endpoint) => {
    const candidate = structuredClone(version);
    candidate.definition.edges[0]![endpoint] = "missing-node";
    const result = WorkflowVersionSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["definition", "edges", 0, endpoint] }),
    ]));
    // Drafts remain editable; only executable snapshots enforce graph integrity.
    expect(WorkflowDefinitionSchema.safeParse(candidate.definition).success).toBe(true);
  });

  it("rejects duplicate node IDs", () => {
    const candidate = structuredClone(version);
    candidate.definition.nodes.push({ ...candidate.definition.nodes[0]! });
    const result = WorkflowVersionSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["definition", "nodes", 2, "id"] }),
    ]));
  });

  it("rejects duplicate edge IDs", () => {
    const candidate = structuredClone(version);
    candidate.definition.edges.push({ ...candidate.definition.edges[0]! });
    const result = WorkflowVersionSchema.safeParse(candidate);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["definition", "edges", 1, "id"] }),
    ]));
  });

  it("allows distinct nodes to share an agent and permits explicitly bounded loops", () => {
    const candidate = structuredClone(version);
    candidate.definition.nodes[1]!.agentId = "agent-1";
    candidate.definition.edges.push({
      id: "loop", source: "node-2", target: "node-1",
      route: { outcomes: ["succeeded"], maxTraversals: 2 },
    });
    expect(WorkflowVersionSchema.safeParse(candidate).success).toBe(true);
  });
});

const attempt = {
  id: "attempt-1", runId: "run-1", workflowNodeId: "node-1",
  agentId: "agent-1", agentConfigurationVersionId: "config-1",
  attempt: 1, input: {}, createdAt: timestamp,
};
const terminalFields = [
  { result: { outcome: "succeeded" } },
  { finishedAt: timestamp },
  { result: { outcome: "succeeded" }, finishedAt: timestamp },
];

describe("harness attempt terminal invariants", () => {
  for (const state of ["queued", "starting", "running", "waiting"] as const) {
    it(`accepts unfinished ${state} attempts`, () => {
      expect(HarnessExecutionSchema.safeParse({ ...attempt, state }).success).toBe(true);
    });
    it.each(terminalFields)(`rejects terminal fields on ${state}: %j`, (fields) => {
      expect(HarnessExecutionSchema.safeParse({ ...attempt, state, ...fields }).success).toBe(false);
    });
  }

  it("requires both a result and finish time for completed attempts", () => {
    for (const fields of [{}, terminalFields[0], terminalFields[1]]) {
      expect(HarnessExecutionSchema.safeParse({ ...attempt, state: "completed", ...fields }).success)
        .toBe(false);
    }
    expect(HarnessExecutionSchema.safeParse({
      ...attempt, state: "completed", ...terminalFields[2],
    }).success).toBe(true);
  });
});
