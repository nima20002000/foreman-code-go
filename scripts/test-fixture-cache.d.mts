export function testFixtureCacheRoot(environment?: Record<string, string | undefined>): string
export function workerFixtureInputs(repository: string, commit: string): Promise<Buffer>
export function cachedTestFixture(
  root: string,
  namespace: string,
  inputs: readonly (string | Buffer)[],
  populate: (directory: string) => Promise<void>,
): Promise<string>
