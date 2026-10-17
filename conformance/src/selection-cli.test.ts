import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDirectory = fileURLToPath(new URL('../', import.meta.url))

async function listSelection(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/main.ts', '--list', ...args], {
      cwd: packageDirectory,
      env: { ...process.env, CONFORMANCE_TARGET: 'ts' },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || typeof error.code !== 'number') { reject(error); return }
        resolve({ exitCode: error.code, stdout, stderr })
        return
      }
      resolve({ exitCode: 0, stdout, stderr })
    })
  })
}

describe('conformance inventory CLI selection', () => {
  it('fails a mixed known and unknown explicit selection before presenting a partial inventory', async () => {
    const result = await listSelection(['--scenario', 'health.live', '--scenario', 'health.lvie'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ kind: 'conformance-startup-error', error: {
      name: 'ScenarioSelectionError',
      message: 'Every requested scenario ID must match the selected scope',
      details: {
        requestedScenarioIds: ['health.live', 'health.lvie'], selectedScenarioIds: ['health.live'],
        unknownScenarioIds: ['health.lvie'], excludedScenarioIds: [],
      },
    } })
  }, 20_000)

  it('fails when a lane filter excludes one of the explicitly requested IDs', async () => {
    const result = await listSelection(['--lane', 'A2', '--scenario', 'health.live'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ kind: 'conformance-startup-error', error: {
      name: 'ScenarioSelectionError',
      message: 'Every requested scenario ID must match the selected scope',
      details: {
        requestedScenarioIds: ['health.live'], selectedScenarioIds: [],
        unknownScenarioIds: [], excludedScenarioIds: ['health.live'],
      },
    } })
  }, 20_000)
})
