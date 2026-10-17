// go test -json emits interleaved package/test events and, since Go 1.24, build events.
// Package records are real package directories: the stream does not identify test source files.
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const terminals = new Set(['pass', 'fail', 'skip'])
const actions = new Set(['start', 'run', 'pause', 'cont', 'output', 'bench', ...terminals])
const statuses = { pass: 'passed', fail: 'failed', skip: 'skipped' }
const diagnosticLimit = 64 * 1024

function packageDirectory(name, modulePath) {
  if (name === modulePath) return 'backend'
  if (!name.startsWith(`${modulePath}/`)) throw new Error(`Go test package ${name} is outside module ${modulePath}.`)
  const suffix = name.slice(modulePath.length + 1)
  if (suffix.split('/').some(part => !part || part === '.' || part === '..') || suffix.includes('\\')) {
    throw new Error(`Invalid Go test package ${name}.`)
  }
  return `backend/${suffix}`
}

function elapsedMilliseconds(event, start) {
  if (event.Elapsed !== undefined) return event.Elapsed * 1000
  if (start && event.Time) return Math.max(0, Date.parse(event.Time) - Date.parse(start))
  return null
}

function validateEvent(event, line) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.Action !== 'string') {
    throw new Error(`Invalid Go JSON event on line ${line}.`)
  }
  for (const key of ['Package', 'ImportPath', 'Test', 'Output', 'OutputType', 'FailedBuild']) {
    if (event[key] !== undefined && typeof event[key] !== 'string') throw new Error(`Invalid Go ${key} on line ${line}.`)
  }
  if (event.Elapsed !== undefined && (!Number.isFinite(event.Elapsed) || !Number.isFinite(event.Elapsed * 1000) || event.Elapsed < 0)) {
    throw new Error(`Invalid Go elapsed seconds on line ${line}.`)
  }
  if (event.Time !== undefined && (typeof event.Time !== 'string' || !Number.isFinite(Date.parse(event.Time)))) {
    throw new Error(`Invalid Go timestamp on line ${line}.`)
  }
}

function failureOutput(output, directory, repository) {
  // Go's testing package reports paths relative to the package under test. Preserve the reported
  // line/column instead of inventing a column for the usual file.go:line diagnostic.
  return output.replace(/(^|\s)([^\s:]+\.go):(\d+)(?::(\d+))?/g, (match, space, file, line, column) => {
    const path = resolve(repository, directory, file)
    const local = relative(repository, path)
    if (local.startsWith('..') || isAbsolute(local)) return match
    return `${space}${path}:${line}${column ? `:${column}` : ''}`
  }).trim()
}

function appendDiagnostic(previous, event) {
  if (event.OutputType === 'frame') return previous
  const output = event.Output.replace(/^\s*(?:=== (?:RUN|PAUSE|CONT|NAME) .*|--- (?:PASS|FAIL|SKIP): .*)\n?/gm, '')
  return (previous + output).slice(-diagnosticLimit)
}

function finishPackage(pkg, repository) {
  if (!pkg.status) throw new Error(`Incomplete Go report: package ${pkg.importPath} did not finish.`)
  const assertionResults = []
  for (const item of pkg.tests.values()) {
    if (!item.status) throw new Error(`Incomplete Go report: ${pkg.importPath} ${item.name} did not finish.`)
    if (item.benchmark && item.status !== 'failed') continue
    const failure = item.status === 'failed' && failureOutput(item.output, pkg.name, repository)
    assertionResults.push({ fullName: item.name, status: item.status, duration: item.duration,
      ...(failure ? { failureMessages: [failure] } : {}) })
  }
  if (pkg.status !== 'failed' && assertionResults.some(test => test.status === 'failed')) {
    throw new Error(`Inconsistent Go report: successful package ${pkg.importPath} has failed tests.`)
  }
  return { name: pkg.name, status: pkg.status, duration: pkg.duration, assertionResults }
}

/** A streaming collector: no result is publishable until every started package and test has finished. */
export class GoTestReport {
  constructor({ modulePath, repository = root, onOutput, onProgress } = {}) {
    if (typeof modulePath !== 'string' || !modulePath || /\s|\\/.test(modulePath)) {
      throw new Error('Expected the Go module import path from go list -m.')
    }
    this.modulePath = modulePath
    this.repository = repository
    this.onOutput = onOutput
    this.onProgress = onProgress
    this.packages = new Map()
    this.buildFailed = false
    this.line = 0
  }

