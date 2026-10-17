import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export function profileDirectory(environment = process.env) {
  const directory = environment.CLAUDE_CONFIG_DIR
  if (!directory || !isAbsolute(directory)) throw new Error('Fake Claude requires its explicit isolated CLAUDE_CONFIG_DIR.')
  const root = join(directory, 'conformance-sessions')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function sessionFile(directory, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Fake Claude requires a valid native session UUID.')
  return join(directory, `${id}.json`)
}

export function readSession(directory, id) {
  try { return JSON.parse(readFileSync(sessionFile(directory, id), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export function saveSession(directory, session) {
  const destination = sessionFile(directory, session.sessionId)
  const temporary = `${destination}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, destination)
}

export function createSession(directory, cwd, resume) {
  if (resume) {
    const session = readSession(directory, resume)
    if (!session || session.cwd !== cwd) throw new Error('Fake Claude resume does not match the original session and directory.')
    return session
  }
  const session = { sessionId: randomUUID(), cwd, createdAt: new Date().toISOString(), messages: [] }
  saveSession(directory, session)
  return session
}

export function readScript(text) {
  let scripts
  try { scripts = JSON.parse(readFileSync(new URL('scripts.json', import.meta.url), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return { answer: 'Conformance assistant answer.' }
    throw error
  }
  if (!Array.isArray(scripts)) throw new Error('Fake Claude scripts must be an array.')
  return scripts.find(script => typeof script.includes === 'string' && text.includes(script.includes))
    ?? { answer: 'Conformance assistant answer.' }
}
