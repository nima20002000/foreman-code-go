import { expect, it } from 'vitest'
import { pruneMirrorBranches } from './mirrorBranches.js'

it('retains the same reserved refs in a large mirror and protects reservations added during deletion', async () => {
  const sha = 'a'.repeat(40)
  const branches = Array.from({ length: 4_000 }, (_, index) => `ci/snapshot-${index}`)
  const reserved = new Set(branches.filter((_, index) => index % 2 === 0))
  const commands: string[][] = []
  const result = await pruneMirrorBranches({ mirror: 'example/project-ci', roots: [],
    keep: () => [...reserved], git: async args => {
      commands.push(args)
      if (args[0] === 'ls-remote') return [...branches, 'ci-default/shared', 'feature/keep']
        .map(branch => `${sha}\trefs/heads/${branch}`).join('\n')
      if (commands.length === 2) reserved.add('ci/snapshot-3999')
      return ''
    } })
  expect(result.retained).toEqual(branches.filter(branch => reserved.has(branch)))
  expect(result.removed).toEqual([...branches.filter(branch => !reserved.has(branch)), 'ci-default/shared'])
  for (const args of commands.filter(args => args[0] === 'push')) {
    expect(args).toContain('--atomic')
    const deleted = args.filter(arg => arg.startsWith(':refs/heads/'))
    expect(deleted.length).toBeLessThanOrEqual(50)
    for (const ref of deleted) expect(args).toContain(`--force-with-lease=${ref.slice(1)}:${sha}`)
  }
})
