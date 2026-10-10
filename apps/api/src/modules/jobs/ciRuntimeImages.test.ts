import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pruneCiImages } from './ciRuntimeImages.js'

const command = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (_file: string, args: string[]) =>
      ({ stdout: await command.run(args.slice(1)), stderr: '' }),
  }) }
})

const installer = '/ci/installer'
const installation = createHash('sha256').update(installer).digest('hex')
const name = 'localhost/foreman-code-verification:abcdef123456'
afterEach(() => command.run.mockReset())

describe('CI image pruning', () => {
  it('preserves foreign names, installations, additional tags and retained image IDs', async () => {
    const images = [
      { Id: 'a'.repeat(64), Names: [name], owner: installation },
      { Id: 'b'.repeat(64), Names: [name], owner: installation },
      { Id: 'c'.repeat(64), Names: ['registry.example.test/team/foreman-code-verification-fixture:latest'], owner: installation },
      { Id: 'd'.repeat(64), Names: ['localhost/foreman-code-verification-fixture:abcdef123456'], owner: installation },
      { Id: 'e'.repeat(64), Names: [name], owner: 'another-installation' },
      { Id: 'f'.repeat(64), Names: [name, 'localhost/another-project:latest'], owner: installation },
      { Id: '1'.repeat(64), Names: [name], owner: undefined },
    ]
    const removed: string[] = []
    command.run.mockImplementation(async (args: string[]) => {
      if (args[0] === 'images') return JSON.stringify(images)
      if (args[0] === 'image') {
        const image = images.find(value => value.Id === args.at(-1))!
        return JSON.stringify([{ Id: image.Id, Labels: { 'io.foreman-code.installation': image.owner } }])
      }
      if (args[0] === 'rmi') removed.push(args.at(-1)!)
      return ''
    })
    await pruneCiImages({ keep: [`sha256:${'b'.repeat(64)}`], env: process.env, installer })
    expect(removed).toEqual(['a'.repeat(64)])
  })

  it('keeps an untagged retained parent when deleting its owned child', async () => {
    const parent = 'a'.repeat(64)
    const child = 'b'.repeat(64)
    const images = new Set([parent, child])
    command.run.mockImplementation(async (args: string[]) => {
      if (args[0] === 'images') return JSON.stringify([
        { Id: parent, Names: [] }, { Id: child, Names: [name] },
      ])
      if (args[0] === 'image') return JSON.stringify([{ Id: child,
        Labels: { 'io.foreman-code.installation': installation } }])
      if (args[0] === 'rmi') {
        images.delete(child)
        if (!args.includes('--no-prune')) images.delete(parent)
      }
      return ''
    })
    await pruneCiImages({ keep: [`sha256:${parent}`], env: process.env, installer })
    expect([...images]).toEqual([parent])
  })

  it('reclaims intermediate chains while preserving retained, foreign and container-referenced images', async () => {
    const images = new Map([
      ['parent', { Names: [] as string[], owner: undefined as string | undefined }],
      ['child', { Names: [] as string[], owner: installation }],
      ['old', { Names: [name], owner: installation }],
      ['kept', { Names: [] as string[], owner: installation }],
      ['foreign', { Names: [] as string[], owner: 'other-installation' }],
      ['container', { Names: [] as string[], owner: undefined }],
      ['kept-parent', { Names: [] as string[], owner: undefined }],
      ['foreign-parent', { Names: [] as string[], owner: undefined }],
    ])
    const parents = new Map([['old', 'child'], ['child', 'parent'],
      ['kept', 'kept-parent'], ['foreign', 'foreign-parent']])
    command.run.mockImplementation(async (args: string[]) => {
      const id = args.at(-1)!
      if (args[0] === 'images') return JSON.stringify([...images].map(([Id, image]) => ({ Id, Names: image.Names })))
      if (args[0] === 'image') return JSON.stringify([{ Id: id,
        Labels: { 'io.foreman-code.installation': images.get(id)!.owner } }])
      if (args[0] === 'rmi') {
        if (id === 'container' || [...parents].some(([child, parent]) => parent === id && images.has(child))) {
          throw Object.assign(new Error('image is referenced'), { code: 2 })
        }
        images.delete(id)
        if (!args.includes('--no-prune') && parents.has(id)) images.delete(parents.get(id)!)
      }
      return ''
    })
    await pruneCiImages({ keep: ['sha256:kept'], env: process.env, installer })
    expect([...images.keys()]).toEqual(['kept', 'foreign', 'container', 'kept-parent', 'foreign-parent'])
  })

  it.each([2, 1, 125])('skips only Podman reference conflicts and surfaces exit status %s', async code => {
    const failure = Object.assign(new Error('permission denied: .local/share/containers/storage'), { code })
    command.run.mockImplementation(async (args: string[]) => {
      if (args[0] === 'images') return JSON.stringify([{ Id: 'a'.repeat(64), Names: [name] }])
      if (args[0] === 'image') return JSON.stringify([{ Id: 'a'.repeat(64),
        Labels: { 'io.foreman-code.installation': installation } }])
      throw failure
    })
    const pruning = pruneCiImages({ keep: [], env: process.env, installer })
    if (code === 2) await expect(pruning).resolves.toBeUndefined()
    else await expect(pruning).rejects.toBe(failure)
  })
})
