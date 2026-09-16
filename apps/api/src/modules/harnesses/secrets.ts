/** Deliberate application-secret delivery boundary, not a host sandbox. */
export function inheritedAgentEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_') || key.startsWith('GRAPHQL_APP_')
      || key === 'DATABASE_URL' || key === 'TEST_DATABASE_URL' || key === 'PGPASSWORD') delete environment[key]
  }
  return environment
}

export function redactSecretText(value: string, secrets: readonly string[]): string {
  const values = secrets.filter((secret) => secret.length > 0).sort((left, right) => right.length - left.length)
  const replace = (text: string) => values.reduce((current, secret) => current.split(secret).join('[REDACTED]'), text)
  // Providers sometimes embed JSON in raw stdout/stderr, including arrays and
  // Unicode-escaped string literals. Decode individual JSON strings before
  // matching known values; do not rely on the surrounding field name.
  let result = value.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
    try {
      const decoded: unknown = JSON.parse(quoted)
      if (typeof decoded !== 'string') return quoted
      const safe = replace(decoded)
      return safe === decoded ? quoted : JSON.stringify(safe)
    } catch { return quoted }
  })
  result = replace(result)
  return result
}

/** Redact values and keys after JSON decoding, including escaped JSON strings. */
export function redactKnownSecrets<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactSecretText(value, secrets) as T
  if (Array.isArray(value)) return value.map((item: unknown) => redactKnownSecrets(item, secrets)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactSecretText(key, secrets), redactKnownSecrets(item, secrets),
    ])) as T
  }
  return value
}
