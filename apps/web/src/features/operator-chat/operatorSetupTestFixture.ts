/** Accepted configuration IDs belong to configured fixtures, not pre-creation setup states. */
export function configuredOperatorSetup(harness: 'codex' | 'opencode') {
  return { harness, status: 'configured' as const, configurationVersionId: 'operator-config',
    endpoint: 'http://127.0.0.1:3000/mcp/operator', checkedAt: new Date().toISOString() }
}
export function unconfiguredOperatorSetup(harness: 'codex' | 'opencode') {
  return { ...configuredOperatorSetup(harness), status: 'setup_required' as const, configurationVersionId: undefined }
}
