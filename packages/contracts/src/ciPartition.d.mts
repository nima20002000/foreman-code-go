import type { CiPartition } from './ciHost.js'

export function integrationPartition(files: readonly string[], durations: Readonly<Record<string, number>>,
  partition: CiPartition): string[]
