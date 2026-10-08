import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DRIVE_APP_FOLDER, DRIVE_MOUNT_DIRECTORY, DRIVE_REMOTE, DriveComputerRequestSchema, DriveComputerStateSchema,
  type DriveComputerState } from '@foreman-code/contracts/computer-accounts'
import { DomainError } from '../errors.js'

const UNIT = 'foreman-drive.service'
const RELEASES = 'https://downloads.rclone.org'

export interface DriveComputerPorts {
  home: string
  arch: string
  run(file: string, args: string[], options?: { input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>
  fetch(url: string, headers?: Record<string, string>): Promise<Buffer>
  readText(path: string): Promise<string | null>
  writePrivate(path: string, data: string | Buffer, options?: { beforeCommit(): void }): Promise<void>
  /** Moves an unpacked executable into place atomically. */
  install(path: string, source: string): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  mounted(path: string): Promise<boolean>
  wait(ms: number): Promise<void>
}

/** Google Drive on one computer through rclone: installs rclone for this user, keeps the app's Drive remote in
 * this user's rclone config and mounts it at ~/Foreman Code Drive as a user service. Runs on Main and Workers. */
export class DriveComputer {
  private operationId: string | undefined
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly ports: DriveComputerPorts = systemDrivePorts()) {}

  get rclone() { return join(this.ports.home, '.local', 'bin', 'rclone') }
  get mountPath() { return join(this.ports.home, DRIVE_MOUNT_DIRECTORY) }
  private get unitPath() { return join(this.ports.home, '.config', 'systemd', 'user', UNIT) }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async configPath(binary: string): Promise<string> {
    const result = await this.ports.run(binary, ['config', 'file'])
    const path = result.stdout.trim().split('\n').at(-1)?.trim()
    if (result.code !== 0 || !path?.startsWith('/')) {
      throw new DomainError('DRIVE_CONFIG_FAILED', 'The rclone configuration path could not be read.', 502)
    }
    return path
  }

  handle(raw: unknown): Promise<DriveComputerState> {
    const request = DriveComputerRequestSchema.parse(raw)
    if (request.operation === 'intent') {
      this.operationId = request.operationId
      return this.readStatus()
    }
    return this.exclusive(async () => {
      if (request.operation === 'install') await this.install()
      if (request.operation === 'connect') await this.connect(request.token, request.operationId)
      if (request.operation === 'disconnect') await this.disconnect(request.operationId)
      return this.readStatus()
    })
  }

  status(message: string | null = null): Promise<DriveComputerState> {
    return this.exclusive(() => this.readStatus(message))
  }

  private async readStatus(message: string | null = null): Promise<DriveComputerState> {
    const binary = await this.binary()
    const config = binary ? await this.ports.readText(await this.configPath(binary)) ?? '' : ''
    const connected = sections(config).has(DRIVE_REMOTE)
    const account = connected ? await this.account(config) : null
    const mounted = await this.ports.mounted(this.mountPath)
    return DriveComputerStateSchema.parse({ installed: binary !== null, connected, account,
      mountPath: connected || mounted ? this.mountPath : null, mounted, message })
  }

  /** rclone cannot report the Drive account, so the app asks Google once and keeps it as the remote's description. */
  private async account(config: string): Promise<string | null> {
    const known = driveRemoteSetting(config, 'description')
    if (known) return known.slice(0, 320)
    let token: { access_token?: unknown }
    try { token = JSON.parse(driveRemoteSetting(config, 'token') ?? '') as typeof token } catch { return null }
    if (typeof token.access_token !== 'string') return null
    const about = await this.ports.fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      { authorization: `Bearer ${token.access_token}` }).catch(() => null)
    let email: unknown
    try { email = (JSON.parse(about?.toString('utf8') ?? '') as { user?: { emailAddress?: unknown } }).user?.emailAddress } catch { email = undefined }
    if (typeof email !== 'string' || !/^[^\s@]{1,200}@[^\s@]{1,100}$/u.test(email)) return null
    return email
  }

