import { DomainError } from '../errors.js'
import type { createInstalledHarnessQualificationReader } from './installedCodexQualification.js'
import { ManagedOpenCodeServer, type ManagedOpenCodeServerOptions } from './opencodeTransport.js'
import { runWithReadOnlyQualification } from './qualification/gate.js'
import { normalizeHarnessVersion } from './qualification/profiles.js'
import { HarnessQualificationRegistry } from './qualification/registry.js'

/** The installed resident starts only within authenticated exact-binary qualification. */
export class InstalledOpenCodeServer extends ManagedOpenCodeServer {
  private readonly qualifications: HarnessQualificationRegistry

  constructor(options: ManagedOpenCodeServerOptions, private readonly installed: {
    reader: ReturnType<typeof createInstalledHarnessQualificationReader>
    suiteRevision: string
  }) {
    super(options)
    this.qualifications = new HarnessQualificationRegistry(installed.reader.repository,
      { opencode: installed.suiteRevision })
  }

  override async ensure(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const before = await this.installed.reader.capture()
    await runWithReadOnlyQualification(this.qualifications, () => super.ensure(signal))
    const after = await this.installed.reader.capture()
    if (before.qualification.version !== after.qualification.version
      || normalizeHarnessVersion('opencode', this.expectedVersion) !== after.qualification.version) {
      throw new DomainError('HARNESS_UNQUALIFIED', 'The installed OpenCode version changed.', 409)
    }
    signal?.throwIfAborted()
  }
}
