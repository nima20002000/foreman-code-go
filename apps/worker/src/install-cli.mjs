import { readFile } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostFacts, WorkerError } from './diagnostics.mjs';
import { installVersion, rollbackVersion } from './installation.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { renderUserService } from './service.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
const help = `Usage:
  node /approved/artifact/src/install-cli.mjs setup --manifest-sha256 APPROVED_SHA256
  node /approved/artifact/src/install-cli.mjs install --root /private/app --state /private/state --artifact /approved/artifact --manifest-sha256 APPROVED_SHA256
  node /approved/artifact/src/install-cli.mjs rollback --root /private/app --state /private/state --approve-stopped-update yes
  node /approved/artifact/src/install-cli.mjs service --root /private/app --state /private/state --node /absolute/node --home /approved/home --path /usr/bin:/bin

Update: use install with the new approved artifact and manifest hash, adding --approve-stopped-update yes.
Before update or rollback, complete the approved drain/stop policy and stop the worker service. An active worker blocks replacement; the approval flag does not stop it.
App and state must be separate private persistent directories. Update and rollback preserve the state identity and pairing.
service only prints a unit for human review.
setup uses private directories under HOME, installs a command and desktop launcher,
and prepares a user service. It never starts/enables the service or enables linger.
`;
async function main() {
  if (!command || command === '--help' || command === '-h' || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || options[args[i]]) throw new WorkerError('installer_arguments_invalid');
    options[args[i]] = args[i + 1];
  }
  const home = process.env.HOME ?? '';
  const root = command === 'setup' ? join(home, '.local/lib/graphql-worker') : options['--root'];
  const state = command === 'setup' ? join(home, '.local/state/graphql-worker') : options['--state'];
  if (!root || !state || !isAbsolute(root) || !isAbsolute(state) || root === state || state.startsWith(`${root}/`) || root.startsWith(`${state}/`)) throw new WorkerError('separate_private_roots_required');
  if (command === 'service') {
    const template = await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8');
    process.stdout.write(renderUserService(template, { node: options['--node'], app: root, state, home: options['--home'], path: options['--path'] }));
    return;
  }
  // The human must explicitly stop/drain via W08/service policy first. An active
  // installation cannot be updated by this CLI, even with an approval flag.
  let updateUnlock;
  const approveStop = async () => {
    if (options['--approve-stopped-update'] !== 'yes') return false;
    updateUnlock = await acquireWorkerLock(state); return true;
  };
  const facts = await hostFacts(process.env.HOME ?? '', [root, state]);
  const expected = { protocolVersion: 1, identityFormat: 1 };
  try {
    if (command === 'setup') {
      const { setupCompanion } = await import('./setup.mjs');
      const result = await setupCompanion({ home, node: process.execPath, artifact: options['--artifact'] ?? dirname(dirname(fileURLToPath(import.meta.url))), approvedManifestSha256: options['--manifest-sha256'], facts, updatePolicy: approveStop,
        serviceTemplate: await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8') });
      console.log(`GraphQL Companion installed. Open GraphQL Companion from Applications, or run ${result.launcher}.\nIdentity and configuration: ${result.state}\nThis installer did not start or enable the background service. After reviewing ${result.proposedService}, opt in with:\n  install -D -m 0600 ${result.proposedService} ${home}/.config/systemd/user/graphql-worker.service\n  systemctl --user daemon-reload\n  systemctl --user enable --now graphql-worker.service\nUpdates need the approved drain/stop policy; rerun setup with --approve-stopped-update yes.\nRollback: ${process.execPath} ${result.root}/current/src/install-cli.mjs rollback --root ${result.root} --state ${result.state} --approve-stopped-update yes`);
    } else if (command === 'install') {
      const result = await installVersion({ root, artifact: options['--artifact'], approvedManifestSha256: options['--manifest-sha256'], facts, expected, updatePolicy: approveStop });
      console.log(JSON.stringify(result));
    } else if (command === 'rollback') await rollbackVersion({ root, approveStop, facts, expected });
    else throw new WorkerError('installer_command_invalid');
  } finally { await updateUnlock?.(); }
}
main().catch((error) => { console.error(error instanceof WorkerError ? error.code : 'installation_failed'); process.exitCode = 1; });
