/** Focused bridge smoke suite. No OpenCode binary, database or Vitest is needed.
 * This is not a substitute for the repository typecheck or native-manager tests.
 * Run with the repository's TypeScript dependency: node scripts/test-fil09a.mjs
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const ts = require(process.env.FIL09A_TYPESCRIPT_MODULE ?? 'typescript')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'fil09a-smoke-'))
const paths = [
  'apps/api/src/modules/harnesses/opencodeFiles/types.ts',
  'apps/api/src/modules/harnesses/opencodeFiles/attachments.ts',
  'apps/api/src/modules/harnesses/opencodeFiles/turn.ts',
  'apps/api/test/support/opencodeChatFileFixture.ts',
  'apps/api/test/support/opencodeChatFileCases.ts',
]
try {
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n')
  for (const path of paths) {
    const source = await readFile(join(root, path), 'utf8')
    const result = ts.transpileModule(source, { fileName: path, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true } })
    const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n',
    }))
    const destination = join(temporary, path.replace(/\.ts$/, '.js'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, result.outputText)
  }
  const { registerOpenCodeChatFileCases } = await import(pathToFileURL(join(temporary, 'apps/api/test/support/opencodeChatFileCases.js')))
  const pending = []
  registerOpenCodeChatFileCases((name, body) => {
    const result = test(`FIL-09a: ${name}`, { timeout: 15_000 }, body)
    pending.push(result)
    return result
  })
  await Promise.all(pending)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
