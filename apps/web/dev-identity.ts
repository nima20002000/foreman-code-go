import { fileURLToPath } from 'node:url'
import { checkoutIdentity } from '@foreman-code/contracts/runtime-identity-node'
import type { Plugin } from 'vite'

export function devIdentity(apiUrl: string): Plugin {
  const checkoutId = checkoutIdentity(fileURLToPath(new URL('../../', import.meta.url)))
  return {
    name: 'graphql-dev-identity',
    configureServer(server) {
      server.middlewares.use('/__graphql_dev_identity', (_request, response) => {
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ checkoutId, apiUrl }))
      })
    },
  }
}
