import { createHash } from 'node:crypto'
import { TEST_FILE } from './test-results.mjs'

// Packages whose unit tests run on Vitest, which Stryker drives.
export const MUTATION_PACKAGES = {
  'apps/api': /^src\/.*\.ts$/,
  'apps/web': /^src\/.*\.tsx?$/,
  'packages/contracts': /^src\/.*\.ts$/,
}

const NOT_PRODUCTION = /(?:^|\/)(?:test|tests|__tests__|fixtures|mocks|testing|dev)\/|\.d\.ts$|\.(?:cases|fixture|testSupport)\.tsx?$/

/** Parses `git diff --unified=0` output into added or changed line ranges per file. */
export function changedLineRanges(diff) {
  const ranges = new Map()
  let file
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? undefined : line.slice('+++ b/'.length)
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!file || !hunk) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    if (count > 0) ranges.set(file, [...(ranges.get(file) ?? []), { start, end: start + count - 1 }])
  }
  return ranges
}

/** Groups changed production ranges by package, with paths relative to the package. */
export function mutationTargets(ranges) {
  const targets = []
  for (const [file, fileRanges] of ranges) {
    const pkg = Object.keys(MUTATION_PACKAGES).find((dir) => file.startsWith(`${dir}/`))
    if (!pkg) continue
    const path = file.slice(pkg.length + 1)
    if (!MUTATION_PACKAGES[pkg].test(path) || TEST_FILE.test(path) || NOT_PRODUCTION.test(path)) continue
    for (const range of fileRanges) targets.push({ pkg, path, ...range })
  }
  return targets
}

const lineCount = (targets) => targets.reduce((sum, target) => sum + target.end - target.start + 1, 0)

/**
 * Keeps every target when they fit the line budget. Otherwise picks a sample ordered by a hash
 * of the seed, so the selection is stable for one commit and unpredictable before it exists.
 */
export function sampleTargets(targets, maxLines, seed) {
  if (lineCount(targets) <= maxLines) return { targets, sampled: false }
  const rank = (target) => createHash('sha256').update(`${seed}:${target.pkg}/${target.path}:${target.start}`).digest('hex')
  const chosen = []
  let lines = 0
  for (const target of [...targets].sort((a, b) => rank(a).localeCompare(rank(b)))) {
    const end = Math.min(target.end, target.start + (maxLines - lines) - 1)
    if (end < target.start) break
    chosen.push({ ...target, end })
    lines += end - target.start + 1
  }
  return { targets: chosen, sampled: true }
}

/** Stryker `--mutate` patterns per package, such as `src/runs/engine.ts:10-24`. */
export function mutatePatterns(targets) {
  const patterns = new Map()
  for (const { pkg, path, start, end } of targets) patterns.set(pkg, [...(patterns.get(pkg) ?? []), `${path}:${start}-${end}`])
  return patterns
}
