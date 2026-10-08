import { useEffect } from 'react'
import { create } from 'zustand'
import { BuildComputerBatchUpdateSchema, type BuildComputerBatchUpdate } from '@foreman-code/contracts/build-computers'
import { ApiError } from './client'
import { identityEpoch, identityEpochKey, protectedKey } from './protectedChatStorage'

interface Entry { pending?: BuildComputerBatchUpdate | undefined; error?: string | undefined }
const useCommands = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }))
export const buildComputerCommandKey = (mainId: string) => protectedKey('outbox', `build-computers:${mainId}`)

function update(key: string, entry: Entry) {
  useCommands.setState(state => ({ entries: { ...state.entries, [key]: entry } }))
}
function stored(key: string) {
  const text = window.sessionStorage.getItem(key)
  return text === null ? undefined : BuildComputerBatchUpdateSchema.parse(JSON.parse(text))
}
function load(key: string) {
  try {
    update(key, { pending: stored(key) })
  } catch {
    update(key, { error: 'Save recovery is unavailable. Enable browser storage and retry.' })
  }
}
/** Persist only the outstanding command; server preferences remain in Query. */
export function retainBuildComputerCommand(key: string, input: BuildComputerBatchUpdate) {
  try {
    if (window.localStorage.getItem(identityEpochKey) !== identityEpoch()) throw new Error('Session storage binding is unavailable.')
    const command = BuildComputerBatchUpdateSchema.parse(input)
    const pending = stored(key)
    if (pending && JSON.stringify(pending) !== JSON.stringify(command)) {
      throw new ApiError({ code: 'BUILD_SAVE_UNRESOLVED', message: 'Retry the original save before making more changes.' })
    }
    if (!pending) window.sessionStorage.setItem(key, JSON.stringify(command))
    update(key, { pending: pending ?? command })
  } catch (error) {
    if (ApiError.is(error)) throw error
    update(key, { error: 'Save recovery is unavailable. Enable browser storage and retry.' })
    throw new ApiError({ code: 'INVALID_REQUEST', message: 'Save recovery is unavailable. No changes were sent.' })
  }
}
export function settleBuildComputerCommand(key: string, commandId: string) {
  const pending = stored(key)
  if (pending && pending.commandId !== commandId) throw new Error('Another build save is pending.')
  window.sessionStorage.removeItem(key)
  update(key, {})
}
export function useBuildComputerCommand(mainId: string) {
  const key = buildComputerCommandKey(mainId)
  const entry = useCommands(state => state.entries[key])
  // Re-read storage on mount so navigation and reload use the same recovery path.
  useEffect(() => { load(key) }, [key])
  return { key, ready: Boolean(entry), pending: entry?.pending, error: entry?.error, reload: () => load(key) }
}
/** Clear document memory without removing recovery commands, as a hard reload does. */
export function clearBuildComputerCommandMemory() { useCommands.setState({ entries: {} }) }
