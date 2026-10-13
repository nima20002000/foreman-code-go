import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'

export interface CloudRestOptions {
  fetch?: typeof fetch
  circleToken?: () => Promise<string | null>
}
type Provider = 'github' | 'circleci'
type TokenCache = Map<Provider, Promise<string | null>>
const deadlines = new AsyncLocalStorage<AbortSignal>()
const credentials = new WeakMap<HostCiPorts, TokenCache>()

/** Reads the CLI's existing configuration; secure-store-only logins retain the CLI fallback. */
async function configuredCircleToken(): Promise<string | null> {
  const environmentToken = process.env.CIRCLE_TOKEN || process.env.CIRCLE_CLI_TOKEN
  if (environmentToken) return environmentToken
  const paths = [join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'circleci', 'config.yml'),
    join(homedir(), '.circleci', 'cli.yml')]
  for (const path of paths) {
    try {
      const config = parse(await readFile(path, 'utf8')) as { token?: unknown } | null
      if (typeof config?.token === 'string' && config.token.trim()) return config.token.trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // ignore: unreadable CLI credentials use the CLI's own credential resolution.
      return null
    }
  }
  return null
}

export class CloudHttp {
  private readonly cache: TokenCache
  private readonly fetch: typeof fetch

  constructor(private readonly ports: HostCiPorts, private readonly provider: Provider,
    private readonly options: CloudRestOptions = {}) {
    let cache = credentials.get(ports)
    if (!cache) {
      cache = new Map()
      credentials.set(ports, cache)
    }
    this.cache = cache
    this.fetch = options.fetch ?? globalThis.fetch
  }

  private token() {
    let pending = this.cache.get(this.provider)
    if (!pending) {
      pending = this.loadToken()
      this.cache.set(this.provider, pending)
    }
    return pending
  }

  private async loadToken(): Promise<string | null> {
    try {
      if (this.provider === 'circleci') return await (this.options.circleToken ?? configuredCircleToken)()
      const result = await this.ports.run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 15_000 })
      return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null
    } catch {
      // ignore: unavailable credentials retain the provider CLI path without exposing credential errors.
      return null
    }
  }

  async request(path: string, options: { timeoutMs?: number; headers?: Record<string, string> } = {}) {
    const pending = this.token()
    const token = await pending
    if (!token) return null
    const base = this.provider === 'github' ? 'https://api.github.com' : 'https://circleci.com'
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
    const deadline = deadlines.getStore()
    const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout
    const send = (value: string) => this.fetch(`${base}${path}`, {
      signal, redirect: 'manual', headers: {
        Authorization: `Bearer ${value}`, 'User-Agent': 'foreman-code',
        ...(this.provider === 'github' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        ...options.headers,
      },
    })
    try {
      let response = await send(token)
      if (response.status === 401) {
        await response.body?.cancel()
        // A concurrent rejected request must share the same credential refresh.
        if (this.cache.get(this.provider) === pending) this.cache.delete(this.provider)
        const refreshed = await this.token()
        if (!refreshed) return null
        response = await send(refreshed)
      }
      return response
    } catch {
      // Transport errors must not expose a token, signed URL, or credential-file path.
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} HTTPS request failed.`, 502)
    }
  }

  async operation<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    try {
      return await deadlines.run(AbortSignal.timeout(timeoutMs), operation)
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} HTTPS request failed.`, 502)
    }
  }

  async json<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T
    } catch {
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} returned an invalid response.`, 502)
    }
  }

  async available() { return await this.token() !== null }

  get label() { return this.provider === 'github' ? 'GitHub Actions' : 'CircleCI' }

  async check(response: Response, message: (detail: string) => string): Promise<void> {
    if (response.ok || response.status === 304) return
    const text = await response.text()
    if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
      || /rate limit|too many requests/i.test(text)) {
      throw new DomainError('CI_CLOUD_RATE_LIMITED', `${this.label} rate limit reached; polling paused.`, 503)
    }
    let detail = response.statusText
    try {
      const body = JSON.parse(text) as { message?: unknown }
      if (typeof body.message === 'string') detail = body.message
    } catch {
      // ignore: non-JSON error bodies use the HTTP status description.
    }
    const token = await this.token()
    if (token) detail = detail.split(token).join('[redacted]')
    if (this.provider === 'github') detail = `gh: ${detail} (HTTP ${response.status})`
    throw new DomainError('CI_CLOUD_FAILED', message(detail.trim().slice(0, 300)), 502)
  }

  async download(response: Response, timeoutMs: number): Promise<Buffer> {
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      return this.downloadUrl(location, timeoutMs)
    }
    await this.check(response, () => `${this.label} artifacts could not be downloaded.`)
    return Buffer.from(await response.arrayBuffer())
  }

  async downloadUrl(url: string, timeoutMs: number): Promise<Buffer> {
    // Signed artifact/log URLs must never receive API credentials, including across redirects.
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const deadline = deadlines.getStore()
      const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout
      const response = await this.fetch(url, { signal })
      await this.check(response, () => `${this.label} artifacts could not be downloaded.`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('CI_CLOUD_FAILED', `${this.label} artifacts could not be downloaded.`, 502)
    }
  }
}
