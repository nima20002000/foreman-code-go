import { createClaudeEventNormalizer, type ClaudeDecodedEvent, type ClaudeEventOwner } from './normalization.js'

export interface ClaudeReplayProvenance {
  kind: 'synthetic-contract' | 'recorded-native'
  scenarioId: string
  sourceSha: string
  sdk: { version: string; integrity: string }
  /** Synthetic fixtures deliberately cannot masquerade as a native recording. */
  native: null | { cliVersion: string; cliPath: string; os: string; arch: string; runtime: string }
  sanitizedConfiguration: Readonly<Record<string, string | boolean | number>>
}
export interface ClaudeReplayFixture {
  provenance: ClaudeReplayProvenance
  frames: readonly unknown[]
  end: 'eof' | 'throw'
}

export function validateClaudeReplayFixture(fixture: ClaudeReplayFixture): void {
  const provenance = fixture.provenance
  if (!/^[a-f0-9]{40}$/.test(provenance.sourceSha) || !provenance.scenarioId || !provenance.sdk.version
    || !provenance.sdk.integrity || !Number.isSafeInteger(fixture.frames.length) || fixture.frames.length > 4096) throw new Error('Invalid Claude replay evidence manifest.')
  if (provenance.kind === 'recorded-native' && (!provenance.native || Object.values(provenance.native).some((value) => !value))) throw new Error('Recorded Claude replay requires exact native runtime provenance.')
  if (provenance.kind === 'synthetic-contract' && provenance.native !== null) throw new Error('Synthetic Claude replay is not native availability evidence.')
  if (Object.keys(provenance.sanitizedConfiguration).some((key) => /token|secret|password|api.?key|authorization|cookie|env/i.test(key))) throw new Error('Claude replay configuration must be credential-free.')
}

/** This is the decoded input port shared by production and replay, not another
 * scheduler. The caller provides its already-admitted owner and fake clock. */
export async function* decodeClaudeOutput(output: AsyncIterable<unknown>, options: {
  owner: ClaudeEventOwner; observedAt(): string
}): AsyncIterable<ClaudeDecodedEvent> {
  const normalizer = createClaudeEventNormalizer(options)
  try {
    for await (const frame of output) for (const event of normalizer.ingest(frame)) yield event
  } catch {
    // Exact SDK result evidence already emitted is preserved. Raw error text
    // may include paths or credentials and does not enter public diagnostics.
    for (const event of normalizer.finish(new Error('Claude iterator failed.'))) yield event
    return
  }
  for (const event of normalizer.finish()) yield event
}

export function replayClaudeOutput(fixture: ClaudeReplayFixture): AsyncIterable<unknown> {
  validateClaudeReplayFixture(fixture)
  return { async *[Symbol.asyncIterator]() {
    for (const frame of fixture.frames) yield structuredClone(frame)
    if (fixture.end === 'throw') throw new Error('Injected Claude replay stream loss.')
  } }
}
