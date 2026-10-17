import type { PublicResponse } from './http.js'

const BODY_PREVIEW_BYTES = 4096
const CAUSE_PREVIEW_BYTES = 2048
const REDACTED = '[redacted]'
const TRUNCATED = ' [truncated]'
const CREDENTIAL_KEY = /authorization|cookie|password|passwd|secret|token|credential|apikey|privatekey|prompt|^(?:headers|request|requestbody|requestpayload|input|environment|env)$/i

interface SuccessExpectation {
  method: string
  path: string
  status: number
  contract: string
}

function redactText(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    text = text.replaceAll(secret, REDACTED)
    text = text.replaceAll(JSON.stringify(secret).slice(1, -1), REDACTED)
  }
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s"'\\,;<>]+/gi, `$1 ${REDACTED}`)
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)\s*[:=]\s*)[^\s"'\\,;&<>]+/gi, `$1${REDACTED}`)
}

function boundedText(text: string, maximumBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maximumBytes) return { text, truncated: false }
  const budget = maximumBytes - Buffer.byteLength(TRUNCATED)
  let prefix = Buffer.from(text).subarray(0, budget).toString('utf8')
  // A partial UTF-8 character decodes to a replacement character; keep that within the byte limit too.
  while (Buffer.byteLength(prefix) > budget) prefix = prefix.slice(0, -1)
  return { text: prefix + TRUNCATED, truncated: true }
}

function bodyPreview(body: unknown) {
  const secrets: string[] = []
  function collectSecrets(value: unknown): void {
    if (typeof value === 'string' && value.length) secrets.push(value)
    else if (value && typeof value === 'object') for (const child of Object.values(value)) collectSecrets(child)
  }
  const serialized = JSON.stringify(body, (key, value: unknown) => {
    if (CREDENTIAL_KEY.test(key.replace(/[^a-z0-9]/gi, ''))) {
      collectSecrets(value)
      return REDACTED
    }
    return value
  }) ?? String(body)
  return { ...boundedText(redactText(serialized, secrets), BODY_PREVIEW_BYTES), secrets }
}

function safeCause(cause: unknown, secrets: readonly string[]): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  const safe = new Error(boundedText(redactText(message, secrets), CAUSE_PREVIEW_BYTES).text)
  safe.name = boundedText(redactText(cause instanceof Error ? cause.name : 'Error', secrets), 80).text
  return safe
}

/** Opt-in diagnostics for an expected success; intentional error-response assertions keep using the raw client. */
export function parseSuccessResponse<T>(
  response: PublicResponse,
  schema: { parse(value: unknown): T },
  expected: SuccessExpectation,
): T {
  function failure(cause?: unknown): Error {
    const preview = bodyPreview(response.body)
    const method = boundedText(expected.method, 16).text
    const path = boundedText(expected.path.split(/[?#]/, 1)[0] ?? '/', 512).text
    const contract = boundedText(expected.contract, 128).text
    const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? null
    const error = new Error(
      `${method} ${path} returned HTTP ${response.status}; expected HTTP ${expected.status} and ${contract}.`,
      cause === undefined ? undefined : { cause: safeCause(cause, preview.secrets) },
    )
    error.name = 'PublicHttpResponseError'
    return Object.assign(error, { details: {
      method, path, status: response.status, expectedStatus: expected.status, contract,
      contentType: contentType === null ? null : boundedText(redactText(contentType, preview.secrets), 128).text,
      responseBodyPreview: preview.text, responseBodyTruncated: preview.truncated,
    } })
  }
  // Preserve the actual HTTP error envelope before attempting to read success-only fields.
  if (response.status !== expected.status) throw failure()
  try {
    return schema.parse(response.body)
  } catch (cause) {
    throw failure(cause)
  }
}
