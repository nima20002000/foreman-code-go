import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { installVersion } from './installation.mjs';
import { requirePrivateDirectory } from './diagnostics.mjs';
import { renderUserService } from './service.mjs';

async function publish(path, content, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, content, { mode, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

// This convenience installs files only. Starting/enabling the user service and
// enabling linger remain explicit actions by the approved OS user.
export async function setupCompanion({ home, node, artifact, approvedManifestSha256, facts, updatePolicy, serviceTemplate }) {
  const root = join(home, '.local/lib/graphql-worker');
  const state = join(home, '.local/state/graphql-worker');
  const path = `${dirname(node)}:/usr/bin:/bin`;
  const unit = renderUserService(serviceTemplate, { node, app: root, state, home, path });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(state);
  const result = await installVersion({ root, artifact, approvedManifestSha256, facts, expected: { protocolVersion: 1, identityFormat: 1 }, updatePolicy });
  const launcher = join(root, 'graphql-companion');
  await publish(launcher, `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED\nexport HOME='${home}'\nexport PATH='${path}'\nexec '${node}' '${root}/current/src/companion.mjs' --state '${state}' "$@"\n`, 0o700);
  const desktop = join(home, '.local/share/applications/graphql-companion.desktop');
  await publish(desktop, `[Desktop Entry]\nType=Application\nName=GraphQL Companion\nComment=Computer connection and diagnostics\nExec=${launcher} --desktop\nTerminal=false\nCategories=Utility;\n`, 0o600);
  const proposedService = join(root, 'graphql-worker.service');
  await publish(proposedService, unit, 0o600);
  return { ...result, root, state, launcher, desktop, proposedService, serviceActivation: 'not-requested' };
}
