// Mutation-tests the production lines a pull request adds or changes, and fails when tests
// that execute those lines do not notice them breaking. Needs BASE_SHA and HEAD_SHA.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedLineRanges, mutatePatterns, mutationTargets, sampleTargets } from './mutation-targets.mjs'
import { mutationVerdict, summarizeMutationReport } from './mutation-report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { BASE_SHA, HEAD_SHA, GITHUB_STEP_SUMMARY } = process.env
const { minimumCoveredScore, maxMutatedLines } = JSON.parse(readFileSync(join(root, 'test-policy.json'), 'utf8')).mutation
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

const mergeBase = git('merge-base', BASE_SHA, HEAD_SHA).trim()
const diff = git('diff', '--unified=0', '--no-color', mergeBase, HEAD_SHA, '--', 'apps/api/src', 'apps/web/src', 'packages/contracts/src')
const { targets, sampled } = sampleTargets(mutationTargets(changedLineRanges(diff)), maxMutatedLines, HEAD_SHA)
const reportDirectory = mkdtempSync(join(tmpdir(), 'mutation-'))

function mutate(pkg, patterns) {
  const report = join(reportDirectory, `${pkg.replace('/', '-')}.json`)
  const stryker = ['exec', 'stryker', 'run', join(root, 'scripts/stryker.config.mjs'), '--mutate', patterns.join(',')]
  const run = spawnSync('node', [join(root, 'scripts/heavy-job.mjs'), '--', 'corepack', 'pnpm', ...stryker], {
    cwd: join(root, pkg), stdio: 'inherit', env: { ...process.env, MUTATION_REPORT: report, UNIT_TESTS_ONLY: '1' },
  })
  if (run.status !== 0 || !existsSync(report)) throw new Error(`Stryker failed in ${pkg} (exit ${run.status}).`)
  return summarizeMutationReport(JSON.parse(readFileSync(report, 'utf8')), pkg)
}

const summaries = [...mutatePatterns(targets)].map(([pkg, patterns]) => mutate(pkg, patterns))
const verdict = mutationVerdict(summaries, minimumCoveredScore)

const lines = [
  '## Mutation testing',
  targets.length === 0 ? 'No production lines changed in Vitest packages.' : '',
  sampled ? `This change is larger than ${maxMutatedLines} lines, so a sample chosen by the commit was mutated.` : '',
  ...summaries.map(({ pkg, counts, coveredScore }) => `- ${pkg}: ${counts.detected} detected, ${counts.survived} survived, `
    + `${counts.noCoverage} not covered by unit tests; covered score ${coveredScore ?? 'n/a'}%`),
  `Covered score ${verdict.coveredScore ?? 'n/a'}%, minimum ${minimumCoveredScore}%.`,
  ...summaries.flatMap((summary) => summary.survivors).map((survivor) => `- survived: \`${survivor}\``),
].filter(Boolean)
const report = `${lines.join('\n')}\n`
process.stdout.write(report)
if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, report)
if (!verdict.pass) {
  process.stderr.write('Tests execute the changed code above but do not detect the surviving mutants. '
    + 'Add assertions on the behavior those lines produce.\n')
  process.exit(1)
}
