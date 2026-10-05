import { localHumanProxyRequest } from '@graphql/contracts/local-client-node'
import type { Plugin } from 'vite'

export function localHumanProxy(): Plugin {
  return {
    name: 'graphql-local-human-proxy',
    configureServer(server) {
      server.middlewares.use(localHumanProxyRequest)
    },
  }
}
