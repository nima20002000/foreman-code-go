import { closeSync, constants, statfsSync, fstatSync, openSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, normalize } from 'node:path'
import { recordObject } from './storage.js'

/** Kernel launch boundary: setsid/setpgid do not move a descendant out of a cgroup. */
export interface NativeCgroupBoundary {
  kind: 'cgroup-v2'
  path: string
  device: string
  inode: string
}

export function cgroupBoundary(value: unknown, id: string): NativeCgroupBoundary {
  const row = recordObject(value)
  if (row.kind !== 'cgroup-v2' || typeof row.path !== 'string'
    || !row.path.startsWith('/sys/fs/cgroup/') || normalize(row.path) !== row.path
    || basename(row.path) !== `graphql-native-${id}`
    || typeof row.device !== 'string' || !/^\d+$/.test(row.device)
    || typeof row.inode !== 'string' || !/^\d+$/.test(row.inode)) {
    throw new Error('Invalid native cgroup ownership certificate.')
  }
  return row as unknown as NativeCgroupBoundary
}

function withBoundary<T>(boundary: NativeCgroupBoundary, work: (directory: string) => T): T {
  const fd = openSync(boundary.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (stat.dev.toString() !== boundary.device || stat.ino.toString() !== boundary.inode
      || statfsSync(`/proc/self/fd/${fd}`).type !== 0x63677270) throw new Error('Native cgroup identity changed; closure cannot be confirmed.')
    // Pin the directory while observing/signaling it; never act on a recycled path.
    return work(`/proc/self/fd/${fd}`)
  } finally { closeSync(fd) }
}

export function cgroupPopulated(boundary: NativeCgroupBoundary): boolean {
  return withBoundary(boundary, (directory) => {
    const match = /^populated ([01])$/m.exec(readFileSync(`${directory}/cgroup.events`, 'utf8'))
    if (!match) throw new Error('Native cgroup population evidence is unavailable.')
    return match[1] === '1'
  })
}

export function killCgroup(boundary: NativeCgroupBoundary): void {
  withBoundary(boundary, (directory) => writeFileSync(`${directory}/cgroup.kill`, '1'))
}

/** Only called AFTER a durable, qualified closed record was published. */
export function retireCgroup(boundary: NativeCgroupBoundary): void {
  try {
    withBoundary(boundary, (directory) => {
      const population = /^populated ([01])$/m.exec(readFileSync(`${directory}/cgroup.events`, 'utf8'))
      if (population?.[1] !== '0') throw new Error('A closed native cgroup is populated or unreadable; retirement is unconfirmed.')
      let visited = 0
      const removeChildren = (parent: string, depth: number): void => {
        if (++visited > 10_000 || depth > 64) throw new Error('Native cgroup retirement exceeds its bounded scan.')
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('Unsafe native cgroup entry.')
          if (!entry.isDirectory()) continue
          const child = `${parent}/${entry.name}`
          removeChildren(child, depth + 1)
          // cgroupfs refuses removal if a process populated this subtree meanwhile.
          rmdirSync(child)
        }
      }
      removeChildren(directory, 0)
      rmdirSync(boundary.path)
    })
  } catch (error) {
    // A prior retirement may have removed it after publishing the same close proof.
    // Missing cgroup evidence is NOT accepted by cgroupPopulated during recovery.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
