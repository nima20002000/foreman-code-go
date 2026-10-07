import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DRIVE_MOUNT_DIRECTORY, DRIVE_REMOTE, DriveComputerRequestSchema, DriveComputerStateSchema,
  type DriveComputerState } from '@foreman-code/contracts/computer-accounts'
import { DomainError } from '../errors.js'

const UNIT = 'foreman-drive.service'
const RELEASES = 'https://downloads.rclone.org'

export interface DriveComputerPorts {
  home: string
  arch: string
  run(file: string, args: string[], options?: { input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>
  fetch(url: string): Promise<Buffer>
  readText(path: string): Promise<string | null>
  writePrivate(path: string, data: string | Buffer): Promise<void>
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
  constructor(private readonly ports: DriveComputerPorts = systemDrivePorts()) {}

  get rclone() { return join(this.ports.home, '.local', 'bin', 'rclone') }
  get mountPath() { return join(this.ports.home, DRIVE_MOUNT_DIRECTORY) }
  private get config() { return join(this.ports.home, '.config', 'rclone', 'rclone.conf') }

  async handle(raw: unknown): Promise<DriveComputerState> {
    const request = DriveComputerRequestSchema.parse(raw)
    if (request.operation === 'install') await this.install()
    if (request.operation === 'connect') await this.connect(request.token)
    if (request.operation === 'disconnect') await this.disconnect()
    return this.status()
  }

  async status(message: string | null = null): Promise<DriveComputerState> {
    const binary = await this.binary()
    const connected = binary !== null && sections(await this.ports.readText(this.config) ?? '').has(DRIVE_REMOTE)
    let account: string | null = null
    if (connected) {
      const info = await this.ports.run(binary, ['config', 'userinfo', `${DRIVE_REMOTE}:`, '--json'], { timeoutMs: 20_000 })
      try { const email = (JSON.parse(info.stdout) as { Email?: unknown }).Email; if (typeof email === 'string') account = email.slice(0, 320) }
      catch { account = null }
    }
    const mounted = connected && await this.ports.mounted(this.mountPath)
    return DriveComputerStateSchema.parse({ installed: binary !== null, connected, account,
      mountPath: connected ? this.mountPath : null, mounted, message })
  }

  /** rclone already on PATH is used as is; otherwise the current release is installed for this user, checksum-verified. */
  async install() {
    if (await this.binary()) return
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
  }

  private async connect(token: string) {
    const parsed = JSON.parse(token) as { access_token?: unknown; refresh_token?: unknown }
    if (typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string') {
      throw new DomainError('DRIVE_TOKEN_INVALID', 'Google did not return a usable Drive authorization.', 400)
    }
    await this.install()
    const config = await this.ports.readText(this.config) ?? ''
    await this.ports.mkdir(join(this.ports.home, '.config', 'rclone'))
    await this.ports.writePrivate(this.config, `${withoutSection(config, DRIVE_REMOTE).trimEnd()}\n\n[${DRIVE_REMOTE}]\ntype = drive\nscope = drive\ntoken = ${JSON.stringify(parsed)}\n`)
    await this.ports.mkdir(this.mountPath)
    await this.ports.mkdir(join(this.ports.home, '.config', 'systemd', 'user'))
    await this.ports.writePrivate(join(this.ports.home, '.config', 'systemd', 'user', UNIT), [
      '[Unit]', 'Description=Foreman Code Google Drive', 'After=network-online.target', '',
      '[Service]', 'Type=notify',
      `ExecStart="${await this.binary()}" mount ${DRIVE_REMOTE}: "${this.mountPath}" --vfs-cache-mode full --dir-cache-time 30s --poll-interval 15s`,
      `ExecStop=/bin/fusermount3 -uz "${this.mountPath}"`, 'Restart=on-failure', 'RestartSec=10', '',
      '[Install]', 'WantedBy=default.target', ''].join('\n'))
    await this.systemctl(['daemon-reload'])
    await this.systemctl(['enable', UNIT])
    await this.systemctl(['restart', UNIT])
    for (let attempt = 0; attempt < 30 && !await this.ports.mounted(this.mountPath); attempt++) await this.ports.wait(1000)
    if (!await this.ports.mounted(this.mountPath)) throw new DomainError('DRIVE_MOUNT_FAILED', 'Google Drive is connected but did not mount.', 502)
  }

  private async disconnect() {
    await this.ports.run('systemctl', ['--user', 'disable', '--now', UNIT])
    const config = await this.ports.readText(this.config)
    if (config !== null) await this.ports.writePrivate(this.config, withoutSection(config, DRIVE_REMOTE))
  }

  private async systemctl(args: string[]) {
    const result = await this.ports.run('systemctl', ['--user', ...args], { timeoutMs: 60_000 })
    if (result.code !== 0) throw new DomainError('DRIVE_MOUNT_FAILED', `The Drive service could not start: ${result.stderr.trim().slice(0, 300)}`, 502)
  }

  private async binary(): Promise<string | null> {
    for (const candidate of [this.rclone, '/usr/local/bin/rclone', '/usr/bin/rclone']) {
      if ((await this.ports.run(candidate, ['version'], { timeoutMs: 10_000 }).catch(() => ({ code: 1 }))).code === 0) return candidate
    }
    return null
  }
}

/** INI section names in an rclone config. */
function sections(config: string) {
  return new Set([...config.matchAll(/^\[([^\]\n]+)\]\s*$/gmu)].map(match => match[1]!))
}
function withoutSection(config: string, name: string) {
  const lines = config.split('\n'), kept: string[] = []
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
    fetch: async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok) throw new DomainError('DRIVE_INSTALL_FAILED', `Downloading rclone failed (${response.status}).`, 502)
      return Buffer.from(await response.arrayBuffer())
    },
    readText: path => readFile(path, 'utf8').catch(() => null),
    writePrivate: async (path, data) => {
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, path)
    },
    install: async (path, source) => {
      await chmod(source, 0o755)
      await rename(source, path)
    },
    mkdir: async path => { await mkdir(path, { recursive: true, mode: 0o700 }) },
    remove: path => rm(path, { recursive: true, force: true }),
    mounted: async path => (await readFile('/proc/self/mountinfo', 'utf8').catch(() => ''))
      .split('\n').some(line => line.split(' ')[4]?.replaceAll('\\040', ' ') === path),
    wait: ms => new Promise(resolve => { setTimeout(resolve, ms) }),
  }
}
