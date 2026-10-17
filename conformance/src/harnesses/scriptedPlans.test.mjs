import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import scriptedPlans from '../../fixtures/harnesses/scripted-plans.cjs'

const { selectTurnScript } = scriptedPlans
const directories = []

async function install(scripts) {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-native-selectors-'))
  directories.push(directory)
  await writeFile(join(directory, 'turn-scripts.json'), JSON.stringify({ scripts }), { mode: 0o600, flag: 'wx' })
  return directory
}

describe('scripted native prompt selection', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('distinguishes a graph task from a fresh interval prompt containing the same task', async () => {
    const graph = { id: 'graph', includes: 'Owned graph task', excludes: ['Owned loop check'],
      turns: [{ answer: 'Graph result' }] }
    const check = { id: 'check', includes: 'Owned loop check',
      turns: [{ answer: 'First check' }, { answer: 'Second check' }] }
    const directory = await install([graph, check])
    expect(selectTurnScript(directory, 'Your task in this workflow: Owned graph task')).toEqual({ answer: 'Graph result' })
    const prompt = 'Your task in this workflow: Owned graph task\nEach loop: Owned loop check'
    expect(selectTurnScript(directory, prompt)).toEqual({ answer: 'First check' })
    expect(selectTurnScript(directory, prompt)).toEqual({ answer: 'Second check' })
  })

  it('keeps ambiguous inclusive selectors as a native failure', async () => {
    const directory = await install([
      { id: 'first', includes: 'Owned task', turns: [{ answer: 'First' }] },
      { id: 'second', includes: 'task', turns: [{ answer: 'Second' }] },
    ])
    expect(() => selectTurnScript(directory, 'Owned task')).toThrow('Multiple native scripts match')
  })

  it('rejects invalid exclusions before choosing a scripted outcome', async () => {
    const directory = await install([
      { id: 'invalid', includes: 'Owned task', excludes: [''], turns: [{ answer: 'Must not run' }] },
    ])
    expect(() => selectTurnScript(directory, 'Owned task')).toThrow('exclusions')
  })
})
