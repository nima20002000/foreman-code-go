import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'

// A case can take 180 seconds plus hooks; multi-case files can exceed ten minutes.
// Log inactivity catches stalled setup/teardown without cutting off a progressing file.
export const integrationProcessLimits = {
  idleTimeoutMs: 10 * 60_000,
  fileTimeoutMs: 60 * 60_000,
  pollIntervalMs: 1000,
  graceMs: 5000,
}

export function groupUsed(pgid) {
  if (!pgid) return false
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const fields = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ')
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') return true
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
  }
  return false
}

function signalGroup(pgid, signal) {
  if (!pgid) return
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function waitForGroupExit(pgid, graceMs) {
  const started = Date.now()
  while (groupUsed(pgid) && Date.now() - started < graceMs) {
    await new Promise((done) => setTimeout(done, Math.min(100, graceMs)))
  }
  return !groupUsed(pgid)
}

export async function stopGroup(pgid, { signal = 'SIGTERM', graceMs = 5000 } = {}) {
  if (!groupUsed(pgid)) return
  signalGroup(pgid, signal)
  if (await waitForGroupExit(pgid, graceMs)) return
  signalGroup(pgid, 'SIGKILL')
  if (!await waitForGroupExit(pgid, graceMs)) {
    throw new Error(`Child process group ${pgid} did not exit`)
  }
}

export function integrationProcessProgress() {
  const started = Date.now()
  return { started, lastOutputAt: started, bytes: 0, loggedBytes: 0 }
}

function updateProgress(log, progress) {
  const bytes = statSync(log).size
  if (bytes !== progress.loggedBytes) {
    progress.loggedBytes = bytes
    progress.bytes = Math.max(progress.bytes, bytes)
    progress.lastOutputAt = Date.now()
  }
}

export function waitForIntegrationProcess(child, {
  log,
  progress = integrationProcessProgress(),
  idleTimeoutMs = integrationProcessLimits.idleTimeoutMs,
  fileTimeoutMs = integrationProcessLimits.fileTimeoutMs,
  pollIntervalMs = integrationProcessLimits.pollIntervalMs,
  graceMs = integrationProcessLimits.graceMs,
  onTimeout = () => {},
}) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(result)
    }
    const onError = (error) => finish({ code: 1, error, timedOut })
    const onExit = (code, signal) => {
      if (timedOut) return
      finish({ code: code ?? (signal === 'SIGINT' ? 130 : 143), timedOut: false })
    }
    const check = async () => {
      if (settled || timedOut) return
      try {
        updateProgress(log, progress)
        const now = Date.now()
        const elapsed = now - progress.started
        const idle = now - progress.lastOutputAt
        if (elapsed < fileTimeoutMs && idle < idleTimeoutMs) return
        timedOut = true
        const reason = elapsed >= fileTimeoutMs
          ? `file exceeded ${fileTimeoutMs} ms`
          : `no log output for ${idleTimeoutMs} ms`
        const error = new Error(`Integration process timed out: ${reason}`)
        appendFileSync(log, `\n[integration] TIMEOUT: ${reason}\n`)
        onTimeout(error)
        await stopGroup(child.pid, { graceMs })
        finish({ code: 124, error, timedOut: true })
      } catch (error) {
        finish({ code: 1, error, timedOut })
      }
    }
    const timer = setInterval(() => { void check() }, pollIntervalMs)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export async function superviseIntegrationProcess(child, { resetAfterTimeout, ...options }) {
  const result = await waitForIntegrationProcess(child, options)
  try {
    await stopGroup(child.pid, { graceMs: options.graceMs ?? integrationProcessLimits.graceMs })
  } catch (error) {
    return { ...result, code: 1, error, slotUnavailable: true }
  }
  if (result.timedOut) {
    try {
      await resetAfterTimeout()
    } catch (resetError) {
      appendFileSync(options.log, `\n[integration] SLOT RETIRED: ${resetError.message}\n`)
      return { ...result, resetError, slotUnavailable: true }
    }
  }
  return result
}
