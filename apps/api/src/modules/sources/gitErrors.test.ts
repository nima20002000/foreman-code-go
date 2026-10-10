import { afterEach, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { toolFailure } from '../../mcp/shared/results.js'
import { snapshotAgentWorktree } from './agentSnapshot.js'
import { addGitWorktree, ensureCommit, type GitWorktreePorts } from './gitWorktree.js'
import { SourceError } from './manifest.js'

const commit = 'a'.repeat(40)
const credentials = [
  ['URL password', 'fatal: https://user:synthetic-password@example.invalid/repo'],
  ['URL token username', 'fatal: https://synthetic-token@example.invalid/repo'],
  ['authorization header', 'fatal: Authorization: Bearer synthetic-bearer-token'],
  ['basic authorization', 'fatal: Authorization: Basic c3ludGhldGljOmNyZWRlbnRpYWw='],
  ['GitHub token', 'fatal: ghp_syntheticGitHubCredential1234567890'],
  ['GitHub fine-grained token', 'fatal: github_pat_syntheticCredential1234567890'],
  ['credential helper output', 'fatal: password=synthetic-helper-password'],
  ['encoded credentials', 'fatal: https://user:synthetic%2Dpassword@example.invalid/repo'],
  ['escaped credentials', 'fatal: {"password":"synthetic\\u002dpassword"}'],
  ['private key', '-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----'],
  ['unlabelled helper output', 'fatal: synthetic-unlabelled-secret'],
  ['credential past truncation boundary', `fatal: ${'x'.repeat(290)} synthetic-secret`],
  ['multiline helper output', 'synthetic-helper-secret\nfatal: authentication failed'],
] as const

function failingPorts(stderr: string, operation: string): GitWorktreePorts {
  return {
    cloneDirectory: () => '/unused-clone',
    git: async args => ({
      code: args[0] === operation || args[0] === 'cat-file' ? 1 : 0,
      stdout: '',
      stderr,
    }),
  }
}

const operations = [
  {
    name: 'repository fetch',
    command: 'fetch',
    code: 'SOURCE_WORKTREE_FAILED',
    run: (ports: GitWorktreePorts) => ensureCommit(ports, 'octo/site', commit, new AbortController().signal),
  },
  {
    name: 'worktree preparation',
    command: 'worktree',
    code: 'SOURCE_WORKTREE_FAILED',
    run: (ports: GitWorktreePorts) => addGitWorktree(ports,
      { repository: 'octo/site', branch: 'foreman/agent' }, commit, '/unused-worktree', new AbortController().signal),
  },
  {
    name: 'agent snapshot',
    command: 'read-tree',
    code: 'SOURCE_SNAPSHOT_FAILED',
    run: (ports: GitWorktreePorts) => snapshotAgentWorktree(ports,
      { path: '/unused-worktree', baseCommit: commit }, new AbortController().signal),
  },
]

for (const operation of operations) {
  it.each(credentials)(`${operation.name} excludes %s from its public error`, async (_name, stderr) => {
    let failure: unknown
    try {
      await operation.run(failingPorts(stderr, operation.command))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SourceError)
    expect(failure).toMatchObject({ code: operation.code, message: expect.stringContaining(operation.command) })
    const result = toolFailure(failure)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ error: {
      code: operation.code,
      message: `git ${operation.command} failed. Check repository access and local Git configuration, then retry.`,
    } }) }])
  })
}

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

it.each(credentials)('excludes %s through the HTTP error handler', async (_name, stderr) => {
  const app = buildApp({ readiness: {
    database: { ping: async () => {} }, checkpoints: { ping: async () => {} },
  } })
  apps.push(app)
  app.get('/git-failure', () => ensureCommit(failingPorts(stderr, 'fetch'),
    'octo/site', commit, new AbortController().signal))
  const response = await app.inject({ method: 'GET', url: '/git-failure' })
  expect(response.statusCode).toBe(400)
  expect(response.json().error).toEqual({
    code: 'SOURCE_WORKTREE_FAILED',
    message: 'git fetch failed. Check repository access and local Git configuration, then retry.',
    requestId: expect.any(String),
  })
  expect(response.body.length).toBeLessThan(300)
})
