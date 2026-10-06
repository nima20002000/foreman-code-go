import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { compileClaudeConfiguration, type ClaudePolicyQualification } from '../src/modules/harnesses/claudeSdk/configuration.js'

function fixture(sandbox: ClaudeHarnessConfiguration['sandbox']) {
  const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: 'fixture', authMode: 'subscription',
    configDirectory: '/fixture/profile', permissionMode: 'default', sandbox, tools: ['Read', 'Bash'],
    permissionRules: [{ tool: 'Read', effect: 'allow' }, { tool: 'Bash', effect: 'ask' }], instructions: '', mcpServers: {} }
  const target = { hostRef: { kind: 'main' as const, mainId: '11111111-1111-4111-8111-111111111111' },
    applicationInstallationId: '11111111-1111-4111-8111-111111111111', harnessInstallationId: 'fixture-cli', installationFingerprint: 'fixture-payload' }
  const pin = { sdkVersion: 'fixture-sdk', sdkIntegrity: 'fixture-integrity', cliVersion: 'fixture-cli',
    executableSha256: 'a'.repeat(64), profilePath: configuration.configDirectory, configRevision: 'fixture-revision' }
  const binding = { target, instanceId: 'fixture-instance', instanceRevision: 'fixture-revision', configurationFingerprint: 'fixture-config',
    driverId: 'claude', driverRevision: '1', protocolRevision: 'fixture-protocol', suiteRevision: 'fixture-suite',
    environmentGeneration: 'fixture-env', connectionGeneration: 'fixture-connection', pin }
  const qualification: ClaudePolicyQualification = {
    currentBinding: binding,
    override: { ...binding, revision: 1, presetId: 'fixture-preset', enabled: true, configuration, qualification: 'qualified' },
    persistedProof: { ...binding, authenticated: true, compatible: true, qualified: true, checkedAt: '2026-10-02T00:00:00.000Z',
      claudeProof: { pin, observedTools: configuration.tools, checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map((check) => [check,
        { state: 'passed' as const, source: 'native_scenario' as const, evidenceId: `synthetic:${check}`, evidenceSha256: 'b'.repeat(64) }])) } },
  }
  return { configuration, qualification }
}

it('compiles explicit full access with the native sandbox disabled and app approvals retained', () => {
  const f = fixture('danger-full-access')
  const compiled = compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})
  expect(compiled.sandbox).toEqual({ enabled: false, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false })
  expect(compiled.permissionMode).toBe('default')
  expect(compiled.allowedTools).toEqual(['Read'])
  expect(compiled.tools).toEqual(['Read', 'Bash'])
  expect(compiled.configuration.permissionRules).toContainEqual({ tool: 'Bash', effect: 'ask' })
})

it('requires native full-access policy evidence and exact saved configuration identity', () => {
  const f = fixture('danger-full-access')
  delete f.qualification.persistedProof.claudeProof!.checks.fullAccessPolicy
  expect(() => compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})).toThrow('not proved')
  const restricted = fixture('read-only')
  expect(() => compileClaudeConfiguration({ ...restricted.configuration, sandbox: 'danger-full-access' }, '/fixture/work', restricted.qualification, {})).toThrow('differs')
})

it.each(['read-only', 'workspace-write'] as const)('keeps the existing %s sandbox enforced', (sandbox) => {
  const f = fixture(sandbox)
  expect(compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {}).sandbox).toMatchObject({
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
  })
})

it('denies native read-only writes even when the saved tool rule allows them', () => {
  const f = fixture('read-only')
  f.configuration.tools.push('Write', 'Edit', 'NotebookEdit')
  f.configuration.permissionRules.push({ tool: 'Write', effect: 'allow' })
  const compiled = compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})
  expect(compiled.tools).toEqual(['Read', 'Bash'])
  expect(compiled.allowedTools).not.toContain('Write')
  expect(compiled.disallowedTools).toEqual(['Write', 'Edit', 'NotebookEdit'])
  const userTemporaryDirectory = `claude-${process.getuid?.() ?? 0}`
  expect(compiled.sandbox.filesystem?.denyWrite).toEqual([...new Set([
    '/fixture/work', '~/.npm/_logs', '~/.claude/debug', '/tmp/claude', '/private/tmp/claude',
    join('/tmp', userTemporaryDirectory), join('/private/tmp', userTemporaryDirectory),
    join(tmpdir(), userTemporaryDirectory),
  ])])
  expect(compiled.configuration).toEqual(f.configuration)
  expect(f.configuration.permissionRules).toContainEqual({ tool: 'Write', effect: 'allow' })
})

it('keeps a relocated native temporary directory read-only without allowing additional writes', () => {
  const f = fixture('read-only')
  const compiled = compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification,
    { TMPDIR: '/fixture/temporary' })
  expect(compiled.sandbox.filesystem?.denyWrite).toContain(
    `/fixture/temporary/claude-${process.getuid?.() ?? 0}`,
  )
  expect(compiled.sandbox.filesystem?.allowWrite).toBeUndefined()
  expect(compiled.sandbox.allowUnsandboxedCommands).toBe(false)
})

it('denies the shared repository write mount when executing in a Git worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-read-only-'))
  try {
    const cwd = join(directory, 'work')
    const commonDirectory = join(directory, 'source.git')
    const gitDirectory = join(commonDirectory, 'worktrees', 'agent')
    await mkdir(cwd)
    await mkdir(gitDirectory, { recursive: true })
    await writeFile(join(cwd, '.git'), 'gitdir: ../source.git/worktrees/agent\n')
    const f = fixture('read-only')
    const compiled = compileClaudeConfiguration(f.configuration, cwd, f.qualification, {})
    expect(compiled.sandbox.filesystem?.denyWrite).toContain(commonDirectory)
    expect(compiled.sandbox.filesystem?.denyWrite).toContain(cwd)
    expect(compiled.sandbox.filesystem?.allowWrite).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects read-only execution when only full-access policy was proved', () => {
  const f = fixture('read-only')
  delete f.qualification.persistedProof.claudeProof!.checks.readOnlySandbox
  expect(() => compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})).toThrow('not proved')
})

it('qualifies built-ins separately from MCP names and preserves explicit MCP automatic approvals', () => {
  const f = fixture('danger-full-access')
  f.configuration.tools.push('mcp__graphql__workspace_list')
  f.configuration.permissionRules.push({ tool: 'mcp__graphql__workspace_list', effect: 'allow' })
  f.qualification.persistedProof.claudeProof!.observedTools = ['Read', 'Bash']
  const compiled = compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})
  expect(compiled.tools).toEqual(['Read', 'Bash'])
  expect(compiled.allowedTools).toEqual(['Read', 'mcp__graphql__workspace_list'])
})
