import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedEnvironment, type IsolatedEnvironment } from '../runtime/environment.js'
import { waitForOwnedProcessesToExit } from '../runtime/owned-processes.js'
import { randomLoopbackPort } from '../runtime/ports.js'
import { setupFixtures, type HarnessFixtures } from './setup.js'

interface CommandResult {
  exitCode: string | number
  stdout: string
  stderr: string
  inputError?: string
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
let resources: IsolatedEnvironment | undefined
let fixtures: HarnessFixtures | undefined
let apiOrigin: string

/** These finite CLI calls start no provider turns or native child tools. */
function invoke(arguments_: readonly string[], input = ''): Promise<CommandResult> {
  if (!resources || !fixtures) throw new Error('The isolated native fixture is not ready.')
  const environment = { ...fixtures.environment, PATH: '' }
  return new Promise(resolve => {
    let inputError: string | undefined
    const child = execFile(fixtures!.codexBinary, [...arguments_], {
      cwd: resources!.directory, env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => resolve({
      exitCode: error ? error.code ?? error.signal ?? 'unknown' : 0,
      stdout, stderr, ...(inputError ? { inputError } : {}),
    }))
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') inputError = error.message
      // ignore: an early CLI exit may close stdin; the real exit and output are still captured.
    })
    child.stdin?.end(input)
  })
}

beforeAll(async () => {
  resources = await createIsolatedEnvironment(repoRoot)
  apiOrigin = `http://127.0.0.1:${await randomLoopbackPort()}`
  fixtures = await setupFixtures({ directory: resources.directory, environment: resources.environment,
    apiOrigin, devicePort: await randomLoopbackPort() })
}, 30_000)

afterAll(async () => {
  if (!resources) return
  await waitForOwnedProcessesToExit(resources.directory)
  await resources.close()
}, 30_000)

describe('The selected isolated Codex executable', () => {
  it('reports its real CLI version without looking up Node on PATH', async () => {
    expect(await invoke(['--version'])).toEqual({ exitCode: 0, stdout: 'codex-cli 0.154.0\n', stderr: '' })
  })

  it('forwards app-server arguments and complete protocol input and output', async () => {
    const echoed = { text: 'first line\nsecond line: λ, "quoted", \\backslash', values: [null, false, 19] }
    const input = [
      { id: 41, method: 'config/read', params: {} },
      { id: 42, method: 'test/echo', params: echoed },
    ].map(frame => JSON.stringify(frame) + '\n').join('')
    const output = [
      { id: 41, result: { config: { approval_policy: 'on-request', mcp_servers: { graphql: {
        name: 'graphql', enabled: false, required: true,
        transport: { type: 'streamable_http', url: new URL('/mcp', apiOrigin).href,
          bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' },
      } } }, origins: {}, layers: [] } },
      { id: 42, result: echoed },
    ].map(frame => JSON.stringify(frame) + '\n').join('')
    expect(await invoke(['app-server', '-c', 'mcp_servers.graphql.enabled=false'], input))
      .toEqual({ exitCode: 0, stdout: output, stderr: '' })
  })

  it('preserves a failed CLI command and its complete argument-dependent diagnostic', async () => {
    const name = 'absent café "quoted" \\server'
    expect(await invoke(['mcp', 'get', name])).toEqual({ exitCode: 1, stdout: '',
      stderr: `Error: No MCP server named '${name}' found.\n` })
  })

  it('reports an unavailable compiler and leaves no process using the fresh setup root', async () => {
    const isolated = await createIsolatedEnvironment(repoRoot)
    try {
      const failure = await setupFixtures({ directory: isolated.directory,
        environment: { ...isolated.environment, PATH: '' },
        apiOrigin: `http://127.0.0.1:${await randomLoopbackPort()}`,
        devicePort: await randomLoopbackPort() }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({ message: 'Fresh Codex fixture setup requires a working C compiler.',
        cause: { name: 'CommandError', exitCode: 'ENOENT' } })
      await waitForOwnedProcessesToExit(isolated.directory)
    } finally {
      await waitForOwnedProcessesToExit(isolated.directory)
      await isolated.close()
    }
  }, 30_000)
})
