import { spawn } from 'node:child_process'
import { groupUsed, stopGroup } from './integration-process.mjs'
import { provisionTestResources } from './test-resources.mjs'

const [separator, command, ...args] = process.argv.slice(2)
if (separator !== '--' || !command) throw new Error('Usage: test-command.mjs -- command [arguments]')
const resources = await provisionTestResources()
let child
try {
  child = spawn(command, args, { env: resources.environment, stdio: 'inherit', detached: true })
  const interrupt = signal => {
    if (child.pid && groupUsed(child.pid)) process.kill(-child.pid, signal)
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
    })
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
} finally {
  if (child?.pid) await stopGroup(child.pid, { signal: 'SIGTERM' })
  await resources.close()
}
