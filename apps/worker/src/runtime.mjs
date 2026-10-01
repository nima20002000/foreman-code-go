import { createServer, createConnection as connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { WorkerError, requirePrivateDirectory } from './diagnostics.mjs';

function socketName(stateDirectory) {
  return `\0graphql-worker-${createHash('sha256').update(resolve(stateDirectory)).digest('hex')}`;
}

export async function readWorkerStatus(stateDirectory) {
  const canonical = await realpath(stateDirectory).catch(() => null);
  if (!canonical) return null;
  return new Promise((accept) => {
    const socket = connect(socketName(canonical));
    let bytes = '';
    socket.setTimeout(1000, () => { socket.destroy(); accept(null); });
    socket.on('error', () => { socket.destroy(); accept(null); });
    socket.on('data', (chunk) => { bytes += chunk; if (bytes.length > 2048) { socket.destroy(); accept(null); } });
    socket.on('end', () => { try { accept(JSON.parse(bytes)); } catch { accept(null); } });
  });
}

export async function acquireWorkerLock(stateDirectory, status = () => ({ active: true })) {
  await requirePrivateDirectory(stateDirectory);
  const socket = createServer((client) => {
    client.on('error', () => {});
    client.end(JSON.stringify(status()));
  });
  const name = socketName(await realpath(stateDirectory));
  await new Promise((accept, reject) => {
    socket.once('error', (error) => reject(error.code === 'EADDRINUSE' ? new WorkerError('worker_already_running') : error));
    socket.listen(name, accept);
  });
  return () => new Promise((accept, reject) => socket.close((error) => error ? reject(error) : accept()));
}

// This composition has no control-plane imports. Identity and connection implementations
// are explicitly injected from W07-A/B; execution admission is a later W08 port.
export async function startWorker({ stateDirectory, loadIdentity, createConnection, shutdownMs = 10_000 }) {
  let connection;
  const unlock = await acquireWorkerLock(stateDirectory, () => ({ active: true, phase: connection?.status?.().phase ?? 'connecting', failure: connection?.status?.().failure ?? null }));
  try {
    const identity = await loadIdentity(stateDirectory);
    const bootId = randomUUID();
    connection = await createConnection({ identity, bootId, capabilities: { dispatch: false, transfer: false } });
    await connection.start();
    let stopping;
    return { identity, bootId, connection, stop() {
      stopping ??= (async () => {
        let timer;
        try {
          await Promise.race([Promise.resolve().then(() => connection.stop()), new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkerError('shutdown_timeout')), shutdownMs); })]);
          await unlock();
        } finally { clearTimeout(timer); }
      })();
      return stopping;
    } };
  } catch (error) { try { await connection?.stop(); } finally { await unlock(); } throw error; }
}
