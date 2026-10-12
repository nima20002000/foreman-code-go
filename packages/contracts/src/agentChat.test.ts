import { describe, expect, it } from "vitest";

import { AgentChatStateSchema, SendAgentChatMessageRequestSchema, agentChatFixtures } from "./agentChat.js";
import { ReadSelectedRunChatResponseSchema } from './selectedRunChat.js';

describe("agent chat contract", () => {
  it.each(['starting', 'running', 'completed'] as const)('accepts a %s source transcript without creating a conversation', state => {
    const context = { ...agentChatFixtures.empty.context, runId: 'source-run' };
    const sourceTranscript = { executionId: 'source-execution', state, revision: '1',
      messages: [{ id: 'source-item', role: 'assistant', content: 'Public execution text' }], hasEarlierMessages: false };
    const value = { ...agentChatFixtures.empty, context, sourceTranscript };
    expect(AgentChatStateSchema.parse(value).sourceTranscript).toEqual(sourceTranscript);
    const target = { workspaceId: context.workspaceId, workflowId: context.workflowId,
      workflowNodeId: context.workflowNodeId, runId: context.runId };
    const selected = { kind: 'selected', selection: { ...target, executionId: 'source-execution' }, key: null, state: value };
    expect(ReadSelectedRunChatResponseSchema.safeParse(selected).success).toBe(true);
    expect(ReadSelectedRunChatResponseSchema.safeParse({ ...selected,
      selection: { ...selected.selection, executionId: 'other-execution' } }).success).toBe(false);
  });

  it.each(Object.entries(agentChatFixtures))("parses the %s fixture", (_name, state) => {
    expect(AgentChatStateSchema.parse(state)).toEqual(state);
  });

  it("defaults intent to next_turn and requires an explicit expected conversation", () => {
    const parsed = SendAgentChatMessageRequestSchema.parse({ requestId: "r", content: "hi", expectedConversationId: null,
      context: { workflowId: "w", workflowNodeId: "n", agentId: "a" } });
    expect(parsed.intent).toBe("next_turn");
    expect(() => SendAgentChatMessageRequestSchema.parse({ requestId: "r", content: "hi",
      context: { workflowId: "w", workflowNodeId: "n", agentId: "a" } })).toThrow();
  });
});
