import { readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertTestPath, assertTestRoot, createTestRoot, removeTestRoot, requireTestServerUrl,
  completeTestResourceCleanup, registerTestResourceCleanup, testAdminUrl, testEnvironment } from '../../../scripts/test-resources.mjs'
import { removeFixtureDirectory } from './helpers/testResources.js'

describe('disposable test resources', () => {
  it('rejects alternate servers, credentials and socket or search-path overrides', () => {
    expect(requireTestServerUrl(testAdminUrl).port).toBe('55439')
    for (const value of [
      'postgresql://graphql:graphql@127.0.0.1:5432/graphql',
      testAdminUrl.replace('127.0.0.1', 'localhost'),
      testAdminUrl.replace('graphql_test_admin', 'graphql'),
      testAdminUrl + '?host=/tmp/app-postgres',
      testAdminUrl + '?options=-c%20search_path=public',
    ]) expect(() => requireTestServerUrl(value)).toThrow('dedicated disposable')
  })

  it('requires a matching ownership marker before removing a root', async () => {
    const resource = createTestRoot()
    const file = join(resource.directory, 'retained.txt')
    await writeFile(file, 'retained')
    try {
      expect(() => removeTestRoot({ ...resource, token: 'wrong-owner' })).toThrow('ownership')
      expect(await readFile(file, 'utf8')).toBe('retained')
      assertTestRoot(resource.directory, resource.token)
    } finally { removeTestRoot(resource) }
  })

  it('retains recovery files until every registered cleanup is confirmed by its owner', async () => {
    const resource = createTestRoot()
    const first = registerTestResourceCleanup(resource, { kind: 'native-qualification' })
    const second = registerTestResourceCleanup(resource, { kind: 'suite-process-group' })
    const file = join(resource.directory, 'retained.txt')
    await writeFile(file, 'native recovery state')
    expect(() => removeTestRoot(resource)).toThrow('cleanup remains unconfirmed')
    expect(() => completeTestResourceCleanup({ ...resource, token: 'wrong-owner' }, first)).toThrow('ownership')
    completeTestResourceCleanup(resource, first)
    expect(() => removeTestRoot(resource)).toThrow('cleanup remains unconfirmed')
    expect(await readFile(file, 'utf8')).toBe('native recovery state')
    completeTestResourceCleanup(resource, second)
    removeTestRoot(resource)
  })

  it('rejects fixture cleanup outside the owned root and through escaping symlinks', async () => {
    const outside = createTestRoot(dirname(process.env.GRAPHQL_TEST_ROOT!))
    const file = join(outside.directory, 'retained.txt')
    const link = join(process.env.GRAPHQL_TEST_ROOT!, 'outside-cleanup-link')
    await writeFile(file, 'retained')
    await symlink(outside.directory, link)
    try {
      await expect(removeFixtureDirectory(outside.directory)).rejects.toThrow('owned test root')
      await expect(removeFixtureDirectory(join(link, 'retained.txt'))).rejects.toThrow('escapes')
      expect(await readFile(file, 'utf8')).toBe('retained')
    } finally {
      await removeFixtureDirectory(link)
      removeTestRoot(outside)
    }
  })

  it('validates execution destinations through missing directories and rejects dangling symlinks', async () => {
    const resource = createTestRoot()
    const link = join(resource.directory, 'dangling-location')
    try {
      const destination = join(resource.directory, 'projects', 'nested', 'new-folder')
      expect(assertTestPath(resource, destination)).toBe(destination)
      await symlink('/missing-outside-test-root', link)
      expect(() => assertTestPath(resource, link)).toThrow('symlink')
      expect(() => assertTestPath(resource, join(link, 'new-folder'))).toThrow()
    } finally { removeTestRoot(resource) }
  })

  it('isolates storage and harness homes, discards ambient authentication, and copies only test authentication', async () => {
    const resource = createTestRoot()
    const auth = join(resource.directory, 'test-auth.json')
    await writeFile(auth, '{"test":"credential"}')
    try {
      const environment = testEnvironment({ HOME: '/real/home', CODEX_HOME: '/real/codex', PGHOST: 'app',
        OPENAI_API_KEY: 'real-key', GRAPHQL_MCP_TOKEN: 'real-token', LOG_FILE: '/real/log',
        GRAPHQL_API_ENV_FILE: '/real/api.env',
        GRAPHQL_TEST_CODEX_AUTH_FILE: auth, GRAPHQL_TEST_OPENAI_API_KEY: 'test-key' },
      { ...resource, name: 'graphql_test_unit', databaseUrl: new URL('/graphql_test_unit', testAdminUrl).toString() })
      for (const key of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
        'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'FILE_STORAGE_ROOT', 'HARNESS_WORKSPACE_ROOT', 'LOG_DIR']) {
        expect(environment[key]).toMatch(resource.directory + '/')
      }
      expect(await readFile(join(environment.HOME!, '.local/share/graphql/mcp/launcher.mjs'), 'utf8')).toBeTruthy()
      expect(environment.PGHOST).toBeUndefined()
      expect(environment.GRAPHQL_MCP_TOKEN).toBeUndefined()
      expect(environment.LOG_FILE).toBeUndefined()
      expect(await readFile(environment.GRAPHQL_API_ENV_FILE!, 'utf8')).toBe('')
      expect(environment.TMPDIR).toBe(join(resource.directory, 'tmp'))
      expect(environment.FILE_STORAGE_ROOT!.startsWith(environment.TMPDIR! + '/')).toBe(false)
      expect(environment.OPENAI_API_KEY).toBe('test-key')
      const nested = testEnvironment(environment, { ...resource, name: 'graphql_test_unit',
        databaseUrl: new URL('/graphql_test_unit', testAdminUrl).toString() })
      expect(nested.OPENAI_API_KEY).toBe('test-key')
      expect(await readFile(join(environment.CODEX_HOME!, 'auth.json'), 'utf8')).toBe('{"test":"credential"}')
    } finally { removeTestRoot(resource) }
  })
})
