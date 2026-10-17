import { createServer } from 'node:net'

/** Ask the OS for an unused loopback port; a bind conflict remains a setup failure. */
export async function randomLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (!address || typeof address === 'string') throw new Error('No loopback TCP port was allocated')
  return address.port
}
