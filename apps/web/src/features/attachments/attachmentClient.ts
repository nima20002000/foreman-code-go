import { z } from 'zod'
import { ApiErrorResponseSchema } from '@graphql/contracts'
import {
  FileWithRevisionSchema, TemporaryFileScopeSchema, fileStateAt,
  type FileMediaType, type FileWithRevision, type TemporaryFileScope,
} from '@graphql/contracts/files'
import { apiClient, ApiError } from '../../shared/api/client'
import { notifyAuthenticationRequired } from '../../shared/api/authEvents'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal, SessionChangedError } from '../../shared/api/sessionBoundary'
import { attachmentDraftKey, inspectAttachment } from './attachmentFiles'

export interface AttachmentProgress { phase: 'uploading' | 'finalizing'; percent: number | null }
export interface AttachmentUploadInput {
  requestId: string
  scope: TemporaryFileScope
  file: File
  filename: string
  mediaType: FileMediaType
  signal: AbortSignal
  onProgress: (progress: AttachmentProgress) => void
}
export interface AttachmentCancelInput { requestId: string; scope: TemporaryFileScope }
export interface AttachmentClient {
  /** Must resolve only after durable finalization, not merely after the bytes arrive. */
  upload(input: AttachmentUploadInput): Promise<FileWithRevision>
  /** Cancel an unsent allocation by its original request identity; never delete a sent file. */
  cancel(input: AttachmentCancelInput): Promise<void>
}

function invalidResponse(): ApiError {
  return new ApiError({ code: 'INVALID_RESPONSE', message: 'The upload response does not match this attachment.' })
}

/** Apply even to injected clients: never admit a foreign scope or silently follow a revision head. */
export function parseAttachmentUpload(input: AttachmentUploadInput, value: unknown, ready = true): FileWithRevision {
  const parsed = FileWithRevisionSchema.safeParse(value)
  if (!parsed.success) throw invalidResponse()
  const { file, revision } = parsed.data
  if (file.scope.kind !== 'temporary' || attachmentDraftKey(file.scope) !== attachmentDraftKey(input.scope)
    || file.currentRevisionId !== revision.revisionId || revision.filename !== input.filename
    || revision.mediaType !== input.mediaType || revision.byteSize !== input.file.size || revision.origin !== 'upload') throw invalidResponse()
  const state = fileStateAt(file, new Date().toISOString())
  if (ready ? state !== 'ready' : state !== 'pending' && state !== 'ready') throw invalidResponse()
  return parsed.data
}

export interface AttachmentHttpPaths {
  upload: string
  finalize: string
  cancel: string
}

function sameOriginApiPath(path: string): string {
  const origin = globalThis.location?.origin ?? 'http://localhost'
  const url = new URL(path, origin)
  if (!path.startsWith('/api/') || !url.pathname.startsWith('/api/') || url.origin !== origin || url.username || url.password || url.hash) {
    throw new Error('Attachment endpoints must be same-origin /api/ paths.')
  }
  return `${url.pathname}${url.search}`
}

/**
 * Opt-in transport adapter, NOT a claim that these routes exist at the base SHA.
 * See README.md for the required FIL-03 wire agreement. No guessed route defaults.
 * JSON calls use apiClient. Its JSON-only body handling cannot carry a File, so
 * this one binary boundary mirrors its cookie, auth-event and session fences.
 */
