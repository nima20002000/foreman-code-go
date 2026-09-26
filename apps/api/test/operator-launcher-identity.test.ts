import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installManagedLauncher, isManagedLauncherCommand, isOperatorLauncher, operatorLauncherPath, OPERATOR_TOKEN } from '../src/modules/harnesses/operatorMcpLauncher.js'

const runtime = process.execPath
const directories: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'execPath', { value: runtime })
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-launcher-identity-'))
  directories.push(directory)
  const source = join(directory, 'source.mjs')
  await writeFile(source, '// launcher')
  const nodeA = join(directory, 'node-a')
  const nodeB = join(directory, 'node-b')
  await writeFile(nodeA, 'runtime A')
  await writeFile(nodeB, 'runtime B')
  return { launcher: join(directory, 'launcher.mjs'), source: pathToFileURL(source), nodeA, nodeB, directory }
}

describe('managed launcher installation identity', () => {
  it('recognizes the installed runtime after an API runtime change and preserves both installations', async () => {
    const { launcher, source, nodeA, nodeB } = await fixture()
    Object.defineProperty(process, 'execPath', { value: nodeA })
    await installManagedLauncher(source, launcher)
    Object.defineProperty(process, 'execPath', { value: nodeB })
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
    await installManagedLauncher(source, launcher)
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
    expect(isManagedLauncherCommand([nodeB, launcher], launcher)).toBe(true)
    expect(JSON.parse(await readFile(`${launcher}.installation.json`, 'utf8')).executables).toHaveLength(2)
    await rm(nodeA)
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(false)
  })

  it('does not trust custom executables, changed symlink targets or extra arguments', async () => {
    const { launcher, source, nodeA, nodeB, directory } = await fixture()
    const installed = join(directory, 'node')
    await symlink(nodeA, installed)
    Object.defineProperty(process, 'execPath', { value: installed })
    await installManagedLauncher(source, launcher)
    Object.defineProperty(process, 'execPath', { value: nodeB })
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(false)
    expect(isManagedLauncherCommand([installed, launcher, '--custom'], launcher)).toBe(false)
    await rm(installed)
    const attacker = join(directory, 'attacker')
    await writeFile(attacker, 'custom executable')
    await symlink(attacker, installed)
    expect(isManagedLauncherCommand([installed, launcher], launcher)).toBe(false)
  })

  it('migrates a legacy current-runtime install and recognizes its canonical alias', async () => {
    const { launcher, source, nodeA, nodeB, directory } = await fixture()
    Object.defineProperty(process, 'execPath', { value: nodeA })
    const alias = join(directory, 'alias')
    await symlink(nodeA, alias)
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
    expect(isManagedLauncherCommand([alias, launcher], launcher)).toBe(true)
    expect(isManagedLauncherCommand([nodeB, launcher], launcher)).toBe(false)
    await installManagedLauncher(source, launcher)
    Object.defineProperty(process, 'execPath', { value: nodeB })
    expect(isManagedLauncherCommand([nodeA, launcher], launcher)).toBe(true)
  })

  it.each(['codex', 'opencode'] as const)('retains %s command and authentication restrictions', (harness) => {
    const entry = harness === 'codex'
      ? { command: process.execPath, args: [operatorLauncherPath()], env_vars: [OPERATOR_TOKEN] }
      : { type: 'local', command: [process.execPath, operatorLauncherPath()], environment: { [OPERATOR_TOKEN]: `{env:${OPERATOR_TOKEN}}` } }
    expect(isOperatorLauncher(harness, entry)).toBe(true)
    expect(isOperatorLauncher(harness, { ...entry, url: 'https://custom.invalid' })).toBe(false)
    expect(isOperatorLauncher(harness, { ...entry, bearer_token_env_var: 'CUSTOM' })).toBe(false)
    expect(isOperatorLauncher(harness, { ...entry, headers: { Authorization: 'custom' } })).toBe(false)
    expect(isOperatorLauncher(harness, { ...entry, oauth: true })).toBe(false)
    expect(isOperatorLauncher(harness, harness === 'codex'
      ? { ...entry, env: { CUSTOM: 'value' } }
      : { ...entry, environment: { [OPERATOR_TOKEN]: 'resolved', CUSTOM: 'value' } })).toBe(false)
  })
})
