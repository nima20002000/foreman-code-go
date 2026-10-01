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
})
