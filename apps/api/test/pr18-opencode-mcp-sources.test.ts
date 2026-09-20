import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectOpenCodeMcpSources } from '../src/modules/harnesses/openCodeMcpSources.js'
import * as files from '../src/modules/harnesses/nativeConfigFiles.js'

const entry = { type: 'remote', url: 'http://127.0.0.1:3000/mcp/operator', enabled: true,
  oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_OPERATOR_MCP_TOKEN}' } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('ignores absent optional configuration directories during real source inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphql-opencode-sources-'))
  try {
    const work = join(root, 'work')
    const config = join(root, 'config')
    await Promise.all([mkdir(work), mkdir(config)])
    const name = `source_${root.split('-').at(-1)}`
    const result = await inspectOpenCodeMcpSources(work, config, join(config, 'opencode.json'),
      { [name]: entry }, new AbortController().signal)
    expect(result.ownership[name]).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
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
