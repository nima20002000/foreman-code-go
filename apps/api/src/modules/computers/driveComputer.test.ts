import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DriveComputer, type DriveComputerPorts } from './driveComputer.js'

const zip = Buffer.from('rclone release archive')
function computer(options: { checksum?: string } = {}) {
  const files = new Map<string, string | Buffer>([['/home/u/.config/rclone/rclone.conf', '[work]\ntype = s3\nprovider = AWS\n']])
  const mounts = new Set<string>()
  const commands: string[] = []
  const folders: string[] = []
  const ports: DriveComputerPorts = {
    home: '/home/u', arch: 'x64',
    run: async (file, args) => {
      commands.push([file, ...args].join(' '))
      if (args[0] === 'version') return { code: files.has(file) ? 0 : 1, stdout: '', stderr: '' }
      if (file === 'unzip') { files.set('/home/u/.cache/foreman-code/rclone-v1.75.1-linux-amd64/rclone', 'binary'); return { code: 0, stdout: '', stderr: '' } }
      if (args[0] === 'config' && args[1] === 'userinfo') return { code: 0, stdout: '{"Email":"owner@gmail.com"}', stderr: '' }
      if (args[0] === 'lsjson') return { code: 0, stdout: folders.length ? JSON.stringify([{ Name: 'Foreman Code', ID: folders[0] }, { Name: 'Other', ID: 'other-folder-1234' }]) : '[]', stderr: '' }
      if (args[0] === 'mkdir') { folders.push('appfolder-1234567'); return { code: 0, stdout: '', stderr: '' } }
      if (file === 'systemctl' && args.includes('restart')) mounts.add('/home/u/Foreman Code Drive')
      if (file === 'systemctl' && args.includes('disable')) mounts.clear()
      return { code: 0, stdout: '', stderr: '' }
    },
    fetch: async url => url.endsWith('version.txt') ? Buffer.from('rclone v1.75.1\n')
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
  return { drive: new DriveComputer(ports), files, commands }
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
    expect(config).toContain('[foreman-drive]\ntype = drive\nscope = drive.file\nroot_folder_id = appfolder-1234567\ntoken = {"access_token":"a","refresh_token":"r","expiry":"2026-10-07T00:00:00Z"}')
    expect(commands.filter(command => command.includes(' mkdir '))).toEqual(['/home/u/.local/bin/rclone mkdir foreman-drive:Foreman Code'])
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
})
