import { describe, expect, it } from "vitest";

import { AgentChatStateSchema, SendAgentChatMessageRequestSchema, agentChatFixtures } from "./agentChat.js";

describe("agent chat contract", () => {
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
