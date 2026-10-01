import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';

const [flag, state, command, ...args] = process.argv.slice(2);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
if (flag !== '--state' || !isAbsolute(state ?? '')) {
  console.error('Open the installed GraphQL Companion launcher.'); process.exitCode = 1;
} else if (command) {
  const child = spawnSync(process.execPath, [cli, command, '--state', state, ...args], { stdio: 'inherit' });
  process.exitCode = child.status ?? 1;
} else {
  console.log('GraphQL Companion\n');
  try {
    const report = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--state', state], { encoding: 'utf8', timeout: 5000, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'ignore'] }));
    console.log(`Version: ${report.versions.app ?? 'unknown'}\nPairing: ${report.pairing}\nConnection: ${report.connection}\nBackground service: ${report.service.active ? 'running' : 'stopped'}`);
    if (report.errors.length) console.log(`Diagnostics: ${report.errors.join(', ')}`);
  } catch { console.log('Diagnostics unavailable. Run the launcher with doctor to inspect this installation.'); }
  console.log('\nPairing must be authorized by the selected main. Installing this companion does not start its background service.');
  if (process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { await input.question('\nPress Enter to close.'); } finally { input.close(); }
  }
}
