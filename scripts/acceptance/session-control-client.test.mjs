import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionControlHeaders } from './session-control-client.mjs'

test('authenticated server clients send their credential without inventing a browser origin', () => {
  assert.deepEqual(sessionControlHeaders({ baseUrl: 'http://127.0.0.1:3040' },
    { httpTokenEnv: 'TEST_OWNER' }, { TEST_OWNER: 'recorded-credential' }), {
    'content-type': 'application/json', authorization: 'Bearer recorded-credential',
  })
})

test('browser clients use the configured origin instead of the API port', () => {
  assert.equal(sessionControlHeaders({ baseUrl: 'http://127.0.0.1:3040', browserOrigin: 'http://localhost:5173' }, {}, {}).origin,
    'http://localhost:5173')
  assert.throws(() => sessionControlHeaders({ browserOrigin: 'http://localhost:5173/unreviewed' }, {}, {}))
  assert.throws(() => sessionControlHeaders({ browserOrigin: 'https://another.example' }, {}, {}))
})

test('an unavailable owner credential fails before making an application request', () => {
  assert.throws(() => sessionControlHeaders({}, { httpTokenEnv: 'TEST_OWNER' }, {}), /Missing TEST_OWNER/)
})
