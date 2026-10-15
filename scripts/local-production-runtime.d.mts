import type { SpawnOptions } from 'node:child_process'

type DependencyCommandRunner = (
  command: string,
  args: string[],
  options?: Pick<SpawnOptions, 'timeout' | 'killSignal'>,
) => Promise<unknown>

export function apiServiceTemplate(databaseUnit: string): string
export function installProductionDependencies(run: DependencyCommandRunner): Promise<void>
export function deployProductionApi(
  run: DependencyCommandRunner,
  destination: string,
  options?: { dependencies: { root: string; source: string } },
): Promise<void>
export function publish(path: string, content: string, mode?: number): Promise<void>
export function measureProductionStep<T>(step: string, action: () => Promise<T>, log?: (message: string) => void): Promise<T>
export function buildProductionSource<T = undefined>(
  run: (command: string, args: string[]) => Promise<unknown>,
  options?: { stage: () => Promise<T> },
): Promise<T>
