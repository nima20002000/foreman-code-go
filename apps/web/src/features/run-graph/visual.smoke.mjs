/** Runs the production pure policies and the same regression cases used by Vitest. No dependency install. */
import { readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { URL } from 'node:url'

const loaded = new Map()
async function moduleUrl(url) {
  if (loaded.has(url.href)) return loaded.get(url.href)
  let code = stripTypeScriptTypes(await readFile(url, 'utf8'), { mode: 'strip' })
  const imports = [...code.matchAll(/from\s+(['"])(\.[^'"]+)\1/g)]
  for (const match of imports) {
    const path = match[2].endsWith('.ts') ? match[2] : match[2] + '.ts'
    const dependency = await moduleUrl(new URL(path, url))
    code = code.replace(match[0], `from '${dependency}'`)
  }
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  loaded.set(url.href, result)
  return result
}
const { registerVisualCases } = await import(await moduleUrl(new URL('./visualPolicy.cases.ts', import.meta.url)))
registerVisualCases(test)
