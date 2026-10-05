import type { OpenCodeHarnessConfiguration, NativeSessionReference } from '@graphql/contracts'
import type { WorkerNativeOutputCommand, WorkerNativeOutputReply } from '@graphql/contracts/worker-native-output'
import type { CodexNativeOutputQualificationInput, CodexNativeOutputs } from './codexNativeOutput.js'

export interface NativeOutputTurnPin {
  session: NativeSessionReference
  connectionId: string
  runtimeGeneration: number
  nativeTurnId: string
  assertCurrent(): void
}
export interface NativeOutputCallback extends NativeOutputTurnPin { callId: string }
export interface NativeOutputBridge {
  activate(pin: NativeOutputTurnPin, signal: AbortSignal): Promise<void>
  dispatch(command: WorkerNativeOutputCommand, callback: NativeOutputCallback,
    signal: AbortSignal): Promise<WorkerNativeOutputReply>
  close(): Promise<void>
}
export interface OpenCodeNativeOutputQualificationInput {
  configuration: OpenCodeHarnessConfiguration
  providerVersion: string
  directory: string
}
export interface OpenCodeNativeOutputs {
  assertQualified(input: OpenCodeNativeOutputQualificationInput, signal: AbortSignal): Promise<void>
  prepare(input: OpenCodeNativeOutputQualificationInput & {
    session: NativeSessionReference
    clientCorrelationId: string
    connectionId: string
    runtimeGeneration: number
  }, signal: AbortSignal): Promise<NativeOutputBridge>
}
export type NativeOutputQualificationInput = CodexNativeOutputQualificationInput | OpenCodeNativeOutputQualificationInput
export type NativeOutputPreparation = Parameters<CodexNativeOutputs['prepare']>[0]
  | Parameters<OpenCodeNativeOutputs['prepare']>[0]

export interface WorkflowNativeOutputs {
  codex: CodexNativeOutputs
  opencode: OpenCodeNativeOutputs
}