export function createAttachmentHttpClient(paths: AttachmentHttpPaths): AttachmentClient {
  const uploadPath = sameOriginApiPath(paths.upload)
  const finalizePath = sameOriginApiPath(paths.finalize)
  const cancelPath = sameOriginApiPath(paths.cancel)
  return {
    async upload(input) {
      const generation = sessionGeneration()
      if (sessionIsSwitching()) throw new SessionChangedError()
      const signal = AbortSignal.any([input.signal, sessionSignal()])
      signal.throwIfAborted()
      const inspected = inspectAttachment(input.file)
      if (!inspected.ok || inspected.filename !== input.filename || inspected.mediaType !== input.mediaType) {
        throw new ApiError({ code: 'INVALID_REQUEST', message: 'The selected file is not an allowed attachment.' })
      }
      const scope = TemporaryFileScopeSchema.parse(input.scope)
      const body = new FormData()
      body.append('metadata', JSON.stringify({ requestId: input.requestId, scope, filename: input.filename, mediaType: input.mediaType, byteSize: input.file.size }))
      // Blob slicing supplies the canonical Content-Type without reading/base64-expanding the bytes.
      body.append('file', input.file.slice(0, input.file.size, input.mediaType), input.filename)
      const value = await uploadMultipart(uploadPath, body, signal, input.onProgress)
      assertSession(generation)
      signal.throwIfAborted()
      const staged = parseAttachmentUpload(input, value, false)
      if (staged.file.state === 'ready') return staged
      input.onProgress({ phase: 'finalizing', percent: 100 })
      const finalized = await apiClient.request(finalizePath, FileWithRevisionSchema, {
        method: 'POST', signal,
        body: { requestId: input.requestId, scope, fileId: staged.revision.fileId, revisionId: staged.revision.revisionId },
      })
      assertSession(generation)
      signal.throwIfAborted()
      const result = parseAttachmentUpload(input, finalized)
      if (result.revision.fileId !== staged.revision.fileId || result.revision.revisionId !== staged.revision.revisionId) throw invalidResponse()
      return result
    },
    async cancel(input) {
      await apiClient.request(cancelPath, z.undefined(), {
        method: 'POST', body: { requestId: input.requestId, scope: TemporaryFileScopeSchema.parse(input.scope) },
      })
    },
  }
}

function uploadMultipart(path: string, body: FormData, signal: AbortSignal,
  onProgress: AttachmentUploadInput['onProgress']): Promise<unknown> {
  signal.throwIfAborted()
  const generation = sessionGeneration()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null
      xhr.upload.onprogress = null
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const abort = () => {
      finish(new DOMException('Attachment upload canceled.', 'AbortError'))
      xhr.abort()
    }
    xhr.open('POST', new URL(path, globalThis.location?.origin ?? 'http://localhost').toString())
    // XHR sends same-origin cookies without enabling cross-origin credentials.
    xhr.withCredentials = false
    xhr.timeout = 120_000
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (event) => {
      if (!settled && !signal.aborted) onProgress({
        phase: 'uploading',
        percent: event.lengthComputable && event.total > 0 ? Math.min(100, Math.max(0, Math.floor(event.loaded / event.total * 100))) : null,
      })
    }
    xhr.onerror = () => finish(new ApiError({ code: 'NETWORK_ERROR', message: 'The attachment could not be uploaded.' }))
    xhr.ontimeout = () => finish(new ApiError({ code: 'UPLOAD_TIMEOUT', message: 'The attachment upload timed out. Retry to check the same upload.' }))
    xhr.onabort = () => finish(new DOMException('Attachment upload canceled.', 'AbortError'))
    xhr.onload = () => {
      try {
        assertSession(generation)
        signal.throwIfAborted()
        let payload: unknown
        try { payload = JSON.parse(xhr.responseText) } catch { payload = undefined }
        if (xhr.status < 200 || xhr.status >= 300) {
          if (xhr.status === 401) notifyAuthenticationRequired()
          const parsed = ApiErrorResponseSchema.safeParse(payload)
          throw new ApiError(parsed.success ? parsed.data.error : { code: 'HTTP_ERROR', message: 'The attachment could not be uploaded.' }, xhr.status)
        }
        finish(undefined, payload)
      } catch (error) { finish(error) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      onProgress({ phase: 'uploading', percent: null })
      xhr.send(body)
    } catch (error) { finish(error) }
  })
}
