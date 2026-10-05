import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { promisify } from 'node:util'
import type { ApiErrorResponse } from './index.js'

const inspectSockets = promisify(execFile)
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Attribute a loopback connection from its kernel cgroup, never client headers. */
export async function localHumanClient(socket: Pick<Socket,
  'remoteAddress' | 'remotePort' | 'localAddress' | 'localPort'>): Promise<boolean> {
  const { remoteAddress, remotePort, localAddress, localPort } = socket
  if (process.platform !== 'linux' || !remoteAddress || !localAddress
    || !loopbackAddresses.has(remoteAddress) || !loopbackAddresses.has(localAddress)
    || !Number.isInteger(remotePort) || !Number.isInteger(localPort)) return false
  const filter = `( src ${remoteAddress} and sport = :${remotePort}
    and dst ${localAddress} and dport = :${localPort} )`
  // inet_diag reports the socket's kernel cgroup even when a browser or harness
  // sandbox makes /proc/<pid>/fd unreadable. Detached children retain this boundary.
  const { stdout } = await inspectSockets('/usr/bin/ss', ['--tcp', '--no-header', '--numeric', '--extended', filter], {
    timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: { LC_ALL: 'C' },
  })
  const rows = stdout.trim().split('\n').filter(Boolean)
  return rows.length === 1 && /\bcgroup:\S+/.test(rows[0]!)
    && !/(?:^|\/)graphql-native-[0-9a-f-]{36}(?:\/|\s|$)/.test(rows[0]!)
}

/** Preserve the client's process boundary before a browser development proxy forwards it. */
export async function localHumanProxyRequest(request: IncomingMessage, response: ServerResponse,
  next: (error?: Error) => void): Promise<void> {
  if (!request.url?.startsWith('/api/') || request.headers.authorization !== undefined) {
    next()
    return
  }
  try {
    if (await localHumanClient(request.socket)) {
      next()
      return
    }
    response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    const error: ApiErrorResponse = { error: { code: 'LOCAL_HUMAN_REQUIRED',
      message: 'Agent processes require an application credential.' } }
    response.end(JSON.stringify(error))
  } catch (error) { next(error as Error) }
}
