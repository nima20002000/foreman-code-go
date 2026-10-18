import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { affectedSnapshot } from './ci-affected.mjs'
import { integrationPartition } from '../packages/contracts/src/ciPartition.mjs'
import { explicitRelease, repositoryRoot, suiteKind } from './ci-affected-scope.mjs'

export function executionFiles(files, executionSuite, cwd) {
  suiteKind(executionSuite)
  const [suite, part] = executionSuite.split('-')
  const candidates = files.filter(file => !file.startsWith('apps/api/') && !file.startsWith('apps/worker/'))
  if (!part) return candidates
  const heavyPath = join(cwd, 'apps/web/heavy-tests.json')
  const heavy = existsSync(heavyPath) ? JSON.parse(readFileSync(heavyPath, 'utf8')).files : []
  return candidates.filter(file => {
    if (part === 'api') return file.startsWith('backend/')
    if (part === 'other') return !file.startsWith('backend/') && (suite !== 'unit' || !file.startsWith('apps/web/'))
    const isHeavy = heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern))
    return file.startsWith('apps/web/') && (executionSuite === 'unit-web-heavy' ? isHeavy : !isHeavy)
  })
}

/** Learned timings travel with the immutable cloud snapshot, outside provider parameter limits. */
export function executionDurations(suite, cwd, learned = {}) {
  const learnedPath = join(cwd, 'scripts/ci-learned-durations.json')
  const snapshot = existsSync(learnedPath) ? JSON.parse(readFileSync(learnedPath, 'utf8')) : learned
  return snapshot
}

/** Selection and partitioning happen in the checked-out repository on the cloud runner. */
export function executionSelection({ commit, baseCommit, executionSuite, defaultRef, partition, learned = {}, cwd = repositoryRoot, release = false }) {
  const suite = executionSuite.split('-')[0]
  suiteKind(executionSuite)
  if (release) return { scope: 'full', files: [], reason: 'Explicit release mode.' }
  const selection = affectedSnapshot(commit, suite, cwd, defaultRef, baseCommit)
  let files = executionFiles(selection.files, executionSuite, cwd)
  if (partition) {
    files = integrationPartition(files, executionDurations(suite, cwd, learned), partition)
  }
  return { ...selection, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--dispatch-inputs') {
    const data = readFileSync(join(repositoryRoot, 'ci-dispatch-inputs.json'))
    const hash = createHash('sha256').update(data).digest('hex')
    if (process.env.CI_PARTITION !== `sha256:${hash}`) throw new Error('CI dispatch inputs hash mismatch')
    const inputs = JSON.parse(data.toString())
    if (Object.keys(inputs).sort().join(',') !== 'commit,files,partition,slice'
      || Object.values(inputs).some(value => typeof value !== 'string')
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(inputs.commit)
      || inputs.partition.startsWith('sha256:')) throw new Error('Invalid CI dispatch inputs')
    const result = spawnSync('bash', process.argv.slice(3), { cwd: repositoryRoot, stdio: 'inherit', env: { ...process.env,
      SLICE: inputs.slice, SELECTED_FILES: inputs.files, CI_PARTITION: inputs.partition,
      CI_SELECTION_COMMIT: inputs.commit } })
    if (result.error) throw result.error
    if (result.signal) process.kill(process.pid, result.signal)
    process.exit(result.status ?? 1)
  }
  const [executionSuite, defaultRef, partition, output] = process.argv.slice(2)
  const selection = executionSelection({ commit: process.env.CI_SELECTION_COMMIT || 'HEAD', executionSuite, defaultRef,
    release: explicitRelease(),
    baseCommit: process.env.BASE_COMMIT || undefined,
    partition: partition ? JSON.parse(partition) : undefined, learned: JSON.parse(process.env.CI_DURATIONS || '{}') })
  writeFileSync(output, JSON.stringify(selection.files))
  console.error(selection.scope === 'full' ? `Running full suite: ${selection.reason}`
    : `Selected ${selection.files.length} affected files for ${executionSuite}.`)
  console.log(selection.scope)
}
