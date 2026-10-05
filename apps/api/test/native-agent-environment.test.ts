import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { it } from 'vitest'
import { runCommand } from '../src/modules/harnesses/process.js'
import { inheritedAgentEnvironment, nativeAgentEnvironment } from '../src/modules/harnesses/secrets.js'

it('keeps provider credentials and native login paths while excluding production database credentials', () => {
  const source = {
    HOME: '/home/operator', XDG_DATA_HOME: '/home/operator/.local/share',
    OPENROUTER_API_KEY: 'provider-credential', OPENCODE_API_KEY: 'native-provider-credential',
    GRAPHQL_PRODUCTION_DB_PASSWORD: 'production-database-credential',
    DATABASE_URL: 'postgresql://owner:credential@localhost/graphql_production',
    TEST_DATABASE_URL: 'postgresql://test:credential@localhost/graphql_test',
    PGPASSWORD: 'database-credential', GRAPHQL_MCP_TOKEN: 'unscoped-app-credential',
  }
  assert.deepEqual(inheritedAgentEnvironment(source), {
    HOME: source.HOME, XDG_DATA_HOME: source.XDG_DATA_HOME,
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY, OPENCODE_API_KEY: source.OPENCODE_API_KEY,
    NO_COLOR: '1',
  })
  assert.equal(source.GRAPHQL_PRODUCTION_DB_PASSWORD, 'production-database-credential')
})

it('starts native children with their binary directory first and removes pnpm bin directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-path-'))
  const output = join(directory, 'path.txt')
  const source = { ...process.env, PATH: [
    join(process.cwd(), 'node_modules', '.bin'),
    join(process.cwd(), 'apps', 'api', 'node_modules', '.bin'),
    '/usr/local/bin',
  ].join(delimiter) }
  assert.equal(nativeAgentEnvironment(process.execPath, process.cwd(), { ...source, GRAPHQL_MCP_TOKEN: 'scoped-token' }).GRAPHQL_MCP_TOKEN,
    'scoped-token')
  try {
    const result = await runCommand(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.env.PATH || "")', output],
      process.cwd(), AbortSignal.timeout(5_000), source)
    assert.equal(result.exitCode, 0)
    const paths = (await readFile(output, 'utf8')).split(delimiter)
    assert.equal(paths[0], dirname(process.execPath))
    assert.ok(paths.includes('/usr/local/bin'))
    assert.ok(paths.every((entry) => !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(entry)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
