import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_MANAGER, RELEASE_AGE_MINUTES, sha256 } from './seed-policy.mjs';

const imageRoot = '/opt/graphql-ci';
export const VERIFICATION_SCRATCH = '/job-scratch';
const corepack = '/usr/local/lib/node_modules/corepack/dist/corepack.js';

export function verificationEnvironment(environment) {
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(?:npm_config_|pnpm_|corepack_|node_options$|node_path$)/i.test(key)));
  return {
    ...clean,
    HOME: `${VERIFICATION_SCRATCH}/home`,
    XDG_CACHE_HOME: `${VERIFICATION_SCRATCH}/cache`,
    XDG_CONFIG_HOME: `${VERIFICATION_SCRATCH}/config`,
    XDG_DATA_HOME: `${VERIFICATION_SCRATCH}/data`,
    TMPDIR: `${VERIFICATION_SCRATCH}/tmp`,
    COREPACK_HOME: `${imageRoot}/seed/corepack-cache`,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    npm_config_offline: 'true',
    npm_config_store_dir: `${VERIFICATION_SCRATCH}/pnpm-store`,
    npm_config_cache_dir: `${VERIFICATION_SCRATCH}/cache/pnpm`,
    npm_config_verify_store_integrity: 'true',
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
    CI: '1',
  };
}

export function verificationInstallArguments(argv) {
  if (argv[0] !== 'install') return argv;
  const allowed = new Set(['install', '--frozen-lockfile', '--offline', '--prod=false']);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--store-dir' && argv[index + 1] === `${VERIFICATION_SCRATCH}/pnpm-store`) {
      index++;
      continue;
    }
    if (!allowed.has(argument)) throw new Error('Verification install arguments cannot change dependency policy.');
  }
  return ['install', '--frozen-lockfile', '--offline', '--prod=false'];
}

export function assertEffectivePackagePolicy(config) {
  const value = key => config[key] ?? config[key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)];
  if (Number(value('minimumReleaseAge')) !== RELEASE_AGE_MINUTES
    || ![true, 'true'].includes(value('minimumReleaseAgeStrict'))
    || ![false, 'false'].includes(value('minimumReleaseAgeIgnoreMissingTime'))
    || (value('minimumReleaseAgeExclude')?.length ?? 0) !== 0) {
    throw new Error('Effective strict 48-hour dependency policy changed.');
  }
}

export function assertEffectiveVerificationStore(config) {
  const value = key => config[key] ?? config[key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)];
  if (![true, 'true'].includes(value('offline')) || ![true, 'true'].includes(value('verifyStoreIntegrity'))
    || value('storeDir') !== `${VERIFICATION_SCRATCH}/pnpm-store`
    || value('cacheDir') !== `${VERIFICATION_SCRATCH}/cache/pnpm`) {
    throw new Error('Effective offline Job-private dependency store changed.');
  }
}

export async function assertDependencyInputs(root, receipt) {
  for (const file of receipt.dependencyInputs) {
    const bytes = await readFile(resolve(root, file.path));
    if (sha256(bytes) !== file.sha256) throw new Error('Committed dependency inputs differ from the approved offline seed.');
  }
}

export async function copyVerificationSeed(seedDirectory, scratchDirectory, receiptBytes) {
  for (const directory of ['home', 'cache', 'config', 'data', 'tmp']) {
    await mkdir(`${scratchDirectory}/${directory}`, { recursive: true, mode: 0o700 });
  }
  const marker = `${scratchDirectory}/seed-receipt.sha256`;
  const existing = await readFile(marker, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) {
    await cp(`${seedDirectory}/pnpm-store`, `${scratchDirectory}/pnpm-store`, { recursive: true, force: false, errorOnExist: true });
    await cp(`${seedDirectory}/registry-cache`, `${scratchDirectory}/cache/pnpm`, { recursive: true, force: false, errorOnExist: true });
    await writeFile(marker, sha256(receiptBytes), { flag: 'wx', mode: 0o600 });
  } else if (existing !== sha256(receiptBytes)) throw new Error('Job-local store belongs to another approved seed.');
}

/** Every invocation uses image-controlled pnpm and configuration; workloads never share a writable installer store. */
export async function prepareVerificationPnpm(argv, environment = process.env) {
  if (argv[0] !== 'pnpm') throw new Error('The verification runtime uses its pinned pnpm only.');
  const env = verificationEnvironment(environment);
  if (argv.length === 2 && ['--version', '-v'].includes(argv[1])) return { argv, env };
  const receiptBytes = await readFile(`${imageRoot}/seed-receipt.json`);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt.packageManager !== PACKAGE_MANAGER) throw new Error('Pinned offline package manager unavailable.');
  await assertDependencyInputs('/workspace', receipt);
  const args = verificationInstallArguments(argv.slice(1));
  if (args.some(arg => /^--(?:minimum-release-age|config\.|userconfig|globalconfig|store-dir|cache-dir|offline|prod|prefix|ignore-pnpmfile|verify-store-integrity)/.test(arg)
    && !['--offline', '--prod=false'].includes(arg))) {
    throw new Error('Caller package configuration overrides are unavailable in verification.');
  }
  await copyVerificationSeed(`${imageRoot}/seed`, VERIFICATION_SCRATCH, receiptBytes);
  const config = JSON.parse(execFileSync(process.execPath, [corepack, 'pnpm', 'config', 'list', '--json'],
    { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 }));
  assertEffectivePackagePolicy(config);
  assertEffectiveVerificationStore(config);
  return { argv: ['pnpm', ...args], env };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { argv, env } = await prepareVerificationPnpm(process.argv.slice(2));
    const child = spawn(process.execPath, [corepack, ...argv], { env, stdio: 'inherit', shell: false });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 127; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 130); });
  } catch (error) {
    process.stderr.write(`Offline verification preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