  addLine(line) {
    this.line++
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid Go JSON on line ${this.line}.`, { cause: error })
    }
    validateEvent(event, this.line)
    if (event.Action === 'build-output' || event.Action === 'build-fail') {
      this.buildEvent(event)
      return
    }
    if (!actions.has(event.Action) || !event.Package) throw new Error(`Invalid Go test event on line ${this.line}.`)
    this.testEvent(event)
  }

  progress(type, pkg, name = '') {
    this.onProgress?.(type, { file: pkg.name, id: name || pkg.importPath, name, kind: name ? 'test' : 'module' })
  }

  buildEvent(event) {
    if (!event.ImportPath || event.Action === 'build-output' && typeof event.Output !== 'string') {
      throw new Error(`Invalid Go build event on line ${this.line}.`)
    }
    if (event.Action === 'build-fail') {
      this.buildFailed = true
      this.onOutput?.(`Go build failed: ${event.ImportPath}\n`)
    } else this.onOutput?.(event.Output)
    this.onProgress?.('output', { file: '', id: '', name: '', kind: 'module' })
  }

  testEvent(event) {
    if (event.Action === 'start') {
      if (event.Test || this.packages.has(event.Package)) throw new Error(`Duplicate or invalid Go package start: ${event.Package}.`)
      const pkg = { importPath: event.Package, name: packageDirectory(event.Package, this.modulePath),
        start: event.Time, status: null, duration: null, tests: new Map() }
      this.packages.set(event.Package, pkg)
      this.progress('start', pkg)
      return
    }
    const pkg = this.packages.get(event.Package)
    if (!pkg || pkg.status) throw new Error(`Go event outside a running package: ${event.Package}.`)
    if (event.Action === 'output') {
      if (typeof event.Output !== 'string') throw new Error(`Missing Go output on line ${this.line}.`)
      this.onOutput?.(event.Output)
      this.progress('output', pkg, event.Test)
      if (event.Test) {
        const item = this.testItem(pkg, event)
        item.output = appendDiagnostic(item.output, event)
      }
      return
    }
    if (!event.Test) {
      if (!terminals.has(event.Action)) throw new Error(`Go ${event.Action} event is missing a test name.`)
      pkg.status = statuses[event.Action]
      pkg.duration = elapsedMilliseconds(event, pkg.start)
      this.progress('finish', pkg)
      return
    }
    if (event.Action === 'run') {
      if (pkg.tests.has(event.Test)) throw new Error(`Duplicate Go test start: ${event.Package} ${event.Test}.`)
      pkg.tests.set(event.Test, { name: event.Test, start: event.Time, phase: 'running', status: null,
        duration: null, output: '', benchmark: event.Test.startsWith('Benchmark') })
      this.progress('start', pkg, event.Test)
      return
    }
    const item = this.testItem(pkg, event)
    if (event.Action === 'pause' || event.Action === 'cont') {
      const expected = event.Action === 'pause' ? 'running' : 'paused'
      if (item.phase !== expected) throw new Error(`Invalid Go test ${event.Action}: ${event.Test}.`)
      item.phase = event.Action === 'pause' ? 'paused' : 'running'
      return
    }
    item.status = event.Action === 'bench' ? 'passed' : statuses[event.Action]
    item.duration = elapsedMilliseconds(event, item.start)
    this.progress('finish', pkg, event.Test)
  }

  testItem(pkg, event) {
    let item = pkg.tests.get(event.Test)
    // Benchmark output does not necessarily have a preceding run event in test2json.
    if (!item && event.Test.startsWith('Benchmark')) {
      item = { name: event.Test, phase: 'running', status: null, duration: null, output: '', benchmark: true }
      pkg.tests.set(event.Test, item)
    }
    if (!item || item.status) throw new Error(`Go event outside a running test: ${event.Package} ${event.Test}.`)
    return item
  }

  finish() {
    const testResults = [...this.packages.values()].map(pkg => finishPackage(pkg, this.repository))
    const tests = [...this.packages.values()].flatMap(pkg => [...pkg.tests.values()].filter(item => !item.benchmark))
    const selected = tests.length
    const executed = tests.filter(item => item.status !== 'skipped').length
    const failed = this.buildFailed || testResults.some(result => result.status === 'failed')
    return { report: { testResults }, selected, executed, failed }
  }
}
