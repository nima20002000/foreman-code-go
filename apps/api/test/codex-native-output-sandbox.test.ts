import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'vitest'
import { assertCodexProtectedOutputPlacement, codexNativeOutputSandboxProbeCommand } from '../src/modules/harnesses/qualification/suites/codexNativeOutputSandbox.js'

// Pure definitions only: these tests DO NOT establish native protected-store qualification.
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
  it('defines direct and actual descendant writes plus a permitted-root environment witness', () => {
    const command = codexNativeOutputSandboxProbeCommand({ directPath: '/protected/store/direct', descendantPath: '/protected/store/child',
      witnessPath: '/owned/work/witness', marker: 'recorded-marker' })
    assert(command.startsWith('/usr/bin/python3 -c '))
    assert(command.includes('subprocess.run'))
    assert(command.includes('TMPDIR'))
    assert(command.includes('/protected/store/direct'))
    assert(command.includes('/protected/store/child'))
    assert(command.includes('/owned/work/witness'))
    assert(command.includes('errno.EACCES'))
    assert(command.includes('errno.EROFS'))
  })
  it('produces parseable direct/descendant Python without executing either probe', () => {
    const command = codexNativeOutputSandboxProbeCommand({ directPath: "/protected/store/quoted'path", descendantPath: '/protected/store/child',
      witnessPath: '/owned/work/witness', marker: 'recorded-marker' })
    const parsed = spawnSync('/usr/bin/python3', ['-c', `import ast,shlex,sys
args=shlex.split(sys.argv[1])
assert args[:2]==['/usr/bin/python3','-c'] and len(args)==3
tree=ast.parse(args[2])
child=next(node.value for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='child' for target in node.targets))
ast.parse(ast.literal_eval(child))`, command], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr)
  })
})
