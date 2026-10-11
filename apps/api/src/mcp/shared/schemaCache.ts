import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server'

type JsonConverters = StandardSchemaWithJSON['~standard']['jsonSchema']
type Converter = JsonConverters['input']

const schemas = new WeakMap<object, object>()

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

function cachedSchema(schema: unknown): unknown {
  if (!schema || (typeof schema !== 'object' && typeof schema !== 'function') || !('~standard' in schema)) {
    return schema
  }
  const cached = schemas.get(schema)
  if (cached) return cached
  const standard = (schema as StandardSchemaWithJSON)['~standard']
  if (!standard.jsonSchema) return schema
  const properties = {
    ...standard,
    validate: standard.validate.bind(standard),
    jsonSchema: {
      input: cachedConversion(standard.jsonSchema, 'input'),
      output: cachedConversion(standard.jsonSchema, 'output'),
    },
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
export function cacheToolSchemaConversions(server: McpServer): void {
  server.registerTool = new Proxy(server.registerTool, {
    apply(register, target, [name, config, callback]) {
      return Reflect.apply(register, target, [name, {
        ...config,
        ...(config.inputSchema !== undefined ? { inputSchema: cachedSchema(config.inputSchema) } : {}),
        ...(config.outputSchema !== undefined ? { outputSchema: cachedSchema(config.outputSchema) } : {}),
      }, callback])
    },
  })
}
