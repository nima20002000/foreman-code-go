import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { access, mkdir, readFile, readlink, statfs, writeFile, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { prepareVerificationPnpm, assertEffectivePackagePolicy, assertEffectiveVerificationStore } from './verification-policy.mjs';

/** Runs inside the admitted verification container. It reports observations, never a qualification flag. */
export async function observeVerificationRuntime({ ownerSentinelPaths, tools = [] }) {
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
  const version = (binary, args = ['--version']) => execFileSync(binary, args,
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 }).trim();
  const toolchain = { node: process.version, corepack: version(process.execPath, ['/usr/local/lib/node_modules/corepack/dist/corepack.js', '--version']),
    pnpm: version('corepack', ['pnpm', '--version']), git: version('git'), flock: version('flock') };
  const measuredTools = [];
  for (const tool of tools) {
    if (!tool.executable?.startsWith('/opt/graphql-ci/tools/') || tool.executable.includes('..')) {
      throw new Error('Image-owned qualification tool path required.');
    }
    const bytes = await readFile(tool.executable);
    if (bytes.length > 256 * 1024 * 1024) throw new Error('Image tool exceeds its capture bound.');
    measuredTools.push({ kind: tool.kind, executable: tool.executable,
      version: version(tool.executable), binarySha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const writeError = async path => {
    try { await writeFile(path, 'qualification write'); return null; }
    catch (error) { return error.code; }
  };
  const rootfsWriteError = await writeError('/verification-outside');
  const gitWriteErrors = [];
  for (const name of ['HEAD', 'index', 'config']) gitWriteErrors.push(await writeError(`/graphql-job-git/${name}`));
  const scheduler = `/graphql-job-git/graphql-heavy-jobs/${randomUUID()}`;
  await writeFile(scheduler, 'bounded scheduler state', { flag: 'wx', mode: 0o600 });
  const schedulerWrite = (await readFile(scheduler, 'utf8')) === 'bounded scheduler state';
  await unlink(scheduler);
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { detached: true, stdio: 'ignore', env });
  descendant.unref();
  return {
    schemaVersion: 1, node: process.version, toolchain, tools: measuredTools, rootfsWriteError,
    gitWriteErrors: gitWriteErrors.join(','), schedulerWrite, detachedChildPid: descendant.pid,
    environment: Object.keys(process.env).sort(),
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
