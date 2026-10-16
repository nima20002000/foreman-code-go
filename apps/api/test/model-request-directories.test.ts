import { describe, expect, it } from 'vitest'
import { modelRequestDirectories } from './helpers/modelRequestDirectories.js'

const workerDirectory = '/fixture/worker-state'
const activeDirectory = `${workerDirectory}/native-codex-qualification-active`
const unusedDirectory = `${workerDirectory}/native-codex-qualification-unused`
const mainDirectory = '/fixture/main-runtime'
const modelCall = (workingDirectory: string) => ({ method: 'model/list', workingDirectory })

describe('Worker model request directories', () => {
  it('keeps waiting when Main and only one Worker profile have requested models', () => {
    const calls = [modelCall(mainDirectory), modelCall(activeDirectory)]

    expect(modelRequestDirectories(calls, workerDirectory)).toEqual([activeDirectory])

    calls.push(modelCall(unusedDirectory))
    expect(modelRequestDirectories(calls, workerDirectory)).toEqual([activeDirectory, unusedDirectory])
  })

  it.each(['before', 'between', 'after'] as const)(
    'selects both Worker checks with a Main request %s them', position => {
      const calls = [modelCall(activeDirectory), modelCall(unusedDirectory)]
      const index = { before: 0, between: 1, after: 2 }[position]
      calls.splice(index, 0, modelCall(mainDirectory))

      expect(modelRequestDirectories(calls, workerDirectory)).toEqual([activeDirectory, unusedDirectory])
    },
  )

  it('deduplicates model requests and excludes sibling directories and other methods', () => {
    const calls = [
      modelCall(activeDirectory),
      modelCall(activeDirectory),
      modelCall(`${workerDirectory}-other/native-codex-qualification-unused`),
      { method: 'thread/start', workingDirectory: unusedDirectory },
      modelCall(workerDirectory),
    ]

    expect(modelRequestDirectories(calls, workerDirectory)).toEqual([activeDirectory, workerDirectory])
  })
})
