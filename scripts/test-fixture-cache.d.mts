export function cachedTestFixture(
  root: string,
  namespace: string,
  inputs: readonly (string | Buffer)[],
  populate: (directory: string) => Promise<void>,
): Promise<string>
