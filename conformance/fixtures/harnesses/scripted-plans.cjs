/* eslint @typescript-eslint/no-require-imports: "off" -- Adjacent native fixture extension. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { inspectNativeInput } = require('./scripted-input.cjs')

function object(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object.`)
  return value
}

function reserveTurn(root, id) {
  const directory = path.join(root, 'script-counters', createHash('sha256').update(id).digest('hex'))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (let turn = 0; turn < 10_000; turn++) {
    try { fs.writeFileSync(path.join(directory, String(turn)), '', { flag: 'wx', mode: 0o600 }); return turn }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  throw new Error('Scripted provider turn count exceeds its fixture bound.')
}

function selectTurnScript(root, prompt) {
  const file = path.join(root, 'turn-scripts.json')
  if (!fs.existsSync(file)) return undefined
  const configuration = object(JSON.parse(fs.readFileSync(file, 'utf8')), 'Native turn script configuration')
  if (!Array.isArray(configuration.scripts) || configuration.scripts.length > 100) {
    throw new Error('Native turn scripts must be a bounded array.')
  }
  const identifiers = new Set()
  let selected
  for (const entry of configuration.scripts) {
    const script = object(entry, 'Native turn script')
    if (typeof script.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(script.id) || identifiers.has(script.id)
      || typeof script.includes !== 'string' || !script.includes) throw new Error('Native turn script identity or prompt selector is invalid.')
    identifiers.add(script.id)
    if (!Array.isArray(script.turns) || !script.turns.length || script.turns.length > 100) {
      throw new Error('Native script outcomes must be a nonempty bounded array.')
    }
    if (script.excludes !== undefined && (!Array.isArray(script.excludes) || script.excludes.length > 100
      || script.excludes.some(value => typeof value !== 'string' || !value))) {
      throw new Error('Native script exclusions must be a bounded array of nonempty text.')
    }
    if (!prompt.includes(script.includes) || script.excludes?.some(value => prompt.includes(value))) continue
    if (selected) throw new Error('Multiple native scripts match this turn.')
    selected = script
  }
  if (!selected) return undefined
  const turn = reserveTurn(root, selected.id)
  return object(selected.turns[Math.min(turn, selected.turns.length - 1)], 'Native scripted turn')
}

function resolveReferences(value, values, depth = 0) {
  if (depth > 100) throw new Error('Native script references exceed the nesting bound.')
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, values, depth + 1))
  if (!value || typeof value !== 'object') return value
  if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
    const tokens = value.$ref.split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    let result = values
    for (const token of tokens) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, token)) {
        throw new Error(`Native script result reference is missing: ${value.$ref}`)
      }
      result = result[token]
    }
    return result
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, values, depth + 1)]))
}

function releaseControlPath(root, filename) {
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(filename)) {
    throw new Error('Native turn release must name one owned control file.')
  }
  return path.join(root, 'control', filename)
}

async function waitForRelease(root, filename, operation, timeoutMs) {
  const file = releaseControlPath(root, filename)
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
  for (;;) {
    if (operation.cancelled) throw new Error('Scripted native turn was interrupted.')
    operation.controller?.signal.throwIfAborted()
    if (Date.now() >= deadline) throw new Error(`Native terminal release timed out after ${timeoutMs} ms: ${filename}`)
    if (fs.existsSync(file)) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!fs.lstatSync(file).isFile()) throw new Error('Native release control is not a regular file.')
}

/** Native provisional text is presented before final history/result publication.
 * The caller still owns the real terminal transition after this bounded wait. */
async function presentThenHoldTerminal(root, plan, operation, present) {
  if (plan?.holdTerminalUntilFile === undefined) return
  const filename = plan.holdTerminalUntilFile
  releaseControlPath(root, filename)
  if (operation.cancelled) throw new Error('Scripted native turn was interrupted.')
  operation.controller?.signal.throwIfAborted()
  present()
  await waitForRelease(root, filename, operation, 25_000)
}

async function runToolCalls(entries, values, operation, call) {
  if (entries !== undefined && (!Array.isArray(entries) || entries.length > 100)) {
    throw new Error('Native scripted tools must be a bounded array.')
  }
  for (const entry of entries || []) {
    if (operation.cancelled) throw new Error('Scripted native turn was interrupted.')
    const tool = object(entry, 'Native scripted tool')
    if (typeof tool.name !== 'string' || !tool.name) throw new Error('Native scripted tool needs its declared name.')
    const result = await call(tool.name, object(resolveReferences(tool.arguments, values), 'Native tool arguments'))
    if (tool.saveAs !== undefined) {
      if (typeof tool.saveAs !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/.test(tool.saveAs)
        || Object.hasOwn(values, tool.saveAs)) throw new Error('Native tool result binding is invalid or duplicated.')
      values[tool.saveAs] = result
    }
  }
}

async function runTurnScript({ root, input, plan, operation, callTool, callMcpTool, requestInteraction, jsonToolValue }) {
  const values = Object.create(null)
  if (plan.codexErrorInfo !== undefined && (plan.codexErrorInfo !== 'internalServerError' || plan.failure === undefined)) {
    throw new Error('Native scripted error information requires an internalServerError failure.')
  }
  if (plan.holdUntilFile !== undefined) await waitForRelease(root, plan.holdUntilFile, operation)
  if (operation.cancelled) throw new Error('Scripted native turn was interrupted.')
  if (plan.interaction !== undefined) {
    const interaction = object(plan.interaction, 'Native scripted interaction')
    if (!['item/tool/requestUserInput', 'item/commandExecution/requestApproval'].includes(interaction.method)) {
      throw new Error('Native scripted interaction method is unsupported.')
    }
    values.interaction = await requestInteraction(interaction.method, object(interaction.params, 'Native interaction parameters'))
    if (interaction.method === 'item/commandExecution/requestApproval'
      && ['decline', 'cancel'].includes(values.interaction.decision)) throw new Error('Native approval was declined.')
  }
  await runToolCalls(plan.tools, values, operation, async (name, args) => jsonToolValue(await callTool(name, args)))
  await runToolCalls(plan.mcpTools, values, operation, callMcpTool)
  if (plan.failure !== undefined) {
    if (typeof plan.failure !== 'string' || !plan.failure) throw new Error('Native scripted failure must have a message.')
    throw Object.assign(new Error(plan.failure), { codexErrorInfo: plan.codexErrorInfo ?? null })
  }
  if (plan.answerFromInput !== undefined) return inspectNativeInput(root, input, plan.answerFromInput)
  if (plan.jsonAnswer !== undefined) return JSON.stringify(resolveReferences(plan.jsonAnswer, values))
  if (plan.answer !== undefined && typeof plan.answer !== 'string') throw new Error('Native scripted answer must be text.')
  return plan.answer ?? 'Conformance scripted native turn completed.'
}

module.exports = { selectTurnScript, runTurnScript, presentThenHoldTerminal }
