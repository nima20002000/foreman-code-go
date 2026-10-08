import { createHash } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { describe, expect, it, vi } from 'vitest'
import { DriveComputer, type DriveComputerPorts } from './driveComputer.js'
import { ComputerDriveService, rcloneToken } from './drive.js'

vi.mock('./github.js', () => ({ assertCurrentComputer: async () => {} }))

const zip = Buffer.from('rclone release archive')
function computer(options: { checksum?: string; systemBinary?: boolean; fail?: string; configPath?: string; fuseFailure?: boolean; sharedFolders?: string[] } = {}) {
  const files = new Map<string, string | Buffer>([['/home/u/.config/rclone/rclone.conf', '[work]\ntype = s3\nprovider = AWS\n']])
  const mounts = new Set<string>()
  const commands: string[] = []
  const folders = options.sharedFolders ?? []
  const ports: DriveComputerPorts = {
    home: '/home/u', arch: 'x64',
    run: async (file, args) => {
      commands.push([file, ...args].join(' '))
      if (args[0] === 'config' && args[1] === 'file') {
        return { code: 0, stdout: `Configuration file is stored at:\n${options.configPath ?? '/home/u/.config/rclone/rclone.conf'}\n`, stderr: '' }
      }
      if (options.fail && args.includes(options.fail)) {
        if (options.fail === 'restart') delete options.fail
        return { code: 1, stdout: '', stderr: 'operation failed' }
      }
      if (options.systemBinary && file === '/usr/bin/rclone' && args[0] === 'version') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'version') return { code: files.has(file) ? 0 : 1, stdout: '', stderr: '' }
      if (file === 'unzip') { files.set('/home/u/.cache/foreman-code/rclone-v1.75.1-linux-amd64/rclone', 'binary'); return { code: 0, stdout: '', stderr: '' } }
      if (args[0] === 'config' && args[1] === 'userinfo') return { code: 1, stdout: '', stderr: "Google drive root '' doesn't support UserInfo" }
      if (args[0] === 'lsjson') return { code: 0, stdout: folders.length ? JSON.stringify([{ Name: 'Foreman Code', ID: folders[0] }, { Name: 'Other', ID: 'other-folder-1234' }]) : '[]', stderr: '' }
      if (args[0] === 'mkdir') { folders.push('appfolder-1234567'); return { code: 0, stdout: '', stderr: '' } }
      if (file === 'systemctl' && args.includes('stop')) mounts.clear()
      if (file === 'systemctl' && args.includes('restart') && !options.fuseFailure) mounts.add('/home/u/Foreman Code Drive')
      if (file === 'systemctl' && args.includes('disable')) mounts.clear()
      return { code: 0, stdout: '', stderr: '' }
    },
    fetch: async (url, headers) => url.startsWith('https://www.googleapis.com/drive/v3/about')
      ? Buffer.from(headers?.authorization === 'Bearer a' || headers?.authorization === 'Bearer b' ? '{"user":{"emailAddress":"owner@gmail.com"}}' : '{}')
      : url.endsWith('version.txt') ? Buffer.from('rclone v1.75.1\n')
      : url.endsWith('SHA256SUMS') ? Buffer.from(`${options.checksum ?? createHash('sha256').update(zip).digest('hex')}  rclone-v1.75.1-linux-amd64.zip\n`)
        : zip,
    readText: async path => { const value = files.get(path); return value === undefined ? null : value.toString() },
    writePrivate: async (path, data) => { files.set(path, data) },
    install: async (path, source) => { files.set(path, files.get(source)!); files.delete(source) },
    mkdir: async () => {},
    remove: async path => { for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key) },
    mounted: async path => mounts.has(path),
    wait: async () => {},
  }
  return { drive: new DriveComputer(ports), files, commands, mounts, ports, options }
}

