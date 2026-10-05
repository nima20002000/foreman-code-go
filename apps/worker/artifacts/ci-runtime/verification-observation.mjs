import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readlink, statfs, writeFile, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareVerificationPnpm, assertEffectivePackagePolicy, assertEffectiveVerificationStore } from './verification-policy.mjs';

/** Runs inside the admitted verification container. It reports observations, never a qualification flag. */
export async function observeVerificationRuntime({ ownerSentinelPaths }) {
  if (!Array.isArray(ownerSentinelPaths) || !ownerSentinelPaths.length
    || ownerSentinelPaths.some(path => typeof path !== 'string' || !path.startsWith('/') || path.includes('\0'))) {
    throw new Error('Original controller-owned sentinel paths required.');
  }
  await mkdir('/job-scratch/tmp', { recursive: true, mode: 0o700 });
  const execution = async directory => {
    const path = `${directory}/qualification-${randomUUID()}`;
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700, flag: 'wx' });
    try {
      const result = spawnSync(path, [], { stdio: 'ignore', timeout: 5000 });
      return result.error?.code ?? result.status;
    } finally { await unlink(path); }
  };
  const { env } = await prepareVerificationPnpm(['pnpm', 'config', 'list', '--json']);
  const config = JSON.parse(execFileSync(process.execPath,
    ['/usr/local/lib/node_modules/corepack/dist/corepack.js', 'pnpm', 'config', 'list', '--json'],
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
  assertEffectivePackagePolicy(config);
  assertEffectiveVerificationStore(config);
  const status = await readFile('/proc/self/status', 'utf8');
  const shm = await statfs('/dev/shm');
  const tmp = await statfs('/tmp');
  const ownerSentinels = [];
  for (const path of ownerSentinelPaths) {
    let result;
    try { await access(path); result = 'accessible'; }
    catch (error) { result = error.code; }
    ownerSentinels.push({ path, result });
  }
  const cpu = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(' ').map(Number);
  return {
    schemaVersion: 1, node: process.version,
    pidNamespace: await readlink('/proc/self/ns/pid'), networkNamespace: await readlink('/proc/self/ns/net'),
    interfaces: Object.keys(networkInterfaces()).sort(),
    memoryMax: (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
    swapMax: (await readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(),
    pidsMax: (await readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim(), cpuRatio: cpu[0] / cpu[1],
    capabilities: /^CapEff:\s*(\S+)/m.exec(status)?.[1], noNewPrivileges: /^NoNewPrivs:\s*(\S+)/m.exec(status)?.[1],
    controlExecution: await execution('/tmp'), scratchExecution: await execution('/job-scratch/tmp'),
    shmType: shm.type, shmCapacityBytes: shm.blocks * shm.bsize,
    controlTempType: tmp.type, controlTempCapacityBytes: tmp.blocks * tmp.bsize,
    mountInfo: await readFile('/proc/self/mountinfo', 'utf8'), ownerSentinels,
    packagePolicy: { minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = JSON.parse(process.argv[2] ?? 'null');
  const observation = await observeVerificationRuntime(input);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}
