import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseEnv } from 'node:util'
import { readProductEnvironment, resolveProductEnvironment } from './productEnvironment.mjs'

/**
 * Select the custom env file before reading it; process settings retain precedence.
 * @param {string | undefined} [defaultFile]
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function loadProductEnvFile(defaultFile, environment = process.env) {
  const file = readProductEnvironment(environment, 'API_ENV_FILE') ?? defaultFile ?? '.env'
  const merged = resolveProductEnvironment(environment, parseEnv(readFileSync(file, 'utf8')))
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GRAPHQL_')) delete environment[name]
  }
  Object.assign(environment, merged)
}
