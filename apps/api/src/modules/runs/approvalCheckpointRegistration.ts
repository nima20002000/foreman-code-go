import type { InteractionService } from '../interactions/service.js'
import type { LangGraphWorkflowEngine } from './engine.js'

/** One production composition seam, shared by the focused integration fixture.
 * The legacy callback remains separate; it is not an atomic v2 consumer.
 */
export function registerApprovalCheckpointResume(interactions: InteractionService, engine: LangGraphWorkflowEngine): void {
  interactions.useAtomicApprovalResume((claim) => engine.resumeInteraction(claim.interaction, claim))
}
