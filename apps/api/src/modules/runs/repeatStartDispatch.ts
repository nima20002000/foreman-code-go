import { DomainError } from '../errors.js'

/** Version discovery only, never admission. Keep 3 a distinct arm; neither
 * String/Number coercion nor a false isOneShot result may send it to legacy. */
export function runStartSemantics(input: { executionSemanticsVersion?: unknown }): 1 | 2 | 3 {
  switch (input.executionSemanticsVersion) {
    case undefined:
    case 1: return 1
    case 2: return 2
    case 3: return 3
    default: throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Unknown execution semantics cannot use Run Start.', 409)
  }
}
