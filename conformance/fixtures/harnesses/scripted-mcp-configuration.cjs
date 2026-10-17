/* global require, module, process, URL */
/* eslint @typescript-eslint/no-require-imports: "off" -- Adjacent native fixture extension. */
const fs = require('node:fs')
const path = require('node:path')

function object(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object.`)
  return value
}

function processDisables(name) {
  const args = process.argv.slice(2)
  return args.some((argument, index) => argument === '-c' && args[index + 1] === `mcp_servers.${name}.enabled=false`)
}

const transportFields = ['type', 'command', 'args', 'env', 'env_vars', 'cwd', 'url',
  'bearer_token_env_var', 'headers', 'http_headers', 'env_http_headers', 'oauth']

function applyConfiguration(current, value, replaceTransport = false) {
  const entry = object(value, 'Native MCP configuration override')
  const change = { ...(entry.transport === undefined ? {} : object(entry.transport, 'Native MCP transport')), ...entry }
  delete change.transport
  const changesTransport = entry.transport !== undefined
    || replaceTransport && (change.command != null || change.url != null)
    || change.command != null && current.command == null || change.url != null && current.url == null
  const inherited = { ...current }
  // Native config/batchWrite replaces the transport fields. A new command or URL
  // must not inherit the previous transport's locator, credential reference or CLI type.
  if (changesTransport) for (const key of transportFields) delete inherited[key]
  return { ...inherited, ...change }
}

function configuredPolicy(entry, overrides) {
  const key = `mcp_servers.${entry.name}`
  const prefix = `${key}.`
  const nested = overrides.mcp_servers?.[entry.name]
  let policy = applyConfiguration({}, entry)
  for (const replacement of [nested, overrides[key]]) {
    if (replacement !== undefined) policy = applyConfiguration(policy, replacement, true)
  }
  const fields = Object.fromEntries(Object.entries(overrides)
    .filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]))
  policy = applyConfiguration(policy, fields)
  for (const key of ['enabled_tools', 'disabled_tools']) {
    if (policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].some(name => typeof name !== 'string'))) {
      throw new Error(`Native MCP ${key} must contain tool names.`)
    }
  }
  return policy
}

function approvedHttp(scope, transport) {
  const endpoint = new URL(transport.url)
  if (endpoint.protocol !== 'http:' || endpoint.origin !== scope.apiOrigin || endpoint.pathname !== '/mcp'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.port) {
    throw new Error('Native App MCP must address this fresh target’s configured loopback endpoint.')
  }
  if (!scope.appMcpTokenNames.includes(transport.bearer_token_env_var)) {
    throw new Error('Native App MCP has no supported accepted credential reference.')
  }
  for (const key of ['headers', 'http_headers', 'env_http_headers']) {
    if (transport[key] !== undefined && Object.keys(object(transport[key], 'Native MCP headers')).length) {
      throw new Error('The App MCP fixture does not support additional native HTTP header configuration.')
    }
  }
  const token = process.env[transport.bearer_token_env_var]
  if (!token) throw new Error('Native App MCP did not receive its accepted runtime credential.')
  return { kind: 'http', endpoint, token }
}

function approvedStdio(scope, transport) {
  if (typeof transport.command !== 'string' || !path.isAbsolute(transport.command)
    || fs.realpathSync(transport.command) !== fs.realpathSync(process.execPath)
    || !Array.isArray(transport.args) || transport.args.length !== 1 || transport.args[0] !== scope.appMcpLauncher
    || fs.realpathSync(scope.appMcpLauncher) !== scope.appMcpLauncher) {
    throw new Error('Native App MCP stdio must use the current runtime and this target’s installed managed launcher.')
  }
  if (!Array.isArray(transport.env_vars) || transport.env_vars.length !== 1
    || !scope.appMcpTokenNames.includes(transport.env_vars[0]) || !process.env[transport.env_vars[0]]) {
    throw new Error('The managed launcher did not receive its configured accepted credential.')
  }
  if (transport.env !== undefined && Object.keys(object(transport.env, 'Native MCP environment')).length) {
    throw new Error('The managed App MCP launcher cannot replace its accepted runtime environment.')
  }
  return { kind: 'stdio', command: transport.command, args: transport.args,
    environment: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')) }
}

function readMcpConfiguration(root, overrides) {
  const scope = object(JSON.parse(fs.readFileSync(path.join(root, 'fixture-scope.json'), 'utf8')), 'Owned fixture scope')
  const entry = object(JSON.parse(fs.readFileSync(path.join(root, 'mcp.json'), 'utf8')), 'Native MCP configuration')
  if (!scope.appMcpServerNames.includes(entry.name)) throw new Error('The script requires the configured Foreman Code MCP connection.')
  const policy = configuredPolicy(entry, overrides)
  if (fs.existsSync(path.join(root, 'no-mcp')) || processDisables(entry.name) || policy.enabled === false) {
    throw new Error('The configured native App MCP connection is disabled.')
  }
  const hasCommand = typeof policy.command === 'string'
  const hasUrl = typeof policy.url === 'string'
  if (hasCommand === hasUrl) throw new Error('Native App MCP needs exactly one effective command or URL.')
  const type = hasCommand ? 'stdio' : 'streamable_http'
  if (policy.type !== undefined && policy.type !== type) {
    throw new Error('The native App MCP transport type disagrees with its effective command or URL.')
  }
  let connection
  if (type === 'streamable_http') connection = approvedHttp(scope, policy)
  else connection = approvedStdio(scope, policy)
  return { name: entry.name, policy, connection, modules: scope.mcpModules }
}

function toolEnabled(policy, name) {
  return (policy.enabled_tools === undefined || policy.enabled_tools.includes(name))
    && !(policy.disabled_tools ?? []).includes(name) && policy.tools?.[name]?.enabled !== false
    && policy[`tools.${name}.enabled`] !== false
}

module.exports = { readMcpConfiguration, toolEnabled }
