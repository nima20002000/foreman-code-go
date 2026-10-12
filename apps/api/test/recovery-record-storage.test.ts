import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRecord, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) }
})

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'recovery-record-'))
  directories.push(directory)
  const path = join(directory, 'record.json')
  const value = { launchId: 'original', closed: true }
  writeRecord(path, value, true)
  return { directory, path, value }
}

describe('recovery record reads', () => {
  it('reads a completed immutable publication after its temporary hard link disappears', async () => {
    const f = fixture()
    const temporary = join(f.directory, '.pending-publication')
    fs.linkSync(f.path, temporary)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.fstatSync).mockImplementationOnce(((fd: number) => {
      const stat = actual.fstatSync(fd)
      fs.unlinkSync(temporary)
      return stat
    }) as typeof fs.fstatSync)

    expect(readRecord(f.path)).toEqual(f.value)
    expect(fs.statSync(f.path).nlink).toBe(1)
  })

  it('rejects a record whose extra hard link remains', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, 'retained-link'))
    expect(() => readRecord(f.path)).toThrow('Unsafe or oversized recovery record.')
  })

  it.each(['nonprivate', 'oversized', 'symlink'] as const)('rejects a %s record', (kind) => {
    const f = fixture()
    if (kind === 'nonprivate') fs.chmodSync(f.path, 0o640)
    if (kind === 'oversized') fs.writeFileSync(f.path, 'x'.repeat(64 * 1024 + 1))
    const path = kind === 'symlink' ? join(f.directory, 'symlink.json') : f.path
    if (kind === 'symlink') fs.symlinkSync(f.path, path)
    expect(() => readRecord(path)).toThrow()
  })
})
