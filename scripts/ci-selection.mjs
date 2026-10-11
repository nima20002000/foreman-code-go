import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, matchesGlob, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { affectedSnapshot } from './ci-affected.mjs'
import { integrationPartition } from '../packages/contracts/src/ciPartition.mjs'
import { integrationFileList } from './ci-files.mjs'

export function executionFiles(files, executionSuite, cwd) {
  const [suite, part] = executionSuite.split('-')
  if (!part) return files
  const heavyPath = join(cwd, 'apps/web/heavy-tests.json')
  const heavy = existsSync(heavyPath) ? JSON.parse(readFileSync(heavyPath, 'utf8')).files : []
  return files.filter(file => {
    if (part === 'api') return file.startsWith('apps/api/')
    if (part === 'other') return !file.startsWith('apps/api/') && (suite !== 'unit' || !file.startsWith('apps/web/'))
    const isHeavy = heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern))
    return file.startsWith('apps/web/') && (executionSuite === 'unit-web-heavy' ? isHeavy : !isHeavy)
  })
}

/** Selection and partitioning happen in the checked-out repository on the cloud runner. */
export function executionSelection({ commit, baseCommit, executionSuite, defaultRef, partition, learned = {}, cwd = process.cwd() }) {
  const suite = executionSuite.split('-')[0]
  const selection = affectedSnapshot(commit, suite, cwd, defaultRef, baseCommit)
  let files = executionFiles(selection.files, executionSuite, cwd)
  if (selection.scope === 'full' && suite === 'integration' && partition) files = integrationFileList(cwd)
  if (partition && (selection.scope === 'affected' || suite === 'integration')) {
    const durationPath = join(cwd, 'scripts', suite === 'integration' ? 'integration-durations.json' : 'unit-durations.json')
    const committed = existsSync(durationPath) ? JSON.parse(readFileSync(durationPath, 'utf8')) : {}
    files = integrationPartition(files, { ...committed, ...learned }, partition)
  }
  return { ...selection, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [executionSuite, defaultRef, partition, output] = process.argv.slice(2)
  const selection = executionSelection({ commit: 'HEAD', executionSuite, defaultRef,
    baseCommit: process.env.BASE_COMMIT || undefined,
    partition: partition ? JSON.parse(partition) : undefined, learned: JSON.parse(process.env.CI_DURATIONS || '{}') })
  writeFileSync(output, JSON.stringify(selection.files))
  console.error(selection.scope === 'full' ? `Running full suite: ${selection.reason}`
    : `Selected ${selection.files.length} affected files for ${executionSuite}.`)
  console.log(selection.scope)
}
