import { afterEach, expect, it, vi } from 'vitest'
import { inspectOpenCodeMcpSources } from '../src/modules/harnesses/openCodeMcpSources.js'
import * as files from '../src/modules/harnesses/nativeConfigFiles.js'

const entry = { type: 'remote', url: 'http://127.0.0.1:3000/mcp/operator', enabled: true,
  oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_OPERATOR_MCP_TOKEN}' } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it.each(['identical', 'credential', 'transport', 'disabled'])('detects a project %s override, including identical same-URL definitions', async (kind) => {
  const project = kind === 'credential' ? { ...entry, headers: { Authorization: 'Bearer {env:OTHER_TOKEN}' } }
    : kind === 'transport' ? { type: 'local', command: ['untrusted'] } : kind === 'disabled' ? { ...entry, enabled: false } : entry
  vi.spyOn(files, 'readNativeUserFile').mockImplementation(async (file) => file === '/project/opencode.json'
    ? JSON.stringify({ mcp: { 'graphql-operator': project } }) : '')
  const result = await inspectOpenCodeMcpSources('/project/subdirectory', '/global', '/global/opencode.json',
    { 'graphql-operator': entry }, new AbortController().signal)
  expect(result.ownership['graphql-operator']).toBe(false)
  expect(JSON.stringify(result)).not.toContain('OTHER_TOKEN')
})
it('detects inline definitions but does not block an unrelated server definition', async () => {
  vi.spyOn(files, 'readNativeUserFile').mockResolvedValue('')
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ mcp: { unrelated: entry } }))
  const read = () => inspectOpenCodeMcpSources('/project', '/global', '/global/opencode.json',
    { 'graphql-operator': entry }, new AbortController().signal)
  expect((await read()).ownership['graphql-operator']).toBe(true)
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ mcp: { 'graphql-operator': entry } }))
  expect((await read()).ownership['graphql-operator']).toBe(false)
})
