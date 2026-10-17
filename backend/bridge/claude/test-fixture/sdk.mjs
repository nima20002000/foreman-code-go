import { appendFileSync } from 'node:fs'

function outputQueue() {
  const values = []
  let reader
  let ended = false
  return {
    push(value) {
      if (reader) { const resolve = reader; reader = undefined; resolve({ value, done: false }) }
      else values.push(value)
    },
    end() { ended = true; reader?.({ done: true }); reader = undefined },
    [Symbol.asyncIterator]() { return this },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false })
      if (ended) return Promise.resolve({ done: true })
      return new Promise(resolve => { reader = resolve })
    },
  }
}

export function query({ prompt, options }) {
  const output = outputQueue()
  const run = async () => {
    for await (const message of prompt) {
      if (options.fixtureCase === 'tool-signal') {
        const answer = await options.canUseTool('SignalTool', { signal: 'SIGTERM', payload: { value: 7 } }, {
          signal: options.abortController.signal, toolUseID: 'fixture-tool-request', requestId: 'fixture-control-request',
        })
        output.push({ type: 'result', answer, message })
      }
    }
    output.end()
  }
  void run().catch(error => {
    if (!options.abortController.signal.aborted) output.push({ type: 'fixture-error', message: error.message })
    output.end()
  })
  return {
    [Symbol.asyncIterator]: () => output,
    async interrupt() {},
    close() {
      output.end()
      if (options.traceFile) appendFileSync(options.traceFile, `${options.fixtureId}:closed\n`, { mode: 0o600 })
      if (options.throwOnClose) throw new Error(`${options.fixtureId} SDK close failed`)
    },
    async setMcpServers(servers) { return { received: servers } },
  }
}

function unavailable() { throw new Error('History is outside this focused bridge fixture') }
export const getSessionInfo = unavailable
export const getSessionMessages = unavailable
export const forkSession = unavailable
export const listSubagents = unavailable
export const getSubagentMessages = unavailable
