import type { CiProgressEvent } from './progress.js'

export function writeCiProgressEvent(type: 'start' | 'finish', event: CiProgressEvent): void
