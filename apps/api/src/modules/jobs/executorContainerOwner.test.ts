import { describe, expect, it, vi } from 'vitest'
import { OwnedOCIContainer, parseOCIProcessStat, type OCIContainerOwnership } from './executorContainerOwner.js'

const boot = '00000000-0000-4000-8000-000000000001'
describe('original OCI owner identity checks, no container or PID signals', () => {
  it('parses start ticks with spaces/parentheses in the kernel command name', () => {
    const fields = ['S', ...Array(18).fill('0'), '12345', '0']
    expect(parseOCIProcessStat(42, `42 (command (nested) name) ${fields.join(' ')}`, boot)).toEqual({ pid: 42, startTicks: '12345', bootId: boot })
    expect(() => parseOCIProcessStat(43, `42 (name) ${fields.join(' ')}`, boot)).toThrow()
    expect(() => parseOCIProcessStat(42, '42 (name) S 0', boot)).toThrow()
  })
  it('rejects foreign labels before binding any journal identity', async () => {
    const ownership = { assertCurrent: vi.fn(), bindContainer: vi.fn() } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: 'a'.repeat(64), Config: { Labels: { owner: 'other' } } }]) })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    await expect(owner.bind('a'.repeat(64))).rejects.toThrow('ownership labels')
    expect(ownership.bindContainer).not.toHaveBeenCalled()
    expect(commands.run).toHaveBeenCalledOnce()
  })
  it('missing original receipt is unconfirmed and never becomes a stop acknowledgment', async () => {
    const ownership = { assertCurrent: vi.fn() } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async () => ({ exitCode: 1, stdout: '' })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    expect(await owner.close(1)).toBe(false)
    expect(commands.run).toHaveBeenCalledWith(['container', 'inspect', 'original'])
  })
  it('an unbounded original conmon helper prevents closure even after the container exited', async () => {
    const containerId = 'a'.repeat(64)
    const scope = { subject: { kind: 'job' as const, executionId: 'job', attemptId: 'attempt', operationId: 'operation', bindingHash: 'b'.repeat(64) },
      leaseId: 'lease', owner: { grantId: 'grant', epoch: '1' }, observedDeviceId: 'device', observedInstallationId: 'installed', bootId: boot }
    const certificate = { scope, containerId, process: { pid: 42, startTicks: '123', bootId: boot },
      boundary: { kind: 'cgroup-v2' as const, path: '/sys/fs/cgroup/graphql-ci-test-absent-original-boundary', device: '1', inode: '2' },
      helpers: [{ kind: 'conmon' as const, process: { pid: 43, startTicks: '124', bootId: boot }, boundary: null }], lifecycle: 'active' as const }
    const ownership = { scope, assertCurrent: vi.fn(), bindContainer: vi.fn(), readCertificate: vi.fn(async () => certificate), publish: vi.fn() } as unknown as OCIContainerOwnership
    const commands = { run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Config: { Labels: { owner: 'original' } },
      State: { Running: false, Pid: 0, Status: 'exited' } }]) })) }
    const owner = new OwnedOCIContainer({ identity: 'original', labels: { owner: 'original' } }, commands, ownership)
    expect(await owner.close(1)).toBe(false)
    expect(ownership.publish).toHaveBeenCalledWith({ ...certificate, lifecycle: 'closure-unconfirmed' })
  })
})
