#!/usr/bin/env node
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

if (process.argv.includes('--help')) {
  console.log(`Usage: node scripts/smoke-opencode-files.mjs --model provider/model [--binary /path/to/opencode] [--output returned.md]

Requires Linux, a non-root user, installed workspace dependencies, configured native provider credentials,
and the repository-qualified OpenCode 1.18.31. Runs a real native read/edit/publish against the real
FIL-05 service with an in-memory test database/byte store. It does not modify the app database,
provider credentials, native user configuration, workflow App MCP, or existing output files.
The returned Markdown is verified and written with exclusive-create semantics.
This is component smoke coverage, not proof that production chat admission is wired.`)
} else {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const loader = require.resolve('tsx')
  const entry = fileURLToPath(new URL('../apps/api/test/support/opencodeFileSmoke.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', loader, entry, ...process.argv.slice(2)], { stdio: 'inherit' })
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}
