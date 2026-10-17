import { execFile } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DeviceTlsTrust } from '@foreman-code/contracts/device-identity'

const execute = promisify(execFile)

/** Every run creates its own CA and leaf; the client trusts only this CA. */
export async function createDeviceTls(directory: string, environment: NodeJS.ProcessEnv) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const caKey = join(directory, 'ca.key')
  const caCertificate = join(directory, 'ca.pem')
  const privateKey = join(directory, 'device.key')
  const request = join(directory, 'device.csr')
  const certificate = join(directory, 'device.pem')
  const extensionFile = join(directory, 'device-extensions.cnf')
  await writeFile(extensionFile, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 })
  const openssl = async (args: string[]) => {
    try {
      await execute('openssl', args, { cwd: directory, env: environment, timeout: 15_000, maxBuffer: 64 * 1024 })
    } catch (cause) {
      throw new Error('Fresh device TLS setup requires a working openssl executable.', { cause })
    }
  }
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
    '-subj', '/CN=Foreman conformance test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', caCertificate])
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', '/CN=localhost', '-keyout', privateKey, '-out', request])
  await openssl(['x509', '-req', '-in', request, '-CA', caCertificate, '-CAkey', caKey,
    '-CAcreateserial', '-days', '2', '-sha256', '-extfile', extensionFile, '-out', certificate])
  await Promise.all([caKey, caCertificate, privateKey, certificate, request].map(path => chmod(path, 0o600)))
  const certificatePem = await readFile(caCertificate, 'utf8')
  const ca = new X509Certificate(certificatePem)
  const leaf = new X509Certificate(await readFile(certificate))
  if (!ca.ca || !leaf.verify(ca.publicKey) || !leaf.checkIP('127.0.0.1')) {
    throw new Error('Fresh device TLS material failed its CA, signature, or endpoint check.')
  }
  const trust: DeviceTlsTrust = { certificatePem, sha256: createHash('sha256').update(ca.raw).digest('hex') }
  return { certificate, privateKey, caCertificate, trust }
}
