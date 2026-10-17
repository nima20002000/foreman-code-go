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

function sensitiveKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key.replace(/[^a-z0-9]/gi, ''))
}

function credentialEnd(text: string, start: number, cookie: boolean): number {
  const scheme = /^(?:Bearer|Basic)\s+/i.exec(text.slice(start))
  if (scheme) start += scheme[0].length

  let openingSlashes = 0
  while (text[start + openingSlashes] === '\\') openingSlashes++
  const quote = text[start + openingSlashes]
  if (quote === '"' || quote === "'") {
    let slashes = 0
    for (let index = start + openingSlashes + 1; index < text.length; index++) {
      const character = text[index]
      if (character === '\\') {
        slashes++
        continue
      }
      // JSON-encoded quotes have 1, 3, ... preceding slashes. An escaped
      // interior quote has another encoding level and must not end the value.
      if (character === quote && slashes >= openingSlashes
        && (slashes - openingSlashes) % (2 * (openingSlashes + 1)) === 0) return index + 1
      slashes = 0
    }
    // An unterminated quoted credential has no trustworthy end delimiter.
    return text.length
  }

  // A Cookie/Set-Cookie header can contain several credentials separated by
  // semicolons. Preserve later lines, not a later cookie from this header.
  if (cookie) {
    const newline = /[\r\n]/.exec(text.slice(start))
    return newline === null ? text.length : start + newline.index
  }

  let end = start
  while (end < text.length) {
    const character = text[end]!
    if (character === '\\' && end + 1 < text.length) end += 2
    else if (/[\s,;&<>{}\[\]()]/.test(character)) break
    else end++
  }
  return end
}

function redactText(text: string, secrets: readonly string[]): string {
  const variants = [...new Set(secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))]
    .filter(secret => secret.length > 0).sort((left, right) => right.length - left.length)
  const known = variants.length === 0 ? null
    : new RegExp(variants.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  // One replacement pass, longest match first: neither secret prefixes nor
  // duplicates may expose a suffix or rescan an inserted redaction marker.
  const redactKnown = (part: string): string => known === null ? part : part.replace(known, REDACTED)
  const labels = /\b(?:([a-z][a-z0-9_-]*)(?:\\*["'])?\s*[:=]\s*|(?:Bearer|Basic)\s+)/gi
  let result = ''
  let cursor = 0
  for (let match = labels.exec(text); match; match = labels.exec(text)) {
    if (match[1] !== undefined && !sensitiveKey(match[1])) continue
    const start = match.index + match[0].length
    const end = credentialEnd(text, start, /cookie/i.test(match[1] ?? ''))
    if (end === start) continue
    result += redactKnown(text.slice(cursor, start)) + REDACTED
    cursor = end
    labels.lastIndex = end
  }
  return result + redactKnown(text.slice(cursor))
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
  function collectSecrets(value: unknown, sensitive = false): void {
    if (typeof value === 'string' && sensitive && value.length) secrets.push(value)
    else if (Array.isArray(value)) for (const child of value) collectSecrets(child, sensitive)
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) collectSecrets(child, sensitive || sensitiveKey(key))
    }
  }

  collectSecrets(body)
  function sanitize(value: unknown): unknown {
    if (typeof value === 'string') return redactText(value, secrets)
    if (Array.isArray(value)) return value.map(sanitize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      redactText(key, secrets), sensitiveKey(key) ? REDACTED : sanitize(child),
    ]))
    return value
  }
  // Sanitize decoded keys and leaves before JSON adds quotes and backslashes.
  // Keep the actual response untouched for the strict contract parser.
  const serialized = JSON.stringify(sanitize(body)) ?? redactText(String(body), secrets)
  return { ...boundedText(serialized, BODY_PREVIEW_BYTES), secrets }
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
