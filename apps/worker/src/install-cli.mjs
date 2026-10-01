import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { hostFacts, WorkerError } from './diagnostics.mjs';
import { installVersion, rollbackVersion } from './installation.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { renderUserService } from './service.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1] || options[args[i]]) throw new WorkerError('installer_arguments_invalid');
  options[args[i]] = args[i + 1];
}
async function main() {
  const root = options['--root'], state = options['--state'];
  if (!root || !state || !isAbsolute(root) || !isAbsolute(state) || root === state || state.startsWith(`${root}/`) || root.startsWith(`${state}/`)) throw new WorkerError('separate_private_roots_required');
  if (command === 'service') {
    const template = await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8');
    process.stdout.write(renderUserService(template, { node: options['--node'], app: root, state, home: options['--home'], path: options['--path'] }));
    return;
  }
  // The human must explicitly stop/drain via W08/service policy first. An active
  // installation cannot be updated by this CLI, even with an approval flag.
  const approveStop = async () => {
    if (options['--approve-stopped-update'] !== 'yes') return false;
    const unlock = await acquireWorkerLock(state); await unlock(); return true;
  };
  if (command === 'install') {
    const result = await installVersion({ root, artifact: options['--artifact'], approvedManifestSha256: options['--manifest-sha256'], facts: await hostFacts(process.env.HOME ?? '', [root, state]), expected: { protocolVersion: 1, identityFormat: 1 }, updatePolicy: approveStop });
    console.log(JSON.stringify(result));
  } else if (command === 'rollback') await rollbackVersion({ root, approveStop });
  else throw new WorkerError('installer_command_invalid');
}
main().catch((error) => { console.error(error instanceof WorkerError ? error.code : 'installation_failed'); process.exitCode = 1; });
