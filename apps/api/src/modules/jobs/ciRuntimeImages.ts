import { createHash } from 'node:crypto'
import { runCiRuntimeCommand } from './ciRuntimeCommands.js'

export async function pruneCiImages({ keep, env, installer, signal }: {
  keep: readonly string[]; env: NodeJS.ProcessEnv; installer: string; signal?: AbortSignal | undefined
}) {
  const kept = new Set(keep.map(id => id.replace(/^sha256:/u, '')))
  const installation = createHash('sha256').update(installer).digest('hex')
  const podman = (args: string[]) => runCiRuntimeCommand('podman', ['--remote=false', ...args], { env, signal })
  const listed = JSON.parse((await podman(['images', '--format', 'json'])).stdout) as
    { Id: string; Names?: string[] }[]
  for (const image of listed) {
    const id = image.Id.replace(/^sha256:/u, '')
    if (kept.has(id)) continue
    const names = image.Names ?? []
    if (names.length !== 1 || !/^localhost\/foreman-code-(?:verification|ci-build):[a-f0-9]{12}$/u.test(names[0]!)) {
      continue
    }
    const inspected = JSON.parse((await podman(['image', 'inspect', image.Id])).stdout) as
      { Id: string; Labels?: Record<string, string> }[]
    const owned = inspected[0]
    if (inspected.length !== 1 || owned?.Id.replace(/^sha256:/u, '') !== id
      || owned.Labels?.['io.foreman-code.installation'] !== installation) continue
    // Podman refuses removal while an execution or Buildah container references the image.
    await podman(['rmi', '--no-prune', image.Id]).catch(error => {
      if (error.code !== 2) throw error
    })
  }
  // Include intermediate build images. Removal without force or parent pruning preserves
  // layers still referenced by kept images, foreign images, or containers.
  let removed: boolean
  do {
    removed = false
    const dangling = JSON.parse((await podman(['images', '--all', '--filter', 'dangling=true', '--format', 'json'])).stdout) as
      { Id: string; Names?: string[] }[]
    for (const image of dangling) {
      const id = image.Id.replace(/^sha256:/u, '')
      if (kept.has(id) || image.Names?.length) continue
      const inspected = JSON.parse((await podman(['image', 'inspect', image.Id])).stdout) as
        { Id: string; Labels?: Record<string, string> }[]
      const owned = inspected[0]
      const owner = owned?.Labels?.['io.foreman-code.installation']
      if (inspected.length !== 1 || owned?.Id.replace(/^sha256:/u, '') !== id
        || (owner !== undefined && owner !== installation)) continue
      try {
        await podman(['rmi', '--no-prune', image.Id])
        removed = true
      } catch (error) {
        if ((error as { code?: unknown }).code !== 2) throw error
      }
    }
  } while (removed)
}
