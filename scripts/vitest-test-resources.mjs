import { provisionTestResources } from './test-resources.mjs'

export default async function setup() {
  const previous = { ...process.env }
  const resources = await provisionTestResources()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, resources.environment)
  return async () => {
    try { await resources.close() } finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, previous)
    }
  }
}
