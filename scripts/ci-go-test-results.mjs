// go test -json -count=1 ./... | node scripts/ci-go-test-results.mjs --module <go-list-m> --output <report.json>
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { GoTestReport } from './ci-go-test-report.mjs'
import { goSelectionResult, validateGoSelection } from './ci-go-selected-roots.mjs'
import { writeCiProgressEvent } from './ci-progress-reporter.mjs'
import { readJsonReport, writeJsonReport } from './ci-report-io.mjs'
import { measuredUnitDurations } from './ci-unit-files.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

export async function writeGoTestResults(input, { modulePath, output, durations, repository = root,
  onOutput, onProgress, selection } = {}) {
  const packages = selection === undefined ? undefined : validateGoSelection(selection)
  const collector = new GoTestReport({ modulePath, repository, onOutput, onProgress })
  for await (const line of createInterface({ input, crlfDelay: Infinity })) collector.addLine(line)
  const result = collector.finish()
  if (packages) {
    result.selection = goSelectionResult(result.report, packages)
    result.failed ||= result.selection.status === 'failed'
  }
  writeJsonReport(output, result.report)
  if (durations) writeJsonReport(durations, measuredUnitDurations(result.report, repository, 'go'))
  return result
}

async function main() {
  const { values } = parseArgs({ options: { module: { type: 'string' }, output: { type: 'string' },
    input: { type: 'string' }, durations: { type: 'string' }, selection: { type: 'string' } } })
  if (!values.module || !values.output) {
    throw new Error('Usage: ci-go-test-results.mjs --module <go-list-m> --output <report.json> [--input <go.jsonl>] [--durations <durations.json>] [--selection <package-roots.json>]')
  }
  const input = values.input ? createReadStream(values.input) : process.stdin
  const result = await writeGoTestResults(input, { modulePath: values.module, output: values.output,
    durations: values.durations, selection: values.selection ? readJsonReport(values.selection) : undefined,
    onOutput: text => process.stdout.write(text), onProgress: writeCiProgressEvent })
  process.stdout.write(`Go test results: ${result.selected} selected named tests and subtests; ${result.executed} executed.\n`)
  for (const failure of result.selection?.failures ?? []) process.stderr.write(`${failure}\n`)
  if (!result.selected) {
    process.stderr.write('Go test selection is empty: zero selected Go tests.\n')
    process.exitCode = 1
  } else if (!result.executed) {
    process.stderr.write('Go tests all skipped: zero executed Go tests.\n')
    process.exitCode = 1
  } else if (result.failed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
