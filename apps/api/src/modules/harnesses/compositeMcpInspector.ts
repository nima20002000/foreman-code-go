import type { NativeMcpInspectionEvidence, NativeMcpInspector } from './mcpDetection.js'

/** Dispatches to provider-native, model-free inspection without sharing provider process identity. */
export class CompositeNativeMcpInspector implements NativeMcpInspector {
  constructor(
    private readonly codex: NativeMcpInspector,
    private readonly inspectOpenCode: (input: Parameters<NativeMcpInspector['inspect']>[0]) => Promise<NativeMcpInspectionEvidence>,
  ) {}

  inspect(input: Parameters<NativeMcpInspector['inspect']>[0]): Promise<NativeMcpInspectionEvidence> {
    return input.harness === 'codex' ? this.codex.inspect(input) : this.inspectOpenCode(input)
  }
}
