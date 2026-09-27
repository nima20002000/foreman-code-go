/** Deliberate application-secret delivery boundary, not a host sandbox. */
export function inheritedAgentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, NO_COLOR: '1' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_') || key.startsWith('GRAPHQL_APP_') || key === 'GRAPHQL_MCP_TOKEN'
      || key === 'DATABASE_URL' || key === 'TEST_DATABASE_URL' || key === 'PGPASSWORD') delete environment[key]
  }
  return environment
}

function preparedSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length > 0))].sort((left, right) => right.length - left.length)
}

function redactPreparedText(value: string, values: readonly string[]): string {
  if (!values.length) return value
  const replace = (text: string) => values.reduce((current, secret) =>
    current.includes(secret) ? current.split(secret).join('[REDACTED]') : current, text)
  // Providers sometimes embed JSON in raw stdout/stderr, including arrays and
  // Unicode-escaped string literals. Decode individual JSON strings before
  // matching known values; do not rely on the surrounding field name.
  let result = value.includes('\\') && value.includes('"') ? value.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
    try {
      const decoded: unknown = JSON.parse(quoted)
      if (typeof decoded !== 'string') return quoted
      const safe = replace(decoded)
      return safe === decoded ? quoted : JSON.stringify(safe)
    } catch { return quoted }
  }) : value
  result = replace(result)
  return result
}

export function redactSecretText(value: string, secrets: readonly string[]): string {
  return redactPreparedText(value, preparedSecrets(secrets))
}

/** Redact values and keys after JSON decoding, including escaped JSON strings. */
export function redactKnownSecrets<T>(value: T, secrets: readonly string[]): T {
  const values = preparedSecrets(secrets)
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactPreparedText(item, values)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [
        redactPreparedText(key, values), visit(nested),
      ]))
    }
    return item
  }
  return visit(value) as T
}