  /** rclone already on PATH is used as is; otherwise the current release is installed for this user, checksum-verified. */
  async install() {
    const installed = await this.binary()
    if (installed) return installed
    const arch = { x64: 'amd64', arm64: 'arm64' }[this.ports.arch]
    if (!arch) throw new DomainError('DRIVE_UNSUPPORTED', 'rclone has no Linux build for this processor.', 409)
    const version = /^rclone (v\d+\.\d+\.\d+)\s*$/u.exec((await this.ports.fetch(`${RELEASES}/version.txt`)).toString('utf8'))?.[1]
    if (!version) throw new DomainError('DRIVE_INSTALL_FAILED', 'The rclone release could not be read.', 502)
    const name = `rclone-${version}-linux-${arch}`
    const sums = (await this.ports.fetch(`${RELEASES}/${version}/SHA256SUMS`)).toString('utf8')
    const expected = new RegExp(`^([a-f0-9]{64})\\s+${name.replaceAll('.', '\\.')}\\.zip$`, 'mu').exec(sums)?.[1]
    const archive = await this.ports.fetch(`${RELEASES}/${version}/${name}.zip`)
    if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) {
      throw new DomainError('DRIVE_INSTALL_FAILED', 'The downloaded rclone did not match its published checksum.', 502)
    }
    const scratch = join(this.ports.home, '.cache', 'foreman-code', name)
    await this.ports.mkdir(scratch)
    try {
      await this.ports.writePrivate(join(scratch, 'rclone.zip'), archive)
      const unzip = await this.ports.run('unzip', ['-o', '-j', join(scratch, 'rclone.zip'), `${name}/rclone`, '-d', scratch], { timeoutMs: 60_000 })
      if (unzip.code !== 0) throw new DomainError('DRIVE_INSTALL_FAILED', 'rclone could not be unpacked (is unzip installed?).', 502)
      await this.ports.mkdir(join(this.ports.home, '.local', 'bin'))
      await this.ports.install(this.rclone, join(scratch, 'rclone'))
    } finally { await this.ports.remove(scratch) }
    return this.rclone
  }

  private assertOperation(operationId: string) {
    if (this.operationId !== operationId) {
      throw new DomainError('DRIVE_LOGIN_INACTIVE', 'This Drive operation was replaced or cancelled.', 409)
    }
  }

  private async connect(token: string, operationId: string) {
    this.assertOperation(operationId)
    let parsed: { access_token?: unknown; refresh_token?: unknown }
    try {
      parsed = JSON.parse(token) as typeof parsed
    } catch {
      throw new DomainError('DRIVE_TOKEN_INVALID', 'Google did not return a usable Drive authorization.', 400)
    }
    if (!parsed || typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string') {
      throw new DomainError('DRIVE_TOKEN_INVALID', 'Google did not return a usable Drive authorization.', 400)
    }
    const binary = await this.install()
    const configPath = await this.configPath(binary)
    await this.systemctl(['show-environment'])
    const previousUnit = await this.ports.readText(this.unitPath)
    const wasMounted = await this.ports.mounted(this.mountPath)
    const staged = `${configPath}.${randomUUID()}.tmp`
    await this.ports.mkdir(dirname(configPath))
    const remote = `[${DRIVE_REMOTE}]\ntype = drive\nscope = drive.file\ntoken = ${JSON.stringify(parsed)}\n`
    try {
      await this.ports.writePrivate(staged, remote)
      const folder = await this.appFolder(binary, staged)
      const email = await this.account(remote)
      const replacement = `[${DRIVE_REMOTE}]\n${email ? `description = ${email}\n` : ''}`
        + `type = drive\nscope = drive.file\nroot_folder_id = ${folder}\ntoken = ${JSON.stringify(parsed)}\n`
      this.assertOperation(operationId)
      await this.switchMount({ binary, configPath, replacement, previousUnit, wasMounted, operationId })
    } finally {
      await this.ports.remove(staged)
    }
  }

  private async switchMount(input: {
    binary: string; configPath: string; replacement: string;
    previousUnit: string | null; wasMounted: boolean; operationId: string
  }) {
    this.assertOperation(input.operationId)
    if (input.previousUnit !== null || input.wasMounted) {
      await this.systemctl(['stop', UNIT])
      if (await this.ports.mounted(this.mountPath)) {
        throw new DomainError('DRIVE_MOUNT_FAILED', 'The previous Google Drive mount could not be stopped.', 502)
      }
    }
    // The running service may refresh its token while the replacement is being validated.
    const stoppedConfig = await this.ports.readText(input.configPath)
    try {
      const otherRemotes = withoutSection(stoppedConfig ?? '', DRIVE_REMOTE).trimEnd()
      this.assertOperation(input.operationId)
      await this.ports.writePrivate(input.configPath, `${otherRemotes}\n\n${input.replacement}`,
        { beforeCommit: () => this.assertOperation(input.operationId) })
      await this.ports.mkdir(this.mountPath)
      await this.ports.mkdir(dirname(this.unitPath))
      await this.ports.writePrivate(this.unitPath, this.unit(input.binary, input.configPath))
      await this.systemctl(['daemon-reload'])
      await this.systemctl(['enable', UNIT])
      this.assertOperation(input.operationId)
      await this.systemctl(['restart', UNIT])
      await this.waitForMount()
      this.assertOperation(input.operationId)
    } catch (error) {
      try {
        if (await this.ports.readText(this.unitPath) !== null) {
          await this.systemctl(['stop', UNIT])
          if (input.previousUnit === null) await this.systemctl(['disable', UNIT])
        }
        if (await this.ports.mounted(this.mountPath)) {
          throw new Error('The failed mount is still active.', { cause: error })
        }
        await this.restoreFile(input.configPath, stoppedConfig)
        await this.restoreFile(this.unitPath, input.previousUnit)
        await this.systemctl(['daemon-reload'])
        if (input.wasMounted) {
          await this.systemctl(['restart', UNIT])
          await this.waitForMount()
        }
      } catch {
        throw new DomainError('DRIVE_RESTORE_FAILED', 'Account switch failed and the previous Drive mount could not be restored. Check Drive on this computer.', 502)
      }
      throw error
    }
  }

  private async restoreFile(path: string, contents: string | null) {
    if (contents === null) await this.ports.remove(path)
    else await this.ports.writePrivate(path, contents)
  }

  private unit(binary: string, configPath: string): string {
    const quote = (value: string) => `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    return [
      '[Unit]', 'Description=Foreman Code Google Drive', 'After=network-online.target', '',
      '[Service]', 'Type=notify',
      `ExecStart=${quote(binary)} mount ${DRIVE_REMOTE}: ${quote(this.mountPath)} --config ${quote(configPath)} --vfs-cache-mode full --dir-cache-time 1000h --poll-interval 15s --attr-timeout 60s`,
      `ExecStop=/bin/fusermount3 -u ${quote(this.mountPath)}`, 'Restart=on-failure', 'RestartSec=10', '',
      '[Install]', 'WantedBy=default.target', '',
    ].join('\n')
  }

  private async waitForMount() {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await this.ports.mounted(this.mountPath)) return
      await this.ports.wait(1000)
    }
    throw new DomainError('DRIVE_MOUNT_FAILED', 'Google Drive did not mount. Check FUSE and the user service on this computer.', 502)
  }

  /** The app's Drive folder (created once by whichever computer connects first; visible to all of them). */
  private async appFolder(binary: string, configPath: string): Promise<string> {
    const find = async () => {
      const listed = await this.ports.run(binary, ['lsjson', `${DRIVE_REMOTE}:`, '--dirs-only', '--no-modtime', '--no-mimetype', '--config', configPath], { timeoutMs: 60_000 })
      if (listed.code !== 0) throw new DomainError('DRIVE_CONNECT_FAILED', `Google Drive could not be read: ${listed.stderr.trim().slice(-300)}`, 502)
      const folders = JSON.parse(listed.stdout) as { Name: string; ID?: string }[]
      const matches = folders.filter(item => item.Name === DRIVE_APP_FOLDER && item.ID)
      matches.sort((a, b) => a.ID!.localeCompare(b.ID!))
      return matches[0]?.ID
    }
    let id = await find()
    if (!id) {
      const made = await this.ports.run(binary, ['mkdir', `${DRIVE_REMOTE}:${DRIVE_APP_FOLDER}`, '--config', configPath], { timeoutMs: 60_000 })
      if (made.code !== 0) throw new DomainError('DRIVE_CONNECT_FAILED', `The app folder could not be created: ${made.stderr.trim().slice(-300)}`, 502)
      id = await find()
    }
    if (!id || !/^[A-Za-z0-9_-]{10,200}$/u.test(id)) throw new DomainError('DRIVE_CONNECT_FAILED', 'The app folder has no Drive ID.', 502)
    return id
  }

  private async disconnect(operationId: string) {
    this.assertOperation(operationId)
    const binary = await this.binary()
    const configPath = binary ? await this.configPath(binary) : null
    const config = configPath ? await this.ports.readText(configPath) : null
    const mounted = await this.ports.mounted(this.mountPath)
    if (!mounted && !sections(config ?? '').has(DRIVE_REMOTE) && await this.ports.readText(this.unitPath) === null) return
    this.assertOperation(operationId)
    const result = await this.ports.run('systemctl', ['--user', 'disable', '--now', UNIT], { timeoutMs: 60_000 })
    if (result.code !== 0 || await this.ports.mounted(this.mountPath)) {
      throw new DomainError('DRIVE_DISCONNECT_FAILED', 'Google Drive could not be unmounted. Its credentials have been kept; retry disconnect on this computer.', 502)
    }
    if (!configPath) {
      throw new DomainError('DRIVE_DISCONNECT_FAILED', 'Drive was stopped, but rclone is missing. Install rclone and retry to remove its credentials.', 502)
    }
    try {
      const stoppedConfig = await this.ports.readText(configPath)
      this.assertOperation(operationId)
      if (stoppedConfig !== null) await this.ports.writePrivate(configPath, withoutSection(stoppedConfig, DRIVE_REMOTE),
        { beforeCommit: () => this.assertOperation(operationId) })
    } catch (error) {
      if (this.operationId !== operationId && mounted) {
        await this.systemctl(['enable', UNIT])
        await this.systemctl(['restart', UNIT])
        await this.waitForMount()
      }
      throw error
    }
  }

  private async systemctl(args: string[]) {
    const result = await this.ports.run('systemctl', ['--user', ...args], { timeoutMs: 60_000 })
    if (result.code !== 0) throw new DomainError('DRIVE_MOUNT_FAILED', `The Drive service command failed: ${result.stderr.trim().slice(0, 300)}`, 502)
  }

  private async binary(): Promise<string | null> {
    for (const candidate of [this.rclone, '/usr/local/bin/rclone', '/usr/bin/rclone']) {
      if ((await this.ports.run(candidate, ['version'], { timeoutMs: 10_000 }).catch(() => ({ code: 1 }))).code === 0) return candidate
    }
    return null
  }
}

/** One setting of the app's remote in an rclone config. */
export function driveRemoteSetting(config: string, key: string): string | undefined {
  let inside = false
  for (const line of config.split('\n')) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header) { inside = header[1] === DRIVE_REMOTE; continue }
    const match = inside ? /^([a-z_]+)\s*=\s*(.*)$/u.exec(line) : null
    if (match?.[1] === key) return match[2]!.trim()
  }
  return undefined
}

/** INI section names in an rclone config. */
function sections(config: string) {
  return new Set([...config.matchAll(/^\[([^\]\n]+)\]\s*$/gmu)].map(match => match[1]!))
}
function withoutSection(config: string, name: string) {
  const lines = config.split('\n')
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header) skipping = header[1] === name
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}

export function systemDrivePorts(environment: NodeJS.ProcessEnv = process.env): DriveComputerPorts {
  return {
    home: environment.HOME ?? homedir(),
    arch: process.arch,
    run: (file, args, options = {}) => new Promise(resolve => {
      const child = execFile(file, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        env: { ...environment, NO_COLOR: '1' } }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, stdout, stderr })
      })
      if (options.input !== undefined) child.stdin?.end(options.input)
    }),
    fetch: async (url, headers) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000), ...(headers ? { headers } : {}) })
      if (!response.ok) throw new DomainError('DRIVE_INSTALL_FAILED', `Downloading rclone failed (${response.status}).`, 502)
      return Buffer.from(await response.arrayBuffer())
    },
    readText: async path => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    writePrivate: async (path, data, options) => {
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, data, { mode: 0o600 })
        options?.beforeCommit()
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    install: async (path, source) => {
      // The download cache may sit on another filesystem: copy beside the target, then rename atomically.
      const temporary = `${path}.${randomUUID()}.tmp`
      await copyFile(source, temporary)
      await chmod(temporary, 0o755)
      await rename(temporary, path)
    },
    mkdir: async path => { await mkdir(path, { recursive: true, mode: 0o700 }) },
    remove: path => rm(path, { recursive: true, force: true }),
    mounted: async path => (await readFile('/proc/self/mountinfo', 'utf8'))
      .split('\n').some(line => line.split(' ')[4]?.replaceAll('\\040', ' ') === path),
    wait: ms => new Promise(resolve => { setTimeout(resolve, ms) }),
  }
}
