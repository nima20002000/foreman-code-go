// Emits the same report shape as Vitest so CI can merge results from both runners.
export default async function* reportTests(events) {
  const files = new Map()
  for await (const { type, data } of events) {
    if (type !== 'test:pass' && type !== 'test:fail') continue
    if (data.details?.type === 'suite' || data.details?.error?.failureType === 'subtestsFailed') continue
    const name = data.file ?? 'unknown file'
    const file = files.get(name) ?? { name, status: 'passed', assertionResults: [] }
    const skipped = data.skip !== undefined || data.todo !== undefined
    const status = skipped ? 'pending' : type === 'test:fail' ? 'failed' : 'passed'
    if (status === 'failed') file.status = 'failed'
    const error = data.details?.error
    const failure = error?.cause?.stack ?? error?.stack ?? error?.message
    file.assertionResults.push({ fullName: data.name, status, duration: data.details?.duration_ms ?? null,
      ...(failure ? { failureMessages: [failure] } : {}) })
    files.set(name, file)
  }
  yield JSON.stringify({ testResults: [...files.values()] })
}
