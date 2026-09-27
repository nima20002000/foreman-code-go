// Source-level checks only. JSX objects and hook stubs are not React, JSDOM,
// browser geometry, or native-provider evidence. Run the accompanying Vitest suite too.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript')
const source = resolve(process.env.G6_SOURCE_ROOT || dirname(fileURLToPath(import.meta.url)))
const Fragment = Symbol('fragment')
const h = (type, props, ...children) => ({ type, key: props?.key ?? null,
  props: { ...props, children: children.length === 1 ? children[0] : children } })

function load(path, dependencies = {}) {
  const filename = resolve(source, path)
  const result = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
  })
  assert.deepEqual(result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error), [])
  const module = { exports: {} }
  const dependency = (id) => {
    if (id.endsWith('.css')) return {}
    assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import ${id} in ${path}`)
    return dependencies[id]
  }
  new Function('require', 'module', 'exports', 'h', 'Fragment', result.outputText)(dependency, module, module.exports, h, Fragment)
  return module.exports
}
const ui = { EmptyState: 'EmptyState', MessageBubble: 'MessageBubble', Badge: 'Badge', Button: 'Button' }
const { placeChatActivities } = load('activityPlacement.ts')
const { ConversationHistory } = load('../ConversationHistory.tsx', { '../../shared/ui/nocturne': ui })
const Activity = Symbol('OperatorActivityList'), Viewport = Symbol('ConversationViewport')
const { AgentChatTranscript } = load('AgentChatTranscript.tsx', {
  '../../../shared/ui/nocturne': ui,
  '../../operator-chat/OperatorActivityList': { OperatorActivityList: Activity },
  '../../operator-chat/OperatorApprovalCard': { OperatorApprovalCard: Symbol('approval') },
  '../ConversationHistory': { ConversationHistory },
  '../ConversationViewport': { ConversationViewport: Viewport },
  // These unchanged dependencies are outside the behavior under test; no overlapping
  // history windows, commands, approvals or delivery receipts are used in this harness.
  './model': { mergeChatMessages: (...windows) => windows.flat(), approvalReplyAvailable: () => false,
    deliveryLabels: {}, intentLabels: {} },
  './activityPlacement': { placeChatActivities },
  './commandRecords': { confirmedCommandReceipt: () => undefined },
  './useAgentChat': { commandMayHaveBeenAccepted: () => false },
})
const user = (id, requestId) => ({ id, requestId, conversationId: 'c', role: 'user', content: id })
const reply = (id, requestId, afterActivitySequence) => ({ id, requestId, conversationId: 'c', role: 'assistant',
  content: id, ...(afterActivitySequence === undefined ? {} : { afterActivitySequence }), nativeMessageComplete: true })
const activity = (id, requestId, sequence) => ({ id, requestId, sequence, revision: 1, kind: 'tool', title: id, status: 'running' })
function find(node, type) {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean)
  return node.type === type ? node : find(node.props?.children, type)
}
function transcript(messages, activities, activeRequestId, conversationId = 'c') {
  const viewport = AgentChatTranscript({ state: { conversation: { id: conversationId }, messages, activities, turns: [],
    activeTurn: activeRequestId ? { requestId: activeRequestId } : null }, name: 'Coder', commands: [], history: {},
    onCancel() {}, onRespond() {}, onSendAgain() {} })
  assert.equal(viewport.type, Viewport)
  const children = viewport.props.children(() => {})
  const history = find(children, ConversationHistory)
  assert.ok(history)
  const rendered = ConversationHistory(history.props)
  assert.equal(rendered.type, 'ol')
  const rows = rendered.props.children
  assert.ok(Array.isArray(rows))
  assert.ok(rows.every((row) => row?.type === 'li'), 'all rows must be direct siblings in one flat array')
  return rows
}
function ids(rows) {
  return rows.map((row) => {
    const tool = find(row, Activity)
    return tool ? `tool:${tool.props.entries[0].requestId}/${tool.props.entries[0].id}` : row.key
  })
}
function toolRows(rows) { return rows.filter((row) => find(row, Activity)) }

test('B2-PF-03: first reply retains the same activity key, element type, and common parent', () => {
  const u = user('u', 'r'), a = activity('a', 'r', '10')
  const oldRows = transcript([u], [a], 'r')
  const nextRows = transcript([u, reply('answer', 'r', '10')], [{ ...a, status: 'completed', revision: 2 }])
  assert.deepEqual(ids(oldRows), ['message:u', 'tool:r/a'])
  assert.deepEqual(ids(nextRows), ['message:u', 'tool:r/a', 'message:answer'])
  assert.equal(toolRows(oldRows)[0].key, toolRows(nextRows)[0].key)
  assert.equal(toolRows(oldRows)[0].type, toolRows(nextRows)[0].type)
  assert.deepEqual(ids(transcript([u, reply('answer', 'r', '10')], [a])), ids(nextRows))
})

test('B2-PF-03: independently keyed tools survive a boundary splitting an existing list', () => {
  const u = user('u', 'r'), tools = [activity('first', 'r', '1'), activity('last', 'r', '2')]
  const initial = transcript([u], tools, 'r')
  const intermediate = transcript([u, reply('part', 'r', '1')], tools, 'r')
  const final = transcript([u, reply('part', 'r', '1'), reply('final', 'r', '2')], tools)
  assert.deepEqual(ids(intermediate), ['message:u', 'tool:r/first', 'message:part', 'tool:r/last'])
  assert.deepEqual(ids(final), ['message:u', 'tool:r/first', 'message:part', 'tool:r/last', 'message:final'])
  assert.deepEqual(toolRows(initial).map((row) => row.key), toolRows(final).map((row) => row.key))
})

test('B2-PF-03: activity keys survive intervening queued inputs without grouping messages out of order', () => {
  const messages = [user('active', 'r'), user('queued', 'q')], tool = activity('a', 'r', '1')
  const initial = transcript(messages, [tool], 'r')
  const final = transcript([...messages, reply('answer', 'r', '1')], [tool])
  assert.deepEqual(ids(initial), ['message:active', 'tool:r/a', 'message:queued'])
  assert.deepEqual(ids(final), ['message:active', 'message:queued', 'tool:r/a', 'message:answer'])
  assert.equal(toolRows(initial)[0].key, toolRows(final)[0].key)
})

test('B2-PF-03: loading a missing user anchor or a first reply does not change the activity key scope', () => {
  const tool = activity('a', 'r', '1')
  const noMessage = transcript([], [tool], 'r')
  const withUser = transcript([user('u', 'r')], [tool], 'r')
  const withReply = transcript([reply('answer', 'r', '1')], [tool])
  assert.equal(noMessage[0].key, toolRows(withUser)[0].key)
  assert.equal(noMessage[0].key, toolRows(withReply)[0].key)
})

test('B2-PF-03: request-local provider ids are distinct and a conversation switch resets identity', () => {
  const messages = [user('u1', 'r1'), reply('a1', 'r1', '1'), user('u2', 'r2'), reply('a2', 'r2', '2')]
  const tools = [activity('same-id', 'r1', '1'), activity('same-id', 'r2', '2')]
  const keys = toolRows(transcript(messages, tools)).map((row) => row.key)
  assert.equal(new Set(keys).size, 2)
  assert.notEqual(keys[0], toolRows(transcript(messages, tools, undefined, 'other-conversation'))[0].key)
})

test('B-R04: completed-message fallback and old unanchored activity precede the latest answer', () => {
  const messages = [user('u1', 'r1'), reply('a1', 'r1'), user('u2', 'r2'), reply('a2', 'r2')]
  const tools = [activity('older', 'evicted-request', '1'), activity('first', 'r1', '2'), activity('last', 'r2', '3')]
  assert.deepEqual(ids(transcript(messages, tools)), [
    'tool:evicted-request/older', 'message:u1', 'tool:r1/first', 'message:a1', 'message:u2', 'tool:r2/last', 'message:a2',
  ])
})

test('B-R04: public sequence boundaries keep post-reply activity after that reply (bigint safe)', () => {
  const messages = [user('u', 'r'), reply('part', 'r', '9007199254740992')]
  const tools = [activity('before', 'r', '9007199254740992'), activity('after', 'r', '9007199254740993')]
  assert.deepEqual(ids(transcript(messages, tools, 'r')), ['message:u', 'tool:r/before', 'message:part', 'tool:r/after'])
  const final = transcript([...messages, reply('final', 'r', '9007199254740993')], tools)
  assert.deepEqual(ids(final), ['message:u', 'tool:r/before', 'message:part', 'tool:r/after', 'message:final'])
})

test('B-R04: every public activity occurs once and 72 tools cannot trail the last completed reply', () => {
  const messages = [], tools = []
  for (let i = 1; i <= 3; i++) {
    messages.push(user(`u${i}`, `r${i}`), reply(`a${i}`, `r${i}`, String(i * 24)))
    for (let j = 1; j <= 24; j++) tools.push(activity(`tool${j}`, `r${i}`, String((i - 1) * 24 + j)))
  }
  const rendered = transcript(messages, tools)
  assert.equal(rendered.length, 78)
  assert.equal(new Set(rendered.map((row) => row.key)).size, 78)
  assert.equal(rendered.at(-1).key, 'message:a3')
  assert.equal(toolRows(rendered).length, 72)
})

test('shared history still renders ordinary message status/actions and its empty state', () => {
  const rendered = ConversationHistory({ messages: [user('u', 'r')], renderStatus: () => 'status', renderActions: () => 'actions' })
  const bubble = find(rendered, ui.MessageBubble)
  assert.equal(bubble.props.status, 'status'); assert.equal(bubble.props.actions, 'actions')
  assert.equal(ConversationHistory({ messages: [] }).props['data-testid'], 'conversation-empty')
})

test('B-R04: actual viewport handlers pause at inspection/scroll, ignore replay and resume on Jump/resize (hook-stub check)', () => {
  const refs = [], states = [], deps = [], effects = []
  let refIndex = 0, stateIndex = 0, effectIndex = 0, browse, resize
  const hooks = {
    useRef(value) { const i = refIndex++; return refs[i] ??= { current: value } },
    useState(value) { const i = stateIndex++; if (!(i in states)) states[i] = value
      return [states[i], (next) => { states[i] = next }] },
    useLayoutEffect(effect, nextDeps) { const i = effectIndex++
      if (!deps[i] || nextDeps.some((v, j) => !Object.is(v, deps[i][j]))) { deps[i] = nextDeps; effects.push(effect) } },
  }
  const { ConversationViewport } = load('../ConversationViewport.tsx', { react: hooks, '../../shared/ui/nocturne': ui })
  let height = 1000, top = 0
  const scroll = { clientHeight: 200, get scrollHeight() { return height }, get scrollTop() { return top },
    set scrollTop(value) { top = Math.max(0, Math.min(value, height - this.clientHeight)) } }
  const saved = globalThis.ResizeObserver
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback } observe() {} disconnect() {} }
  try {
    const render = (revision) => {
      refIndex = 0; stateIndex = 0; effectIndex = 0
      const tree = ConversationViewport({ revision, children: (onBrowse) => { browse = onBrowse; return null } })
      refs[0].current = scroll; refs[1].current = {}
      while (effects.length) effects.shift()()
      return tree
    }
    render('initial'); assert.equal(top, 800)
    browse(); height = 1200; render('first reply'); assert.equal(top, 800)
    let tree = render('first reply')
    const jump = find(tree, ui.Button); assert.ok(jump); assert.equal(jump.props.children, 'Jump to latest')
    jump.props.onClick(); tree = render('first reply'); assert.equal(top, 1000); assert.equal(find(tree, ui.Button), undefined)
    height = 1300; resize(); assert.equal(top, 1100)
    const region = find(tree, 'div').props.children[0]
    scroll.scrollTop = 100; region.props.onScroll({ currentTarget: scroll })
    height = 1500; resize(); render('later reply'); assert.equal(top, 100)
    tree = render('later reply'); assert.ok(find(tree, ui.Button))
  } finally { if (saved === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = saved }
})
