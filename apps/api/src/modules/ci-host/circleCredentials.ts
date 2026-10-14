import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'

interface CircleConfig { token?: string; host?: string }
const CLOUD_HOST = 'https://circleci.com'

async function readConfig(path: string): Promise<CircleConfig | null> {
  try {
    const config = parse(await readFile(path, 'utf8')) as CircleConfig | null
    if (config !== null && (typeof config !== 'object' || Array.isArray(config)
      || config.token !== undefined && typeof config.token !== 'string'
      || config.host !== undefined && typeof config.host !== 'string')) {
      throw new Error('Invalid credential configuration')
    }
    return config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'CircleCI credential configuration could not be read.', 503)
  }
}

export async function configuredCircleToken(ports: HostCiPorts): Promise<string | null> {
  const environmentToken = process.env.CIRCLE_TOKEN || process.env.CIRCLE_CLI_TOKEN
  if (environmentToken) return environmentToken
  const directory = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const config = await readConfig(join(directory, 'circleci', 'config.yml'))
  const host = process.env.CIRCLE_HOST || config?.host || CLOUD_HOST
  // Server credentials must not be sent to the cloud REST endpoint.
  if (host !== CLOUD_HOST) return null
  if (process.platform === 'linux') {
    try {
      // CircleCI CLI v1 uses these Secret Service attributes and prefers the keyring over YAML.
      // https://github.com/CircleCI-Public/circleci-cli/blob/b60dc4c63b65/internal/config/config.go
      const result = await ports.run('secret-tool', ['lookup', 'service', `com.circleci.cli:${host}`,
        'username', userInfo().username], { timeoutMs: 15_000 })
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim()
    } catch {
      // ignore: an unavailable keyring uses file credentials or the visible CLI transport status.
    }
  }
  if (config?.token?.trim()) return config.token.trim()
  const legacy = await readConfig(join(homedir(), '.circleci', 'cli.yml'))
  return legacy?.token?.trim() || null
}
