#!/usr/bin/env node
// Runs the same focused cases as Vitest without installing the full API dependency graph.
// It transpiles, not typechecks. Full repo typecheck and authenticated integration tests are separate.
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const ts = require('typescript')
const output = await mkdtemp(join(tmpdir(), 'fil09-test-'))
const files = [
  'apps/api/src/modules/harnesses/opencodeFiles/types.ts',
  'apps/api/src/modules/harnesses/opencodeFiles/attachments.ts',
  'apps/api/src/modules/harnesses/opencodeFiles/host.ts',
  'apps/api/src/modules/harnesses/opencodeFiles/turn.ts',
  'apps/api/test/support/opencodeFileCases.ts',
]
try {
  await writeFile(join(output, 'package.json'), '{"type":"module"}')
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8')
    const result = ts.transpileModule(text, { fileName: file, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
        verbatimModuleSyntax: true, sourceMap: false } })
    const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n',
    }))
    const target = join(output, file.replace(/\.ts$/, '.js'))
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, result.outputText)
  }
  const testFile = join(output, 'cases.test.mjs')
  await writeFile(testFile, `import { test } from 'node:test';\nimport { registerOpenCodeFileCases } from ${JSON.stringify(pathToFileURL(join(output, files.at(-1).replace(/\.ts$/, '.js'))).href)};\nregisterOpenCodeFileCases(test);\n`)
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', testFile], { stdio: 'inherit' })
    child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = status
} finally { await rm(output, { recursive: true, force: true }) }
