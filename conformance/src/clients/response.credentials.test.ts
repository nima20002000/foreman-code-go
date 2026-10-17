import { randomInt } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeFailure } from '../reporting/report.js'
import type { ScenarioContext } from '../scenario.js'
import { createWorkspace } from '../scenarios/smoke/support.js'
import { PublicHttpClient } from './http.js'
import { parseSuccessResponse } from './response.js'

afterEach(() => { vi.unstubAllGlobals() })

function context(): ScenarioContext {
  const origin = `http://127.0.0.1:${randomInt(20_000, 60_000)}`
  return {
    http: new PublicHttpClient({ baseUrl: origin, browserOrigin: origin, token: 'synthetic-request-only' }),
    scenarioDirectory: '/unused-credential-preview-fixture', signal: new AbortController().signal,
    get target(): never { throw new Error('These public helper tests must not access a target runtime.') },
  }
}

async function failureOf(action: () => unknown) {
  try {
    await action()
  } catch (error) {
    return describeFailure(error)
  }
  throw new Error('The public helper accepted an unsuccessful response.')
}

function previewOf(failure: ReturnType<typeof describeFailure>): string {
  expect(failure.name).toBe('PublicHttpResponseError')
  expect(failure.details).toMatchObject({ method: 'POST', path: '/api/management/workspaces',
    expectedStatus: 201, contract: 'ManagedWorkspaceCommandResult', responseBodyPreview: expect.any(String) })
  const preview = (failure.details as { responseBodyPreview: string }).responseBodyPreview
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(4096)
  return preview
}

function assertAbsent(failure: ReturnType<typeof describeFailure>, fragments: readonly string[]): void {
  const output = JSON.stringify(failure)
  for (const fragment of [...fragments, 'synthetic-request-only']) expect(output).not.toContain(fragment)
}