describe('Google Drive on one computer', () => {
  it('installs a checksum-verified rclone, connects the app remote beside existing remotes and mounts it', async () => {
    const { drive, files, commands } = computer()
    const state = await drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r","expiry":"2026-10-07T00:00:00Z"}' })
    expect(state).toEqual({ installed: true, connected: true, account: 'owner@gmail.com', mountPath: '/home/u/Foreman Code Drive',
      mounted: true, message: null })
    expect(files.get('/home/u/.local/bin/rclone')).toBe('binary')
    const config = files.get('/home/u/.config/rclone/rclone.conf')!.toString()
    expect(config).toContain('[work]\ntype = s3')
    // Only files the app creates, rooted at the one app folder it made on first connect.
    expect(config).toContain('[foreman-drive]\ndescription = owner@gmail.com\ntype = drive\nscope = drive.file\nroot_folder_id = appfolder-1234567\ntoken = {"access_token":"a","refresh_token":"r","expiry":"2026-10-07T00:00:00Z"}')
    expect(commands.filter(command => command.includes(' mkdir '))).toEqual([
      expect.stringMatching(/^\/home\/u\/\.local\/bin\/rclone mkdir foreman-drive:Foreman Code --config \/home\/u\/\.config\/rclone\/rclone\.conf\.[\w-]+\.tmp$/u),
    ])
    // A second computer finds the same folder instead of creating another.
    await drive.handle({ operation: 'connect', token: '{"access_token":"b","refresh_token":"s"}' })
    expect(commands.filter(command => command.includes(' mkdir '))).toHaveLength(1)
    expect(files.get('/home/u/.config/systemd/user/foreman-drive.service')!.toString())
      .toContain('ExecStart="/home/u/.local/bin/rclone" mount foreman-drive: "/home/u/Foreman Code Drive"')
    expect(commands).toContain('systemctl --user enable foreman-drive.service')

    const disconnected = await drive.handle({ operation: 'disconnect' })
    expect(disconnected).toMatchObject({ connected: false, mounted: false, account: null })
    expect(files.get('/home/u/.config/rclone/rclone.conf')!.toString()).toBe('[work]\ntype = s3\nprovider = AWS\n')
  })

  it('refuses an rclone download that does not match its published checksum', async () => {
    const { drive, files } = computer({ checksum: '0'.repeat(64) })
    await expect(drive.handle({ operation: 'install' })).rejects.toMatchObject({ code: 'DRIVE_INSTALL_FAILED' })
    expect(files.has('/home/u/.local/bin/rclone')).toBe(false)
  })

  it('rejects an authorization without Drive tokens', async () => {
    const { drive } = computer()
    await expect(drive.handle({ operation: 'connect', token: '{"error":"denied"}' })).rejects.toMatchObject({ code: 'DRIVE_TOKEN_INVALID' })
  })

  it('keeps credentials and reports a failed service stop instead of claiming disconnection', async () => {
    const f = computer()
    await f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' })
    f.options.fail = 'disable'
    await expect(f.drive.handle({ operation: 'disconnect' })).rejects.toMatchObject({ code: 'DRIVE_DISCONNECT_FAILED' })
    expect(await f.drive.status()).toMatchObject({ connected: true, mounted: true })
  })

  it('reports a mount even when its remote config is missing', async () => {
    const f = computer()
    f.mounts.add('/home/u/Foreman Code Drive')
    expect(await f.drive.status()).toMatchObject({ connected: false, mounted: true, mountPath: '/home/u/Foreman Code Drive' })
  })

  it.each(['lsjson', 'restart'])('restores the previous account and mount after a failed switch at %s', async fail => {
    const f = computer()
    await f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' })
    const previous = f.files.get('/home/u/.config/rclone/rclone.conf')
    f.options.fail = fail
    await expect(f.drive.handle({ operation: 'connect', token: '{"access_token":"b","refresh_token":"s"}' })).rejects.toThrow()
    expect(f.files.get('/home/u/.config/rclone/rclone.conf')).toEqual(previous)
    expect(f.mounts.has('/home/u/Foreman Code Drive')).toBe(true)
  })

  it('preserves configuration when user systemd is unavailable', async () => {
    const f = computer({ fail: 'show-environment' })
    const config = f.files.get('/home/u/.config/rclone/rclone.conf')
    await expect(f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' }))
      .rejects.toMatchObject({ code: 'DRIVE_MOUNT_FAILED' })
    expect(f.files.get('/home/u/.config/rclone/rclone.conf')).toEqual(config)
  })

  it('removes a failed first connection when FUSE never mounts', async () => {
    const f = computer({ fuseFailure: true })
    const config = f.files.get('/home/u/.config/rclone/rclone.conf')
    await expect(f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' }))
      .rejects.toMatchObject({ code: 'DRIVE_MOUNT_FAILED' })
    expect(await f.drive.status()).toMatchObject({ connected: false, mounted: false })
    expect(f.files.get('/home/u/.config/rclone/rclone.conf')).toEqual(config)
  })

  it('serializes overlapping connect, status and disconnect writes without losing other remotes', async () => {
    const f = computer()
    const connect = f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' })
    const status = f.drive.status()
    const disconnect = f.drive.handle({ operation: 'disconnect' })
    expect(await connect).toMatchObject({ connected: true, mounted: true })
    expect(await status).toMatchObject({ connected: true, mounted: true })
    expect(await disconnect).toMatchObject({ connected: false, mounted: false })
    expect(f.files.get('/home/u/.config/rclone/rclone.conf')).toBe('[work]\ntype = s3\nprovider = AWS\n')
  })

  it('does not claim success when stopping succeeds but the mount stays active', async () => {
    const f = computer()
    await f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' })
    const config = f.files.get('/home/u/.config/rclone/rclone.conf')
    const run = f.ports.run
    f.ports.run = async (file, args, options) => args.includes('disable')
      ? { code: 0, stdout: '', stderr: '' } : run(file, args, options)
    await expect(f.drive.handle({ operation: 'disconnect' })).rejects.toMatchObject({ code: 'DRIVE_DISCONNECT_FAILED' })
    expect(await f.drive.status()).toMatchObject({ connected: true, mounted: true })
    expect(f.files.get('/home/u/.config/rclone/rclone.conf')).toEqual(config)
  })

  it('treats an already disconnected computer without a user service as disconnected', async () => {
    const f = computer({ systemBinary: true, fail: 'disable' })
    expect(await f.drive.handle({ operation: 'disconnect' })).toMatchObject({ connected: false, mounted: false })
  })

  it('roots two simultaneous first connections at the same shared folder', async () => {
    const sharedFolders: string[] = []
    const main = computer({ sharedFolders })
    const worker = computer({ sharedFolders })
    const mainId = '11111111-1111-4111-8111-111111111111'
    const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }
    const workerTarget = { hostRef: { kind: 'device' as const, mainId, deviceId: '22222222-2222-4222-8222-222222222222' },
      applicationInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1 }
    const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z',
      revokedAt: null, grants: [{ actions: ['settings:update'], scope: {} }] }
    const service = new ComputerDriveService({} as pg.Pool, mainId, () => ({
      capabilities: () => [{ namespace: 'computer-drive-v1', mainCanRequest: true }],
      request: async (_device, _namespace, payload) => ({ payload: await worker.drive.handle(payload) }),
    }), { recordAudit: async () => {}, recordDenied: async () => {} } as unknown as PostgresCommandCoordinator, { local: main.drive })
    const a = await service.connectStart(owner, 'http', mainTarget)
    const b = await service.connectStart(owner, 'http', workerTarget)
    await Promise.all([
      service.connectComplete(owner, 'http', mainTarget, a.loginId!, '{"access_token":"a","refresh_token":"r"}'),
      service.connectComplete(owner, 'http', workerTarget, b.loginId!, '{"access_token":"a","refresh_token":"r"}'),
    ])
    expect(sharedFolders).toEqual(['appfolder-1234567'])
    for (const f of [main, worker]) {
      expect(f.files.get('/home/u/.config/rclone/rclone.conf')?.toString()).toContain('root_folder_id = appfolder-1234567')
    }
  })

  it('preserves configuration updates made by the service while it is stopping', async () => {
    const f = computer()
    await f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' })
    const path = '/home/u/.config/rclone/rclone.conf'
    const run = f.ports.run
    f.ports.run = async (file, args, options) => {
      if (args.includes('disable')) {
        f.files.set(path, f.files.get(path)!.toString().replace('provider = AWS', 'provider = Updated'))
      }
      return run(file, args, options)
    }
    await f.drive.handle({ operation: 'disconnect' })
    expect(f.files.get(path)).toBe('[work]\ntype = s3\nprovider = Updated\n')
  })

  it('returns the installed system executable for authorization', async () => {
    const f = computer({ systemBinary: true })
    expect(await f.drive.install()).toBe('/usr/bin/rclone')
  })

  it('reads and changes the configured rclone path and passes it to the mount service', async () => {
    const f = computer({ systemBinary: true, configPath: '/home/u/custom/rclone.conf' })
    f.files.set('/home/u/custom/rclone.conf', '[work]\ntype = s3\n')
    await f.drive.handle({ operation: 'connect', token: '{"access_token":"a","refresh_token":"r"}' })
    expect(f.files.get('/home/u/custom/rclone.conf')?.toString()).toContain('[work]\ntype = s3')
    expect(f.files.get('/home/u/custom/rclone.conf')?.toString()).toContain('[foreman-drive]')
    expect(f.files.get('/home/u/.config/systemd/user/foreman-drive.service')?.toString())
      .toContain('--config "/home/u/custom/rclone.conf"')
    await f.drive.handle({ operation: 'disconnect' })
    expect(f.files.get('/home/u/custom/rclone.conf')).toBe('[work]\ntype = s3\n')
  })
})

describe('rclone authorization output', () => {
  const token = '{"access_token":"a","token_type":"Bearer","refresh_token":"r","expiry":"2026-10-07T00:00:00Z"}'
  it('reads plain JSON and the base64url blob rclone prints for a scoped sign-in', () => {
    expect(rcloneToken(token)).toBe(JSON.stringify(JSON.parse(token)))
    expect(rcloneToken(Buffer.from(JSON.stringify({ token })).toString('base64url'))).toBe(token)
    expect(rcloneToken('not a token')).toBeUndefined()
  })
})
