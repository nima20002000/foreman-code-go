import type pg from 'pg'
import { DomainError } from '../errors.js'

interface Waiter {
  workspaceId: string
  ticketId: string
  resolve(): void
  reject(error: unknown): void
}
interface ListeningSession {
  ready: Promise<void>
  waiters: Set<Waiter>
  client: pg.PoolClient | undefined
  notification: (message: pg.Notification) => void
  error: (error: Error) => void
}

/** Concurrent waits share one LISTEN connection; PostgreSQL sends changes after commit. */
export class CiTicketChanges {
  private session: ListeningSession | undefined

  constructor(private readonly pool: pg.Pool) {}

  private open(): ListeningSession {
    const session: ListeningSession = {
      ready: Promise.resolve(), waiters: new Set(), client: undefined,
      notification: message => {
        if (message.channel !== 'ci_ticket_changed' || !message.payload) return
        const change = JSON.parse(message.payload) as { workspaceId: string; ticketId: string }
        for (const waiter of session.waiters) {
          if (waiter.workspaceId === change.workspaceId && waiter.ticketId === change.ticketId) waiter.resolve()
        }
      },
      error: error => {
        for (const waiter of session.waiters) waiter.reject(error)
        this.dispose(session)
      },
    }
    this.session = session
    session.ready = this.pool.connect().then(async client => {
      client.on('error', session.error)
      client.on('notification', session.notification)
      try {
        await client.query('LISTEN ci_ticket_changed')
      } catch (error) {
        client.removeListener('error', session.error)
        client.removeListener('notification', session.notification)
        client.release(true)
        throw error
      }
      session.client = client
      if (this.session !== session) this.dispose(session)
    }).catch(error => {
      for (const waiter of session.waiters) waiter.reject(error)
      this.dispose(session)
      throw error
    })
    return session
  }

  subscribe(workspaceId: string, ticketId: string, waitSeconds: number, signal?: AbortSignal) {
    const session = this.session ?? this.open()
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const changed = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const waiter = { workspaceId, ticketId, resolve, reject }
    session.waiters.add(waiter)
    const timer = setTimeout(resolve, waitSeconds * 1000)
    const abort = () => reject(new DomainError('MCP_REQUEST_CANCELLED', 'The CI wait was canceled.', 409))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    return {
      ready: Promise.race([session.ready, changed]),
      changed,
      close: () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        session.waiters.delete(waiter)
        if (!session.waiters.size) this.dispose(session)
      },
    }
  }

  private dispose(session: ListeningSession) {
    if (this.session === session) this.session = undefined
    const client = session.client
    if (!client) return
    session.client = undefined
    client.removeListener('notification', session.notification)
    client.removeListener('error', session.error)
    // Destroy the connection so its LISTEN registration cannot leak into a pooled query session.
    client.release(true)
  }

  close() {
    const session = this.session
    if (!session) return
    for (const waiter of session.waiters) {
      waiter.reject(new DomainError('CI_SERVICE_CLOSED', 'The CI service is closing.', 503))
    }
    this.dispose(session)
  }
}
