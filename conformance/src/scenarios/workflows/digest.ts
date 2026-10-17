import { createHash } from 'node:crypto'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'

export function workflowDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`
}
