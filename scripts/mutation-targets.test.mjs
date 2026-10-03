import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changedLineRanges, mutatePatterns, mutationTargets, sampleTargets } from './mutation-targets.mjs'

const diff = [
  'diff --git a/apps/api/src/runs/engine.ts b/apps/api/src/runs/engine.ts',
  '--- a/apps/api/src/runs/engine.ts',
  '+++ b/apps/api/src/runs/engine.ts',
  '@@ -10,2 +10,3 @@ export class Engine {',
  '@@ -40 +41 @@ function stop() {',
  '@@ -50,4 +51,0 @@ function removed() {',
  '--- a/apps/api/src/old.ts',
  '+++ /dev/null',
  '@@ -1,5 +0,0 @@',
  '+++ b/apps/api/test/runs.test.ts',
  '@@ -1 +1,2 @@',
  '+++ b/apps/web/src/Board.tsx',
  '@@ -3 +3 @@',
  '+++ b/apps/web/src/Board.test.tsx',
  '@@ -3 +3 @@',
  '+++ b/apps/web/src/shared/mocks/handlers.ts',
  '@@ -3 +3 @@',
  '+++ b/apps/worker/src/cli.mjs',
  '@@ -3 +3 @@',
].join('\n')

describe('mutation targets', () => {
  it('reads added and changed line ranges and skips deletions', () => {
    const ranges = changedLineRanges(diff)
    assert.deepEqual(ranges.get('apps/api/src/runs/engine.ts'), [{ start: 10, end: 12 }, { start: 41, end: 41 }])
    assert.equal(ranges.has('apps/api/src/old.ts'), false)
  })

  it('keeps production source in Vitest packages and drops tests, mocks and other packages', () => {
    assert.deepEqual(mutationTargets(changedLineRanges(diff)), [
      { pkg: 'apps/api', path: 'src/runs/engine.ts', start: 10, end: 12 },
      { pkg: 'apps/api', path: 'src/runs/engine.ts', start: 41, end: 41 },
      { pkg: 'apps/web', path: 'src/Board.tsx', start: 3, end: 3 },
    ])
  })

  it('builds Stryker mutate patterns per package', () => {
    const patterns = mutatePatterns(mutationTargets(changedLineRanges(diff)))
    assert.deepEqual(patterns.get('apps/api'), ['src/runs/engine.ts:10-12', 'src/runs/engine.ts:41-41'])
    assert.deepEqual(patterns.get('apps/web'), ['src/Board.tsx:3-3'])
  })
})

describe('sampling large changes', () => {
  const targets = Array.from({ length: 50 }, (_, index) => ({ pkg: 'apps/api', path: `src/f${index}.ts`, start: 1, end: 10 }))

  it('keeps everything within the budget', () => {
    assert.deepEqual(sampleTargets(targets.slice(0, 3), 30, 'abc'), { targets: targets.slice(0, 3), sampled: false })
  })

  it('samples up to the budget, stable for a seed and different across seeds', () => {
    const first = sampleTargets(targets, 95, 'commit-1')
    const lines = first.targets.reduce((sum, target) => sum + target.end - target.start + 1, 0)
    assert.equal(first.sampled, true)
    assert.equal(lines, 95)
    assert.deepEqual(sampleTargets(targets, 95, 'commit-1'), first)
    assert.notDeepEqual(sampleTargets(targets, 95, 'commit-2').targets, first.targets)
  })
})