describe('public HTTP credential diagnostics', () => {
  it('redacts quoted and backslash-start credentials in a text Workspace rejection', async () => {
    const text = String.raw`Upstream unavailable; password="synthetic-double secret-tail"; passwd='synthetic-single secret-tail'; token=\synthetic-slash-tail; access_token=synthetic-plain-tail; Bearer "synthetic-bearer tail"; Basic 'synthetic-basic tail'; reason="temporary upstream"; path=C:\fixture\project; requestId=quoted-request-17`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status: 503, headers: { 'content-type': 'text/plain' } })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    const preview = previewOf(failure)
    expect(failure.details).toMatchObject({ status: 503, contentType: 'text/plain', responseBodyTruncated: false })
    expect(JSON.parse(preview)).toBe(String.raw`Upstream unavailable; password=[redacted]; passwd=[redacted]; token=[redacted]; access_token=[redacted]; Bearer [redacted]; Basic [redacted]; reason="temporary upstream"; path=C:\fixture\project; requestId=quoted-request-17`)
    assertAbsent(failure, ['synthetic-double', 'secret-tail', 'synthetic-single', 'synthetic-slash-tail',
      'synthetic-plain-tail', 'synthetic-bearer', 'synthetic-basic'])
  })

  it('redacts quoted keys and escaped credential tails inside JSON-looking text', async () => {
    const body = { error: { code: 'SYNTHETIC_ESCAPED_TEXT', requestId: 'escaped-request-17',
      message: String.raw`{"password":"synthetic-json\"unique-json-tail","reason":"normal quoted prose"}; {\"private_key\":\"synthetic-encoded\\\"unique-encoded-tail\",\"path\":\"C:\\fixture\\project\"}` } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 422 })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    const preview = previewOf(failure)
    expect(failure.details).toMatchObject({ status: 422, contentType: 'application/json', responseBodyTruncated: false })
    expect(JSON.parse(preview)).toEqual({ error: { code: body.error.code, requestId: body.error.requestId,
      message: String.raw`{"password":[redacted],"reason":"normal quoted prose"}; {\"private_key\":[redacted],\"path\":\"C:\\fixture\\project\"}` } })
    assertAbsent(failure, ['synthetic-json', 'unique-json-tail', 'synthetic-encoded', 'unique-encoded-tail'])
  })

  it('redacts credentials embedded in public JSON property names', async () => {
    const body = { error: { code: 'SYNTHETIC_PROPERTY_NAME', requestId: 'property-request-17',
      message: 'The isolated location is unavailable.', details: {
        'password="synthetic-property-tail"': 'synthetic-hidden-field-value',
        location: '/owned/fixture/project', reason: 'Keep this useful reason.',
      } } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 409 })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    expect(JSON.parse(previewOf(failure))).toEqual({ error: { code: body.error.code, requestId: body.error.requestId,
      message: body.error.message, details: { 'password=[redacted]': '[redacted]',
        location: body.error.details.location, reason: body.error.details.reason } } })
    assertAbsent(failure, ['synthetic-property-tail', 'synthetic-hidden-field-value'])
  })

  it('redacts overlapping literal secrets without exposing the longer suffix', async () => {
    const body = { error: { code: 'SYNTHETIC_OVERLAP', requestId: 'overlap-request-17',
      message: 'synthetic.[prefix]-unique-long-tail and synthetic.[prefix]; near match syntheticXprefix remains.',
      details: { password: 'synthetic.[prefix]', token: 'synthetic.[prefix]-unique-long-tail',
        headers: { authorization: 'synthetic.[prefix]' }, reason: 'Keep the compatibility reason.' } } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 422 })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    expect(JSON.parse(previewOf(failure))).toEqual({ error: { code: body.error.code, requestId: body.error.requestId,
      message: '[redacted] and [redacted]; near match syntheticXprefix remains.',
      details: { password: '[redacted]', token: '[redacted]', headers: '[redacted]', reason: body.error.details.reason } } })
    assertAbsent(failure, ['synthetic.[prefix]', 'unique-long-tail'])
  })

  it('does not rescan redaction markers for duplicate short secret values', async () => {
    const body = { error: { code: 'SYNTHETIC_MARKER', requestId: 'marker-request-17',
      message: 'red then red; useful trace remains.',
      details: { password: 'red', token: 'red', headers: { authorization: 'red' } } } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 500 })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    expect(JSON.parse(previewOf(failure))).toEqual({ error: { code: body.error.code, requestId: body.error.requestId,
      message: '[redacted] then [redacted]; useful trace remains.',
      details: { password: '[redacted]', token: '[redacted]', headers: '[redacted]' } } })
    expect(JSON.stringify(failure)).not.toContain('[[redacted]')
  })

  it('keeps a credential-shaped sensitive value fully redacted', async () => {
    const secret = 'synthetic-private-prefix token=synthetic-private-tail'
    const body = { error: { code: 'SYNTHETIC_WHOLE_VALUE', requestId: 'whole-value-request-17',
      message: `Rejected ${secret}; useful public reason remains.`, details: { credential: secret } } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 422 })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    expect(JSON.parse(previewOf(failure))).toEqual({ error: { code: body.error.code, requestId: body.error.requestId,
      message: 'Rejected [redacted]; useful public reason remains.', details: { credential: '[redacted]' } } })
    assertAbsent(failure, ['synthetic-private-prefix', 'synthetic-private-tail'])
  })

  it('redacts escaped schema-cause credentials while retaining bounded useful context', async () => {
    const body = { error: { code: 'SYNTHETIC_SUCCESS_ENVELOPE_REJECTION', requestId: 'cause-request-17',
      message: 'The public response is still unsuccessful.' } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 201 })))
    const response = await context().http.request('POST', '/api/management/workspaces')
    const cause = new Error(JSON.stringify({ code: 'SYNTHETIC_SCHEMA_CAUSE',
      message: String.raw`password="synthetic-cause\"unique-cause-tail"; reason="retain schema reason"; requestId=cause-request-17`,
      trace: '界'.repeat(5000) }))
    cause.name = 'SyntheticSchemaError'
    const failure = await failureOf(() => parseSuccessResponse(response, { parse(value: unknown): never {
      expect(value).toEqual(body)
      throw cause
    } }, { method: 'POST', path: '/api/management/workspaces', status: 201, contract: 'ManagedWorkspaceCommandResult' }))
    expect(JSON.parse(previewOf(failure))).toEqual(body)
    expect(failure.cause?.name).toBe('SyntheticSchemaError')
    expect(failure.cause?.message).toContain('SYNTHETIC_SCHEMA_CAUSE')
    expect(failure.cause?.message).toContain('retain schema reason')
    expect(failure.cause?.message).toContain('cause-request-17')
    expect(failure.cause?.message).toContain('[truncated]')
    expect(Buffer.byteLength(failure.cause!.message)).toBeLessThanOrEqual(2048)
    assertAbsent(failure, ['synthetic-cause', 'unique-cause-tail'])
    expect(response.body).toEqual(body)
    expect(cause.message).toContain('unique-cause-tail')
  })

  it('bounds multibyte previews after removing long quoted credentials', async () => {
    const text = `SYNTHETIC_LARGE_TEXT; password="synthetic-large-head${'界'.repeat(5000)}synthetic-large-tail"; reason="retain later context"; requestId=large-request-17; trace=${'界'.repeat(5000)}`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status: 503, headers: { 'content-type': 'text/plain' } })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    const preview = previewOf(failure)
    expect(failure.details).toMatchObject({ status: 503, responseBodyTruncated: true })
    expect(preview).toContain('SYNTHETIC_LARGE_TEXT')
    expect(preview).toContain('retain later context')
    expect(preview).toContain('large-request-17')
    expect(preview).toContain('[redacted]')
    expect(preview).toContain('[truncated]')
    assertAbsent(failure, ['synthetic-large-head', 'synthetic-large-tail'])
  })

  it('redacts every cookie in a text header while retaining the next diagnostic line', async () => {
    const text = 'SYNTHETIC_COOKIE_HEADER\nCookie: sid=synthetic-cookie-one; other=synthetic-cookie-two\nreason="retain next line"; requestId=cookie-request-17'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status: 403, headers: { 'content-type': 'text/plain' } })))
    const failure = await failureOf(() => createWorkspace(context(), 'Credential diagnostics'))
    const preview = previewOf(failure)
    expect(failure.details).toMatchObject({ status: 403, responseBodyTruncated: false })
    expect(JSON.parse(preview)).toBe('SYNTHETIC_COOKIE_HEADER\nCookie: [redacted]\nreason="retain next line"; requestId=cookie-request-17')
    assertAbsent(failure, ['synthetic-cookie-one', 'synthetic-cookie-two'])
  })
})
