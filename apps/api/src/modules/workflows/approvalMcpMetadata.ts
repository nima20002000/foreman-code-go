/** Description fragment for the EXISTING graph_draft_apply tool. No delegation
 * family or additional scope grant is introduced by approval relationships. */
export const approvalDraftToolDescription =
  'For executionSemanticsVersion 2, use relationship.put with kind approval to assign a reviewer node to a requester node. ' +
  'This changes approval authority only, never execution direction or scheduling. ' +
  'A requester has at most one App reviewer; recursive/self review is rejected. ' +
  'Only the initialized explicit-entry Orchestrator is supported at executable save. ' +
  'workflow.set_approval with User explicitly removes App assignments without changing native permissions. ' +
  'Read the persisted draft back with graph_draft_get. Read-only callers cannot change assignments.'
