import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const ciBranch = /^refs\/heads\/(?:ci|ci-default)\/.+$/
interface MirrorRun {
  mirror: string
  commit: string
  baseCommit?: string
  state: string
  mirrorBranch?: string
  dispatch?: { input: { branch: string; defaultBranch?: string } }
}

async function runDirectories(root: string) {
  try {
    return await readdir(join(root, 'runs'), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Terminal tickets release shared mirror branches; active tickets from both providers retain them. */
export async function pruneMirrorBranches(options: {
  mirror: string
  roots: string[]
  git: (args: string[]) => Promise<string>
  keep?: string[]
}) {
  const remote = `https://github.com/${options.mirror}.git`
  const listed = await options.git(['ls-remote', '--heads', remote, 'refs/heads/ci/*', 'refs/heads/ci-default/*'])
  const keep = new Set((options.keep ?? []).map(branch => `refs/heads/${branch}`))
  for (const root of new Set(options.roots)) {
    for (const directory of await runDirectories(root)) {
      if (!directory.isDirectory()) continue
      const run = JSON.parse(await readFile(join(root, 'runs', directory.name, 'meta.json'), 'utf8')) as MirrorRun
      if (run.mirror !== options.mirror || !['starting', 'running', 'queued'].includes(run.state)) continue
      const branch = run.dispatch?.input.branch ?? run.mirrorBranch
      if (branch) keep.add(`refs/heads/${branch}`)
      else {
        // Older persisted tickets predate the stored mirror ref; either publication may still be in use.
        keep.add(`refs/heads/ci/${run.commit}`)
        if (run.baseCommit) keep.add(`refs/heads/ci/${run.commit}-${run.baseCommit}`)
      }
      keep.add(`refs/heads/ci-default/${run.commit}`)
      if (run.dispatch?.input.defaultBranch) keep.add(`refs/heads/${run.dispatch.input.defaultBranch}`)
    }
  }
  const stale = listed.split('\n').flatMap(line => {
    const [sha, ref] = line.trim().split(/\s+/)
    return sha && ref && ciBranch.test(ref) && !keep.has(ref) ? [{ sha, ref }] : []
  })
  for (let offset = 0; offset < stale.length; offset += 50) {
    const batch = stale.slice(offset, offset + 50)
    // A concurrently replaced branch must survive a sweep that saw its previous value.
    await options.git(['push', '--quiet', '--atomic', ...batch.map(({ sha, ref }) => `--force-with-lease=${ref}:${sha}`),
      remote, ...batch.map(({ ref }) => `:${ref}`)])
  }
  const removed = stale.map(({ ref }) => ref.slice('refs/heads/'.length))
  const removedRefs = new Set(stale.map(({ ref }) => ref))
  const retained = listed.split('\n').flatMap(line => {
    const ref = line.trim().split(/\s+/)[1]
    return ref && ciBranch.test(ref) && !removedRefs.has(ref) ? [ref.slice('refs/heads/'.length)] : []
  })
  return { removed, retained }
}

// The maintenance command calls the same sweep used when cloud tickets finish.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mirror, ...roots] = process.argv.slice(2)
  if (!mirror || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(mirror) || !roots.length) {
    throw new Error('Usage: mirrorBranches <owner/repository> <provider-root> [provider-root...]')
  }
  const execute = promisify(execFile)
  const removed = await pruneMirrorBranches({ mirror, roots, git: async args => {
    const result = await execute('git', args, { maxBuffer: 4 * 1024 * 1024 })
    return result.stdout.trim()
  } })
  console.log(JSON.stringify({ removed: removed.removed.length }))
}
