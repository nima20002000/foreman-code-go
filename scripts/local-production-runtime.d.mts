export function apiServiceTemplate(databaseUnit: string): string
export function deployProductionApi(
  run: (command: string, args: string[]) => Promise<unknown>,
  destination: string,
): Promise<void>
