import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'
import { publishRestartUnit } from './helpers/installedRestartService.js'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './helpers/privateFixtureDirectory.js'
import { settleTestResources } from '../../../scripts/test-resources.mjs'
import { readUntil } from './helpers/observableCondition.js'

const execute = promisify(execFile)
const user = userInfo()
const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], { env: {
  ...process.env, XDG_RUNTIME_DIR: `/run/user/${user.uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${user.uid}/bus`,
}, timeout: 15_000 })

async function restartUnit(directory: string, state: 'active' | 'failed') {
  const unit = `graphql-restart-${randomUUID()}.service`
  const unitPath = join(user.homedir, '.config/systemd/user', unit)
  const script = join(directory, 'service.mjs')
  await writeFile(script, state === 'failed' ? 'process.exit(1)' : 'setInterval(() => {}, 1000)')
  await publishRestartUnit(unitPath, `[Service]
Type=exec
WorkingDirectory=${directory}
ExecStart=${process.execPath} ${script}
Restart=no
KillMode=process
[Install]
WantedBy=default.target
`)
  return { unit, unitPath }
}

async function removeRestartUnit(unit: string, unitPath: string) {
  const errors: unknown[] = []
  for (const operation of ['stop', 'disable', 'reset-failed']) {
    try { await systemctl(operation, unit) }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr)
      if (!/not loaded|does not exist|not found/.test(stderr)) errors.push(error)
    }
  }
  await rm(unitPath, { force: true })
  await systemctl('daemon-reload')
  if (errors.length) throw new AggregateError(errors, 'Regression fixture unit cleanup failed.')
}

async function expectRemovedUnit(unit: string, unitPath: string, pid: number) {
  const state = await systemctl('show', unit, '--property=ActiveState', '--property=LoadState', '--property=MainPID')
  expect(state.stdout).toContain('ActiveState=inactive')
  expect(state.stdout).toContain('LoadState=not-found')
  expect(state.stdout).toContain('MainPID=0')
  await expect(systemctl('is-enabled', unit)).rejects.toBeDefined()
  await expect(access(unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
  if (pid > 0) expect(() => process.kill(pid, 0)).toThrow()
}

describe('installed Main-local workflows across systemd restart', () => {
  it.each([false, true])('removes its restart unit when the fixture body throws (failed unit: %s)', async failed => {
    const created: { service?: Awaited<ReturnType<typeof restartUnit>>; pid: number } = { pid: 0 }
    const failure = new Error('Fixture body failed')
    try {
      await expect(withPrivateFixtureDirectories(async () => {
        const directory = await privateFixtureDirectory('restart-cleanup-')
        created.service = await restartUnit(directory, failed ? 'failed' : 'active')
        await systemctl('daemon-reload')
        await systemctl('enable', created.service.unit)
        await systemctl('start', created.service.unit)
        await readUntil(async () => (await systemctl('show', created.service!.unit, '--property=ActiveState', '--value'))
          .stdout.trim(), state => state === (failed ? 'failed' : 'active'),
        { timeoutMs: 10_000, description: 'regression fixture service state' })
        created.pid = Number((await systemctl('show', created.service.unit, '--property=MainPID', '--value')).stdout.trim())
        throw failure
      })).rejects.toBe(failure)
      expect(created.service).toBeDefined()
      await expectRemovedUnit(created.service!.unit, created.service!.unitPath, created.pid)
    } finally {
      if (created.service) await removeRestartUnit(created.service.unit, created.service.unitPath)
    }
  }, 60_000)

  it('sweeps a restart unit left by an interrupted test before settling run resources', async () => {
    const directory = await privateFixtureDirectory('restart-interrupted-')
    const service = await restartUnit(directory, 'active')
    try {
      await systemctl('daemon-reload')
      await systemctl('enable', service.unit)
      await systemctl('start', service.unit)
      const pid = Number((await systemctl('show', service.unit, '--property=MainPID', '--value')).stdout.trim())
      await settleTestResources({ query: async () => { throw new Error('No fixture databases need settling') } }, {
        directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER!,
      })
      await expectRemovedUnit(service.unit, service.unitPath, pid)
    } finally {
      await removeRestartUnit(service.unit, service.unitPath)
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('publishes the restart service when its configuration directory does not exist', async () => {
    const directory = await privateFixtureDirectory('restart-unit-')
    try {
      const unit = join(directory, '.config/systemd/user/restart.service')
      const service = '[Service]\nExecStart=/usr/bin/true\n'
      await publishRestartUnit(unit, service)
      expect(await readFile(unit, 'utf8')).toBe(service)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reattaches graph work and its writable source check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('writable source')
  }, 600_000)
})
