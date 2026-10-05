import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { assertCodexProtectedOutputPlacement, codexNativeOutputSandboxProbeCommand,
  matchesCodexNativeProbeCommand } from '../src/modules/harnesses/qualification/suites/codexNativeOutputSandbox.js'

// Probe construction is exercised without a native sandbox or a protected-store qualification.
const sandbox = { cwd: '/owned/work', writableRoots: ['/owned/extra'], networkAccess: false,
  excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: '/owned/tmp' }
describe('Codex exact-binary native output protection check definitions', () => {
  it('requires canonical protected storage outside cwd and every effective writable root', () => {
    assert.doesNotThrow(() => assertCodexProtectedOutputPlacement('/protected/store', sandbox))
    for (const root of ['/owned/work/store', '/owned/extra/store', '/owned', 'relative-store']) {
      assert.throws(() => assertCodexProtectedOutputPlacement(root, sandbox))
    }
  })
  it('accounts for actual TMPDIR and slash-tmp according to measured exclusion policy', () => {
    assert.throws(() => assertCodexProtectedOutputPlacement('/owned/tmp/store', { ...sandbox, excludeTmpdirEnvVar: false }))
    assert.throws(() => assertCodexProtectedOutputPlacement('/tmp/store', { ...sandbox, excludeSlashTmp: false }))
    assert.throws(() => assertCodexProtectedOutputPlacement('/protected/store', { ...sandbox, excludeTmpdirEnvVar: false, tmpdir: 'relative' }))
    assert.doesNotThrow(() => assertCodexProtectedOutputPlacement('/tmp/store', sandbox))
  })
  it('records the direct actor, its descendant and the environment in the filesystem witness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-probe-command-'))
    const paths = { directPath: join(directory, "direct'file"), descendantPath: join(directory, 'child'),
      witnessPath: join(directory, 'witness'), marker: 'recorded-marker' }
    try {
      const command = codexNativeOutputSandboxProbeCommand(paths)
      const executed = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8',
        env: { ...process.env, TMPDIR: directory } })
      assert.equal(executed.status, 0, executed.stderr)
      const result = JSON.parse(executed.stdout)
      assert.deepEqual(result, JSON.parse(await readFile(paths.witnessPath, 'utf8')))
      assert.equal(result.marker, paths.marker)
      assert.equal(result.uid, process.getuid?.())
      assert.equal(result.tmpdir, directory)
      assert.deepEqual(result.direct, { denied: false, errno: null })
      assert.deepEqual(result.descendant, { denied: false, errno: null })
      assert.equal(result.descendantExitCode, 0)
      assert.equal(await readFile(paths.directPath, 'utf8'), paths.marker)
      assert.equal(await readFile(paths.descendantPath, 'utf8'), paths.marker)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('matches only the original payload in the selected shell wrapper', () => {
    const command = "printf '%s' \"quoted\\value\"\n# $literal `literal`"
    const singleQuoted = `'${command.replaceAll("'", "'\\''")}'`
    const doubleQuoted = `"${command.replace(/[\\"$`]/gu, '\\$&')}"`
    assert.equal(matchesCodexNativeProbeCommand(command, command, '/bin/bash'), true)
    for (const quoted of [singleQuoted, doubleQuoted]) {
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -lc ${quoted}`, command, '/bin/bash'), true)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -c ${quoted}`, command, '/bin/bash'), true)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/sh -lc ${quoted}`, command, '/bin/bash'), false)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -lc ${quoted}; echo extra`, command, '/bin/bash'), false)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -lc ${quoted} extra`, command, '/bin/bash'), false)
    }
    assert.equal(matchesCodexNativeProbeCommand('/bin/bash -lc "different script"', command, '/bin/bash'), false)
    assert.equal(matchesCodexNativeProbeCommand(null, command, '/bin/bash'), false)
  })
  it('preserves a quoted pathname in parseable Python', () => {
    const command = codexNativeOutputSandboxProbeCommand({ directPath: "/protected/store/quoted'path", descendantPath: '/protected/store/child',
      witnessPath: '/owned/work/witness', marker: 'recorded-marker' })
    const parsed = spawnSync('/usr/bin/python3', ['-c', `import ast,shlex,sys
args=shlex.split(sys.argv[1])
assert args[:2]==['/usr/bin/python3','-c'] and len(args)==3
ast.parse(args[2])`, command], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr)
  })
})
