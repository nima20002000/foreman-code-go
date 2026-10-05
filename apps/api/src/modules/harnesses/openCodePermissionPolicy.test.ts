import { describe, expect, it } from 'vitest'
import { evaluateOpenCodePermission, nativeOpenCodeMcpToolName, nativeOpenCodeMcpToolNames } from './openCodePermissionPolicy.js'

describe('ordered OpenCode output permissions', () => {
  it('combines inherited Agent permissions and saved session rules in native order', () => {
    const name = nativeOpenCodeMcpToolName('files.native_output_publish')
    expect(name).toBe('graphql_files_native_output_publish')
    expect(nativeOpenCodeMcpToolNames('files.native_output_publish')).toEqual([
      'foreman-code_files_native_output_publish', 'graphql_files_native_output_publish',
    ])
    const inherited = [{ permission: '*', pattern: '*', effect: 'allow' as const }]
    const session = [{ permission: 'graphql_files_native_output_*', pattern: '*', effect: 'ask' as const }]
    expect(evaluateOpenCodePermission(name, '*', inherited)).toBe('allow')
    expect(evaluateOpenCodePermission(name, '*', [...inherited, ...session])).toBe('ask')
    expect(evaluateOpenCodePermission(name, '*', [...inherited, ...session,
      { permission: name, pattern: '*', effect: 'deny' }])).toBe('deny')
    expect(evaluateOpenCodePermission(name, '*', [])).toBe('ask')
  })
})
