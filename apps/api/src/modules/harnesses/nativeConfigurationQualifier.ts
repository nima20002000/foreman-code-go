import type { HarnessConfiguration, HarnessQualification } from '@graphql/contracts'
import type { HarnessConfigurationQualifier } from './port.js'
import { NativeHarnessFactories } from './runtimeFactory.js'

/** Model-free native qualification is separate from passive installation discovery. */
export class NativeHarnessConfigurationQualifier implements HarnessConfigurationQualifier {
  private readonly factories: NativeHarnessFactories
  constructor(codexBinary: string, openCodeBinary: string, factories?: NativeHarnessFactories) {
    this.factories = factories ?? new NativeHarnessFactories({ codexBinary, openCodeBinary })
  }

  qualify(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal): Promise<HarnessQualification> {
    return this.factories.qualifyConfiguration(configuration, workingDirectory, signal)
  }
}
