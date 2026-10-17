import assert from 'node:assert/strict'
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { ScenarioContext } from '../../scenario.js'

/** Fixture protocol only. Domain requests in arguments still use their shared contracts. */
export interface CodexToolScript {
  name: string
  arguments: Record<string, unknown>
  saveAs?: string
}

export interface CodexTurnScript {
  answer?: string
  jsonAnswer?: unknown
  answerFromInput?: 'text' | 'images'
  tools?: CodexToolScript[]
  mcpTools?: CodexToolScript[]
  failure?: string
  codexErrorInfo?: 'internalServerError'
  holdUntilFile?: string
  holdTerminalUntilFile?: string
  interaction?: {
    method: 'item/tool/requestUserInput' | 'item/commandExecution/requestApproval'
    params: Record<string, unknown>
  }
}

export interface CodexScript {
  id: string
  includes: string
  excludes?: string[]
  turns: CodexTurnScript[]
}

async function ownedCodexDirectory(ctx: ScenarioContext) {
  assert.ok(ctx.target.codexDirectory, 'The scenario requires the installed scripted Codex fixture')
  const root = await realpath(ctx.target.directory)
  const directory = await realpath(ctx.target.codexDirectory)
  const suffix = relative(root, directory)
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Codex fixture state must stay in this target')
  return directory
}

export async function installCodexScripts(ctx: ScenarioContext, scripts: readonly CodexScript[]) {
  const identifiers = new Set<string>()
  for (const script of scripts) {
    assert.ok(script.id && script.includes && script.turns.length, 'Every script requires a match and at least one turn')
    assert.ok(!identifiers.has(script.id), 'Script identifiers must be unique')
    identifiers.add(script.id)
  }
  const directory = await ownedCodexDirectory(ctx)
  const text = JSON.stringify({ scripts })
  assert.ok(Buffer.byteLength(text) <= 1_048_576, 'Conformance turn scripts must remain bounded')
  const pending = join(directory, 'turn-scripts.pending.json')
  await writeFile(pending, text, { mode: 0o600 })
  await rename(pending, join(directory, 'turn-scripts.json'))
}

export async function releaseCodexTurn(ctx: ScenarioContext, filename: string) {
  assert.match(filename, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/)
  const directory = join(await ownedCodexDirectory(ctx), 'control')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, filename), '', { mode: 0o600, flag: 'wx' })
}
