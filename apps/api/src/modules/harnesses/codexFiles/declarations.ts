import type { CodexHarnessConfiguration } from '@graphql/contracts'
import { HarnessExecutionError } from '../errors.js'
import type { FileToolOperation } from '../../files/tools/types.js'
import { codexFileDynamicTools } from './index.js'

export function codexChatFileTools(configuration: CodexHarnessConfiguration): FileToolOperation[] {
  // A declaration is not a grant. The bridge checks the narrower accepted
  // allowlist on every operation, and FIL-05 reauthorizes the owner as well.
  return configuration.sandbox === 'read-only'
    ? ['files.list', 'files.read']
    : ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result',
      'files.write_working_copy', 'files.apply_format_edit']
}

/** The pinned 0.154.0 and 0.156.1 upstream schemas both use type: 'function'.
 * Reuse FIL-08's emitter unchanged; native qualification is not broadened. */
export function codexChatFileDeclarations(configuration: CodexHarnessConfiguration, providerVersion: string) {
  if (!['codex-cli 0.154.0', 'codex-cli 0.156.1'].includes(providerVersion)) {
    throw new HarnessExecutionError('CODEX_FILE_PROTOCOL_UNQUALIFIED', 'File tools require a qualified native dynamic-tool schema.')
  }
  return codexFileDynamicTools({ allowedTools: () => codexChatFileTools(configuration) })
}
