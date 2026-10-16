export function modelRequestDirectories(
  calls: ReadonlyArray<Record<string, unknown>>,
  workingDirectory: string,
): string[] {
  return [...new Set(calls.filter(call => call.method === 'model/list')
    .map(call => call.workingDirectory)
    .filter((directory): directory is string => typeof directory === 'string'
      && (directory === workingDirectory || directory.startsWith(`${workingDirectory}/`))))]
}
