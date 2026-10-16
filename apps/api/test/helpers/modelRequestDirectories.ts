export function modelRequestDirectories(
  calls: ReadonlyArray<Record<string, unknown>>,
  _workingDirectory: string,
): string[] {
  return [...new Set(calls.filter(call => call.method === 'model/list')
    .map(call => call.workingDirectory as string))]
}
