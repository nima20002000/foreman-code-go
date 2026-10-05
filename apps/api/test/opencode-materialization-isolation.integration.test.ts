import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'vitest'
import { OpenCodeVaultIsolation } from '../src/modules/harnesses/opencodeFiles/isolation.js'

it('exposes only the native conversation owner materializations in each filesystem namespace', async () => {
  const root = await mkdtemp(join(homedir(), '.opencode-owner-isolation-'))
  const vault = join(root, 'vault')
  const managed = join(root, 'chat-files')
  const owners = ['conversation-a', 'conversation-b']
  try {
    await mkdir(vault, { mode: 0o700 })
    await writeFile(join(vault, 'private'), 'vault bytes')
    for (const owner of owners) {
      await mkdir(join(managed, owner), { recursive: true, mode: 0o700 })
      await writeFile(join(managed, owner, 'attachment.md'), owner)
    }
    for (const owner of owners) {
      const foreign = owners.find(value => value !== owner)!
      const isolation = new OpenCodeVaultIsolation(vault, { root: managed, owned: join(managed, owner) })
      const program = `
        const fs = require('node:fs')
        const [managed, owner, foreign, vault] = process.argv.slice(1)
        const denied = path => {
          try { fs.readFileSync(path); return false } catch (error) { return error.code === 'ENOENT' }
        }
        const deniedWrite = path => {
          try { fs.writeFileSync(path, 'changed'); return false } catch (error) { return error.code === 'ENOENT' }
        }
        fs.writeFileSync(managed + '/' + owner + '/output.md', owner)
        console.log(JSON.stringify({ owners: fs.readdirSync(managed),
          input: fs.readFileSync(managed + '/' + owner + '/attachment.md', 'utf8'),
          readDenied: denied(managed + '/' + foreign + '/attachment.md'),
          writeDenied: deniedWrite(managed + '/' + foreign + '/attachment.md'),
          vaultDenied: denied(vault + '/private') }))
      `
      const launch = await isolation.launch({ binary: process.execPath,
        args: ['-e', program, managed, owner, foreign, vault], workingDirectory: root, environment: process.env },
      AbortSignal.timeout(10_000))
      const result = await promisify(execFile)(launch.binary, launch.args, { cwd: root, env: process.env })
      isolation.observe(result.stdout)
      await isolation.assert(AbortSignal.timeout(10_000))
      assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)!), {
        owners: [owner], input: owner, readDenied: true, writeDenied: true, vaultDenied: true,
      })
      assert.equal(await readFile(join(managed, foreign, 'attachment.md'), 'utf8'), foreign)
      assert.equal(await readFile(join(managed, owner, 'output.md'), 'utf8'), owner)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
