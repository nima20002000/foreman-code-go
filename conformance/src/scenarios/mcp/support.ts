import assert from 'node:assert/strict'
import { assertJson, assertResponse, type NormalizationRule } from '../../assertions.js'
import { McpClient, McpHttpError, type McpToolResult } from '../../clients/mcp.js'
import type { CoverageClaim, ScenarioContext } from '../../scenario.js'

export interface Contract<T> { parse(value: unknown): T }

export function operatorClients(context: ScenarioContext): { operator: McpClient; readOnly: McpClient } {
  const { operatorToken, readOnlyOperatorToken, baseUrl } = context.target
  assert.ok(operatorToken, 'MCP requires the fresh supported Operator credential CLI.')
  assert.ok(readOnlyOperatorToken, 'MCP denials require a fresh read-only Operator credential.')
  return { operator: new McpClient({ baseUrl, token: operatorToken, signal: context.signal }),
    readOnly: new McpClient({ baseUrl, token: readOnlyOperatorToken, signal: context.signal }) }
}

/** Check the complete small-result envelope and its text mirror before parsing the domain contract. */
export function toolValue<T>(result: McpToolResult, contract: Contract<T>): T {
  assert.deepStrictEqual(Object.keys(result).sort(), ['content', 'structuredContent'])
  assert.ok(result.structuredContent, 'Successful MCP results must include structuredContent.')
  assert.equal(result.content.length, 1)
  const block = result.content[0]!
  assert.deepStrictEqual(Object.keys(block).sort(), ['text', 'type'])
  assert.equal(block.type, 'text')
  assert.equal(typeof block.text, 'string')
  assert.deepStrictEqual(JSON.parse(block.text as string), result.structuredContent)
  const parsed = contract.parse(result.structuredContent)
  assert.deepStrictEqual(parsed, result.structuredContent, 'MCP output must already satisfy the complete shared contract.')
  return parsed
}

export async function callTool<T>(client: McpClient, name: string, input: Record<string, unknown>, contract: Contract<T>): Promise<T> {
  return toolValue(await client.callTool(name, input), contract)
}

export function assertValue(actual: unknown, expected: unknown, rules: readonly NormalizationRule[] = []): void {
  assertJson(actual, expected, rules)
}

export function assertToolFailure(result: McpToolResult, error: Record<string, unknown>): void {
  assert.deepStrictEqual(Object.keys(result).sort(), ['content', 'isError'])
  assert.equal(result.isError, true)
  assert.equal(result.content.length, 1)
  const block = result.content[0]!
  assert.deepStrictEqual(Object.keys(block).sort(), ['text', 'type'])
  assert.equal(block.type, 'text')
  assert.equal(typeof block.text, 'string')
  assert.deepStrictEqual(JSON.parse(block.text as string), { error })
}

export async function assertReadOnlyDenied(client: McpClient, name: string, input: Record<string, unknown>): Promise<void> {
  assertToolFailure(await client.callTool(name, input), {
    code: 'ACCESS_DENIED', message: 'The caller is not authorized for this operation and resource.',
  })
}

/** Initialize with the valid caller, then exercise this actual tools/call with invalid authentication. */
export async function assertInvalidCallerDenied(client: McpClient, name: string, input: Record<string, unknown>): Promise<void> {
  await assert.rejects(() => client.callTool(name, input, { token: 'conformance-invalid-credential' }), error => {
    assert.ok(error instanceof McpHttpError)
    assertResponse({ status: error.status, headers: new Headers(), body: error.body }, { status: 401, body: {
      error: { code: 'AUTH_INVALID', message: 'The supplied credential is invalid.', requestId: '<uuid>' },
    } }, [{ pointer: '/body/error/requestId', kind: 'uuid' }])
    return true
  })
}

export function mcpClaims(...tools: string[]): CoverageClaim[] {
  return tools.flatMap(tool => (['success', 'denied', 'readback'] as const)
    .map(caseName => ({ surface: 'mcp' as const, tool, case: caseName })))
}
