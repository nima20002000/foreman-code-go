// Prints the integration files an index list selects: node scripts/ci-files.mjs 0,4,9-12
// Indexes point into the commit's sorted integration file list, so a slice fits in a short CI parameter.
import { execFileSync } from 'node:child_process'

export function integrationFileList(cwd) {
  return execFileSync('git', ['ls-files', '--', 'apps/api/test'], { cwd, encoding: 'utf8' }).split('\n')
    .filter(path => /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(path)).sort()
}

export function repositoryFileList(cwd) {
  return execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
}

export function selectByIndexes(files, spec) {
  // A leading "s:" keeps a one-file slice from reading as a number in CI parameters.
  return spec.replace(/^s:/, '').split(',').filter(Boolean).flatMap(part => {
    if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error(`Invalid integration file index ${part}`)
    const [first, last = first] = part.split('-').map(Number)
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last || last >= files.length) {
      throw new Error(`Invalid integration file index ${part}`)
    }
    return files.slice(first, last + 1)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv[2] === '--json'
  const files = json ? repositoryFileList(process.cwd()) : integrationFileList(process.cwd())
  const selected = selectByIndexes(files, process.argv[json ? 3 : 2] ?? '')
  console.log(json ? JSON.stringify(selected) : selected.join(' '))
}
