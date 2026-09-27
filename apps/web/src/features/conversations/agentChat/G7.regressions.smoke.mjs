/** Standalone source/branch regressions. No DOM layout engine, HTTP, DB, or native provider.
 * Run from the repository root: node --test apps/web/src/features/conversations/agentChat/G7.regressions.smoke.mjs
 * TypeScript is resolved from the installed workspace. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { URL } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const jsx = (type, props) => ({ type, props: props ?? {} })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' }
function load(path, mocks) {
  const compiled = ts.transpileModule(read(path), { fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
  assert.deepEqual(compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error), [])
  const module = { exports: {} }
  Function('require', 'module', 'exports', compiled.outputText)((name) => {
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (Object.hasOwn(mocks, name)) return mocks[name]
    throw new Error(`Unexpected dependency: ${name}`)
  }, module, module.exports)
  return module.exports
}
function walk(value) {
  if (Array.isArray(value)) return value.flatMap(walk)
  if (!value || typeof value !== 'object') return []
  return [value, ...walk(value.props?.children)]
}
const text = (value) => Array.isArray(value) ? value.map(text).join('')
  : value && typeof value === 'object' ? text(value.props?.children)
    : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const match = (tree, predicate) => walk(tree).find(predicate)
const context = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const baseState = () => ({ context, conversation: null, sessionState: 'none', availability: { canSend: true },
  capabilities: { harness: 'codex', steer: 'native_expected_turn', interruptAndSend: true, queueNextTurn: true, resume: true, unavailable: {} },
  activeTurn: null, turns: [], messages: [], activities: [] })
const activeState = () => ({ ...baseState(), conversation: { id: 'conversation' }, sessionState: 'active',
  activeTurn: { requestId: 'request', nativeTurnId: 'turn' } })
function renderConversation(state) {
  const calls = [], drafts = { selection: 'Keep this draft' }
  const chat = { state, draftKey: 'selection', access: { isPending: false, isError: false }, canRead: true,
    query: { isError: false, isPending: false }, blocked: () => undefined, online: true, connection: 'connected',
    commands: [], history: {}, send: (...args) => calls.push(['send', ...args]), stop: () => calls.push(['stop']) }
  const { AgentConversation } = load('./AgentConversation.tsx', {
    react: { useEffect() {}, useId: () => 'reason-id', useRef: (current) => ({ current }), useState: (value) => [value, () => {}] },
    '../../../shared/ui/nocturne': { Alert: 'Alert', Button: 'Button', ConfirmDialog: 'ConfirmDialog', LoadingState: 'LoadingState' },
    '../../../shared/api/client': { ApiError: { is: () => false } },
    '../ConversationComposer': { ConversationComposer: 'Composer' },
    '../ConversationViewport': { ConversationViewport: 'Viewport' },
    '../conversationDraftStore': { useConversationDraftStore: (select) => select({ drafts }) },
    './AgentChatTranscript': { AgentChatTranscript: 'Transcript' },
    './useAgentChat': { useAgentChat: () => chat }, './agentChat.css': {},
    // This smoke test exercises view branches, not intent policy or access authorization.
    './model': { chatBusy: (value) => !!value.activeTurn, deliveryLabels: {}, intentLabels: {},
      intentUnavailable: (value) => value.availability.canSend ? undefined : value.availability.message },
  })
  const tree = AgentConversation({ context: state.context, name: 'Coder', runActivity: jsx('p', { children: 'Run activity' }), onNewConversation() {} })
  const transcript = match(tree, (node) => node.type === 'Transcript')
  return { tree, calls, drafts, transcript, notices: transcript?.props.notices ?? tree }
}
const css = read('./agentChat.css')
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'g'))]
  assert.ok(found.length, `Missing CSS rule: ${selector}`)
  return found.map((match) => match[1]).join('\n')
}

test('T-08: Queue, Steer, Interrupt and send, and Stop share a non-scrolling action sibling', () => {
  const rendered = renderConversation(activeState())
  const actions = match(rendered.tree, (node) => node.props['aria-label'] === 'Chat actions')
  assert.ok(actions)
  const composer = match(actions, (node) => node.type === 'Composer')
  assert.equal(composer.props.sendLabel, 'Queue message')
  for (const label of ['Steer', 'Interrupt and send', 'Stop chat']) {
    assert.ok(match(actions, (node) => node.type === 'Button' && text(node) === label), label)
    assert.equal(match(rendered.transcript?.props.notices, (node) => node.type === 'Button' && text(node) === label), undefined)
  }
  composer.props.onSubmit('Queue input')
  match(actions, (node) => text(node) === 'Steer').props.onClick()
  match(actions, (node) => text(node) === 'Interrupt and send').props.onClick()
  match(actions, (node) => text(node) === 'Stop chat').props.onClick()
  assert.deepEqual(rendered.calls, [['send', 'Queue input', 'next_turn'], ['send', 'Keep this draft', 'steer'],
    ['send', 'Keep this draft', 'interrupt_and_send'], ['stop']])
  assert.match(rule('.agent-chat-composer-controls'), /flex:\s*0 0 auto/)
  assert.doesNotMatch(rule('.agent-chat-composer-controls'), /overflow:\s*(auto|scroll)/)
})

test('T-03/RISK-01: status, Run activity, and potentially long reasons are inside the transcript slot', () => {
  const state = activeState()
  state.capabilities.steer = 'unavailable'; state.capabilities.unavailable.steer = 'Long provider note. '.repeat(100)
  const { transcript } = renderConversation(state)
  assert.ok(transcript?.props.notices)
  assert.match(text(transcript.props.notices), /Run activity/)
  assert.match(text(transcript.props.notices), /No partial assistant text/)
  assert.match(text(transcript.props.notices), /Long provider note/)
  const { AgentChatTranscript } = load('./AgentChatTranscript.tsx', {
    '../../../shared/ui/nocturne': { Badge: 'Badge', Button: 'Button', MessageBubble: 'MessageBubble' },
    '../../operator-chat/OperatorActivityList': { OperatorActivityList: 'Activity' },
    '../../operator-chat/OperatorApprovalCard': { OperatorApprovalCard: 'Approval' },
    '../ConversationHistory': { ConversationHistory: 'History' }, '../ConversationViewport': { ConversationViewport: 'Viewport' },
    './model': { mergeChatMessages: (...pages) => pages.flat(), approvalReplyAvailable: () => true },
    './activityPlacement': { placeChatActivities: () => ({ rows: [] }) },
    './commandRecords': { confirmedCommandReceipt: () => undefined },
    './useAgentChat': { commandMayHaveBeenAccepted: () => false },
  })
  const view = AgentChatTranscript(transcript.props)
  assert.equal(view.type, 'Viewport')
  assert.ok(walk(view.props.children(() => {})).includes(transcript.props.notices))
  assert.match(rule(".n-agent-popover[data-panel='chat'] .n-agent-popover-body"), /overflow:\s*hidden/)
  assert.match(rule('.conversation-viewport-scroll'), /overflow-y:\s*auto/)
  assert.doesNotMatch(rule('.conversation-viewport-scroll'), /max-height/)
  assert.doesNotMatch(css, /(?:35vh|42vh|26rem)/)
  assert.match(rule('.agent-conversation .operator-approval-command'), /max-height:\s*none;\s*overflow:\s*visible/)
})

test('T-05: unsupported steer appears only with an active turn, not an empty or idle conversation', () => {
  for (const phase of ['none', 'idle', 'active']) {
    const state = phase === 'none' ? baseState() : activeState()
    state.sessionState = phase
    if (phase === 'idle') state.activeTurn = null
    state.capabilities.steer = 'unavailable'; state.capabilities.harness = 'opencode'
    state.capabilities.unavailable.steer = 'OpenCode cannot add input to a running turn.'
    const { notices } = renderConversation(state)
    assert.equal(text(notices).includes(state.capabilities.unavailable.steer), phase === 'active')
  }
})

test('T-05: queue/interrupt notes are busy-only; continuation notes require an existing idle conversation', () => {
  const state = baseState()
  state.capabilities = { ...state.capabilities, queueNextTurn: false, interruptAndSend: false, resume: false,
    unavailable: { queueNextTurn: 'Queue unavailable', interruptAndSend: 'Interrupt unavailable', resume: 'Resume unavailable' } }
  let notices = text(renderConversation(state).notices)
  assert.doesNotMatch(notices, /Queue unavailable|Interrupt unavailable|Resume unavailable/)
  state.conversation = { id: 'conversation' }; state.sessionState = 'idle'
  notices = text(renderConversation(state).notices)
  assert.match(notices, /Resume unavailable/); assert.doesNotMatch(notices, /Queue unavailable|Interrupt unavailable/)
  state.activeTurn = { requestId: 'request' }; state.sessionState = 'active'
  notices = text(renderConversation(state).notices)
  assert.match(notices, /Queue unavailable/); assert.match(notices, /Interrupt unavailable/); assert.doesNotMatch(notices, /Resume unavailable/)
})

test('T-07: a Run with no stored session has no first-message form, no resume claim, and keeps local draft state', () => {
  const state = baseState(); state.context = { ...context, runId: 'run-without-session' }
  state.availability = { canSend: false, reason: 'native_session_missing', message: 'This Run has no stored native session for this Agent.' }
  const { tree, transcript, drafts } = renderConversation(state)
  assert.equal(match(tree, (node) => node.type === 'Composer'), undefined)
  const notices = text(transcript.props.notices)
  assert.match(notices, /No chat exists for this Run selection/)
  assert.match(notices, /Start separate chat without this Run/)
  assert.doesNotMatch(notices, /Start a conversation|This conversation cannot be resumed/)
  assert.equal(drafts.selection, 'Keep this draft')
})

test('T-07 guard: a usable first session still has a composer; a lost existing chat retains its draft and honest loss wording', () => {
  assert.ok(match(renderConversation(baseState()).tree, (node) => node.type === 'Composer'))
  const state = activeState(); state.activeTurn = null; state.sessionState = 'unavailable'
  state.availability = { canSend: false, reason: 'native_session_missing', message: 'Stored session was lost.' }
  const { tree, notices } = renderConversation(state)
  assert.equal(match(tree, (node) => node.type === 'Composer').props.sendDisabled, true)
  assert.match(text(notices), /This conversation cannot be resumed/)
})

function placePopover({ width, height, visualHeight = height, offsetTop = 0, offsetLeft = 0, panel = 'chat' }) {
  let effect, nextFrame, refIndex = 0
  const properties = new Map(), style = { left: '', top: '', setProperty: (key, value) => properties.set(key, value) }
  const visual = Object.assign(new globalThis.EventTarget(), { width, height: visualHeight, offsetTop, offsetLeft })
  const windowValue = { innerWidth: width, innerHeight: height, visualViewport: visual }
  // Synthetic CSS box inputs. These prove JS clamping, not browser layout or actual control bounds.
  const surface = { style,
    get offsetWidth() { return width > 720 ? 320 : width },
    get offsetHeight() { return Math.min(768, Number.parseFloat(properties.get('--agent-chat-viewport-height') ?? String(height)) - (width > 720 ? 24 : 12)) } }
  const previous = { window: globalThis.window, document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  globalThis.window = windowValue; globalThis.document = { body: {} }
  globalThis.requestAnimationFrame = (callback) => { nextFrame = callback; return 1 }
  globalThis.cancelAnimationFrame = () => {}
  try {
    const { AgentPopover } = load('../../../shared/ui/nocturne/Canvas.tsx', {
      react: { forwardRef: (component) => component, useEffect() {}, useLayoutEffect: (callback) => { effect = callback },
        useRef: (current) => ({ current: refIndex++ === 0 ? surface : current }), useId: () => 'popover' },
      'react-dom': { createPortal: (element) => element }, './Icon': { Icon: 'Icon' }, './Button': { IconButton: 'IconButton' },
      './Navigation': { Tabs: 'Tabs' }, './utils': { cx: (...names) => names.filter(Boolean).join(' ') },
    })
    const tree = AgentPopover({ open: true, panel, title: 'Coder', onClose() {}, onPanelChange() {},
      anchor: { current: { getBoundingClientRect: () => ({ left: 1280, right: 1320, top: 600, height: 40 }) } } })
    const cleanup = effect()
    if (panel === 'chat') assert.equal(tree.props['data-panel'], panel)
    const verify = () => {
      const left = Number.parseFloat(style.left), top = Number.parseFloat(style.top)
      assert.ok(left >= visual.offsetLeft, `${left} >= ${visual.offsetLeft}`)
      assert.ok(top >= visual.offsetTop, `${top} >= ${visual.offsetTop}`)
      assert.ok(left + surface.offsetWidth <= visual.offsetLeft + visual.width)
      assert.ok(top + surface.offsetHeight <= visual.offsetTop + visual.height)
    }
    if (panel === 'chat') {
      verify()
      visual.height = Math.min(400, height); visual.offsetTop = 31
      visual.dispatchEvent(new globalThis.Event('resize')); verify()
      nextFrame(); verify()
      assert.equal(properties.get('--agent-chat-viewport-height'), `${visual.height}px`)
    } else assert.equal(properties.size, 0)
    cleanup()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}
for (const [width, height] of [[1400, 812], [320, 568], [390, 844]]) {
  test(`T-06/RISK-01: ${width}x${height} placement follows the visual viewport and keyboard shrink (synthetic boxes)`, () => {
    placePopover({ width, height })
  })
}
test('T-06: the Operator launcher cannot intercept chat controls and safe-area space is reserved', () => {
  const launcher = rule("body:has(.n-agent-popover[data-panel='chat']) .operator-chat-launcher")
  assert.match(launcher, /visibility:\s*hidden/); assert.match(launcher, /pointer-events:\s*none/)
  assert.match(css, /env\(safe-area-inset-bottom\)/)
  assert.match(rule('.agent-chat-composer-controls > .agent-chat-controls'), /repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(rule('.agent-conversation .n-composer textarea'), /resize:\s*none/)
})
test('RISK-01 guard: Settings retains its existing placement and has no chat viewport sizing', () => {
  placePopover({ width: 390, height: 844, panel: 'settings' })
})
