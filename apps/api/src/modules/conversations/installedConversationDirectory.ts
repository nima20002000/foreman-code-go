import { isAbsolute, relative, basename } from 'node:path'
import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkerConversationBinding, WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import { openRootDirectory } from '../sources/rootAttestation.js'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../sources/privateFilesystem.js'
import { DomainError } from '../errors.js'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { requiredLocationAccess } from '../workspaces/location.js'

async function inspectApprovedDirectory(approved: ApprovedRootAllowlist, path: string,
  accessMode: 'read-only' | 'read-write') {
  const base = approved.bases.find(value => {
    const child = relative(value.canonicalPath, path)
    return value.accessModes.includes(accessMode) && !isAbsolute(child) && child !== '..' && !child.startsWith('../')
  })
  if (!base) throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
    'The chat folder or a writable folder is outside the worker’s approved roots.', 409)
  const directory = await openRootDirectory(base.canonicalPath, relative(base.canonicalPath, path), base.filesystem)
  try {
    if (await realpath(anchored(directory)) !== path) {
      throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The selected chat folder changed.', 409)
    }
    return await identity(directory)
  } finally { await directory.close() }
}

/** Pins the selected project to the worker's existing human-approved root configuration. */
export async function installedConversationDirectory(input: {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  approvedRoots(): Promise<ApprovedRootAllowlist>
}) {
  input = { ...input, binding: structuredClone(input.binding), configuration: structuredClone(input.configuration) }
  const approved = structuredClone(await input.approvedRoots())
  const target = input.binding.profile.target
  if (!isDeepStrictEqual(approved.hostRef, target.hostRef)
    || approved.applicationInstallationId !== target.applicationInstallationId) {
    throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE', 'This worker has no approved roots for the selected profile.', 409)
  }
  const harness = input.configuration.harness
  const writablePaths = harness.harness === 'codex' ? harness.advanced?.additionalWritableDirectories ?? [] : []
  const writable = await Promise.all(writablePaths.map(path => inspectApprovedDirectory(approved, path, 'read-write')))
  const assertWritable = async () => {
    for (const [index, path] of writablePaths.entries()) {
      if (!isDeepStrictEqual(await inspectApprovedDirectory(approved, path, 'read-write'), writable[index])) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'A configured writable folder was replaced.', 409)
      }
    }
  }
  if (input.binding.owner.kind === 'operator') {
    const expected = workerOperatorDirectory(approved.managedRuntimeRoot, input.binding.owner)
    if (input.binding.workingDirectory !== expected) throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
      'Operator chat must use its private folder on the selected worker.', 409)
    const inspect = async (operation: 'create' | 'read') => {
      const root = await openPrivateRoot(approved.managedRuntimeRoot)
      try {
        if (!isDeepStrictEqual(await identity(root), approved.runtimeFilesystem)) {
          throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The worker runtime root was replaced.', 409)
        }
        const chats = await openChildDirectory(root, 'operator-chats', operation === 'create')
        try {
          const directory = await openChildDirectory(chats, basename(expected), operation === 'create')
          try {
            if (await realpath(anchored(directory)) !== expected) {
              throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The private Operator chat folder changed.', 409)
            }
            return await identity(directory)
          } finally { await directory.close() }
        } finally { await chats.close() }
      } finally { await root.close() }
    }
    const original = await inspect('create')
    return { async assertCurrent(signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!isDeepStrictEqual(await input.approvedRoots(), approved) || !isDeepStrictEqual(await inspect('read'), original)) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The worker root or Operator chat folder changed.', 409)
      }
      await assertWritable()
      signal?.throwIfAborted()
    } }
  }
  if (!('agentId' in input.configuration)) throw new DomainError('WORKER_CONVERSATION_ROOT_UNAVAILABLE',
    'The selected node chat requires its Agent configuration.', 409)
  const accessMode = requiredLocationAccess([input.configuration])
  const inspect = () => inspectApprovedDirectory(approved, input.binding.workingDirectory, accessMode)
  const original = await inspect()
  return {
    async assertCurrent(signal?: AbortSignal) {
      signal?.throwIfAborted()
      const current = await input.approvedRoots()
      if (!isDeepStrictEqual(current, approved)) throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED',
        'The worker’s approved chat roots changed.', 409)
      const observed = await inspect()
      await assertWritable()
      signal?.throwIfAborted()
      if (!isDeepStrictEqual(observed, original)) {
        throw new DomainError('WORKER_CONVERSATION_ROOT_CHANGED', 'The selected chat directory was replaced.', 409)
      }
    },
  }
}
