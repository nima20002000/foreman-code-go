import { spawn } from 'node:child_process'
import { stopGroup } from './integration-process.mjs'
import { completeTestResourceCleanup, provisionTestResources, registerTestResourceCleanup } from './test-resources.mjs'

const [separator, command, ...args] = process.argv.slice(2)
if (separator !== '--' || !command) throw new Error('Usage: test-command.mjs -- command [arguments]')
const resources = await provisionTestResources()
const invocation = { directory: resources.environment.GRAPHQL_TEST_ROOT, token: resources.environment.GRAPHQL_TEST_OWNER }
const cleanupId = registerTestResourceCleanup(invocation, { kind: 'suite-process-group', wrapperPid: process.pid })
let child
let shutdown
let interruptedCode
let interrupted
const interruption = new Promise((resolve, reject) => { interrupted = { resolve, reject } })
const interrupt = signal => {
  interruptedCode ??= signal === 'SIGINT' ? 130 : 143
  shutdown ??= stopGroup(child?.pid, { signal })
  void shutdown.then(() => interrupted.resolve(interruptedCode), interrupted.reject)
}
const onSigint = () => interrupt('SIGINT')
const onSigterm = () => interrupt('SIGTERM')
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
try {
  child = spawn(command, args, { env: resources.environment, stdio: 'inherit', detached: true })
  process.exitCode = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
    }),
    interruption,
  ])
} finally {
  try {
    shutdown ??= stopGroup(child?.pid, { signal: 'SIGTERM' })
    await shutdown
    completeTestResourceCleanup(invocation, cleanupId)
    await resources.close()
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (interruptedCode) process.exitCode = interruptedCode
  }
}
