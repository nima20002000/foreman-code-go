import { expect, it } from 'vitest'

import { buildApp } from '../src/app.js'

it('body.json-depth-10001', async () => {
  const app = buildApp({ readiness: {
    database: { ping: async () => { throw new Error('body capture must not contact infrastructure') } },
    checkpoints: { ping: async () => { throw new Error('body capture must not contact infrastructure') } },
  } })
  app.post('/api/body-depth', async (_request, reply) => reply.code(204).send())
  try {
    const payload = '['.repeat(10001) + 'null' + ']'.repeat(10001)
    const response = await app.inject({
      method: 'POST', url: '/api/body-depth', headers: { 'content-type': 'application/json' }, payload,
    })
    expect(response.statusCode).toBe(204)
  } finally {
    await app.close()
  }
})
