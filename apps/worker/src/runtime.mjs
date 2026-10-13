import { createServer, createConnection as connect } from 'node:net';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { WorkerError, requirePrivateDirectory } from './diagnostics.mjs';

function socketName(stateDirectory) {
  return `\0graphql-worker-${createHash('sha256').update(resolve(stateDirectory)).digest('hex')}`;
}

export async function readWorkerStatus(stateDirectory) {
  const canonical = await realpath(stateDirectory).catch(() => { /* ignore: an unresolvable state directory reads as no running worker */ return null; });
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
  const unlock = () => new Promise((accept, reject) => socket.close((error) => error ? reject(error) : accept()));
  unlock.assertOwned = () => {
    if (!socket.listening || socket.address() !== name) throw new WorkerError('worker_ownership_lost');
  };
  return unlock;
}

// This composition has no control-plane imports. Identity and connection implementations
// are explicitly injected from W07-A/B; execution admission is a later W08 port.
export async function startWorker({ stateDirectory, loadIdentity, createConnection, beforeUnlock, appVersion,
  shutdownMs = 10_000, readBootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }) {
  let connection;
  let identity;
  const unlock = await acquireWorkerLock(stateDirectory, () => ({ active: true,
    appVersion, workerInstallationId: identity?.workerInstallationId,
    phase: connection?.status?.().phase ?? 'connecting', failure: connection?.status?.().failure ?? null }));
  try {
    identity = await loadIdentity(stateDirectory);
    const bootId = await readBootId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) throw new WorkerError('boot_identity_unavailable');
    connection = await createConnection({ identity, bootId, capabilities: { dispatch: false, transfer: false },
      assertStateOwnership: unlock.assertOwned });
    await connection.start();
    let stopping;
    return { identity, bootId, connection, stop() {
      stopping ??= (async () => {
        let timer;
        try {
          await Promise.race([Promise.resolve().then(async () => { await connection.stop(); await beforeUnlock?.(); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkerError('shutdown_timeout')), shutdownMs); })]);
          await unlock();
        } finally { clearTimeout(timer); }
      })();
      return stopping;
    } };
  } catch (error) {
    try { await connection?.stop(); await beforeUnlock?.(); await unlock(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Worker startup cleanup remains incomplete.', { cause: cleanupError }); }
    throw error;
  }
}
