import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type HarnessExecution } from '@graphql/contracts'
import { ExecutableWorkflowV2Schema, makeWave25Fixture } from '@graphql/contracts/wave25'

export const br2001Providers = ['codex', 'opencode'] as const
export type Br2001Provider = typeof br2001Providers[number]

/** Synthetic immutable records only; no model, permission or rollout settings are written. */
export function br2001Fixture(provider: Br2001Provider, suffix: string) {
  const fixture = makeWave25Fixture(suffix)
  if (provider === 'opencode') fixture.configurations = fixture.configurations.map((configuration) =>
    AgentConfigurationVersionSchema.parse({ ...configuration, harness: {
      harness: 'opencode', model: 'synthetic-no-native-call', variant: '', nativeAgent: 'build',
      thinking: false, autoApprove: false,
    } }))
  fixture.version = ExecutableWorkflowV2Schema.parse({
    configurations: fixture.configurations,
    version: { ...fixture.version, definition: { ...fixture.version.definition,
      nodes: fixture.version.definition.nodes.map((node, index) => index === 0 ? {
        ...node, name: 'Tester', choice: { outcomes: [
          { outcome: 'pass', target: { kind: 'branch_end' } },
          { outcome: 'issues', target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } },
        ] },
      } : { ...node, name: 'Fixer' }),
    } },
  }).version
  return fixture
}

export function br2001Text(outcome = 'pass', data: unknown = null): string {
  return JSON.stringify({ routing: { outcome }, data })
}

/** Exact successful carrier shape from the pinned adapters, NOT a native adapter
 * execution: codexAppServer.ts applyTurn (1232-1233); opencodeProtocol.ts
 * assistantResult (201-203). Never fabricate provider events or unwrap text here.
 */
export function br2001Terminal(execution: HarnessExecution, provider: Br2001Provider, text: string) {
  const session = { harness: provider, providerVersion: 'synthetic-br2-001-no-native-call',
    nativeSessionId: `${provider}-${execution.id}` }
  const result = { outcome: 'succeeded' as const, output: { text } }
  return { session, result, execution: HarnessExecutionSchema.parse({
    ...execution, nativeSessionId: session.nativeSessionId, state: 'completed', result,
    finishedAt: new Date().toISOString(),
  }) }
}

export const br2001InvalidTexts = [
  { name: 'ordinary prose', text: 'The review passed.' },
  { name: 'prose around JSON', text: `Result: ${br2001Text()} All done.` },
  { name: 'Markdown', text: `\`\`\`json\n${br2001Text()}\n\`\`\`` },
  { name: 'partial JSON', text: '{"routing":{"outcome":"pass"},"data":' },
  { name: 'extra envelope field', text: '{"routing":{"outcome":"pass"},"data":null,"extra":true}' },
  { name: 'extra routing field', text: '{"routing":{"outcome":"pass","edgeId":"other"},"data":null}' },
  { name: 'undeclared outcome', text: br2001Text('undeclared') },
  { name: 'missing data', text: '{"routing":{"outcome":"pass"}}' },
  { name: 'second JSON value', text: `${br2001Text()}${br2001Text('issues')}` },
  { name: 'double encoded JSON', text: JSON.stringify(br2001Text()) },
  { name: 'empty text', text: '' },
  { name: 'null instead of envelope', text: 'null' },
  { name: 'oversized text', text: br2001Text('pass', 'x'.repeat(64 * 1024)) },
  { name: 'oversized JSON whitespace', text: ' '.repeat(64 * 1024) + br2001Text() },
  { name: 'oversized UTF-8 below character limit', text: br2001Text('pass', '😀'.repeat(17000)) },
] as const
