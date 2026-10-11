import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server'

type JsonConverters = StandardSchemaWithJSON['~standard']['jsonSchema']
type Converter = JsonConverters['input']

const schemas = new WeakMap<object, object>()
// Tool schemas are static per tool, but many are built inline for each request server; the name keeps one conversion.
const conversionsByTool = new Map<string, { input: Converter; output: Converter }>()

function cachedConversion(converters: JsonConverters, mode: 'input' | 'output'): Converter {
  const results = new Map<string, Record<string, unknown>>()
  return (options) => {
    // Vendor options can affect conversion independently of the draft target.
    if (options.libraryOptions !== undefined) return converters[mode](options)
    let result = results.get(options.target)
    if (!result) {
      result = converters[mode](options)
      results.set(options.target, result)
    }
    return result
  }
}

function cachedSchema(schema: unknown, key: string): unknown {
  if (!schema || (typeof schema !== 'object' && typeof schema !== 'function') || !('~standard' in schema)) {
    return schema
  }
  const cached = schemas.get(schema)
  if (cached) return cached
  const standard = (schema as StandardSchemaWithJSON)['~standard']
  if (!standard.jsonSchema) return schema
  let conversions = conversionsByTool.get(key)
  if (!conversions) {
    conversions = { input: cachedConversion(standard.jsonSchema, 'input'), output: cachedConversion(standard.jsonSchema, 'output') }
    conversionsByTool.set(key, conversions)
  }
  // Validation always uses this request's schema; only the advertised JSON Schema is shared.
  const properties = {
    ...standard,
    validate: standard.validate.bind(standard),
    jsonSchema: conversions,
  }
  const wrapper = new Proxy(schema, {
    get(target, key, receiver) {
      return key === '~standard' ? properties : Reflect.get(target, key, receiver)
    },
  })
  schemas.set(schema, wrapper)
  return wrapper
}

/** Reuses schema conversion across request servers without sharing handlers or caller state. */
export function cacheToolSchemaConversions(server: McpServer, surface: string): void {
  server.registerTool = new Proxy(server.registerTool, {
    apply(register, target, [name, config, callback]) {
      return Reflect.apply(register, target, [name, {
        ...config,
        ...(config.inputSchema !== undefined ? { inputSchema: cachedSchema(config.inputSchema, `${surface}:${name}:input`) } : {}),
        ...(config.outputSchema !== undefined ? { outputSchema: cachedSchema(config.outputSchema, `${surface}:${name}:output`) } : {}),
      }, callback])
    },
  })
}
