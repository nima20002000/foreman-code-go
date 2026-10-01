import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const artifact = process.env.GRAPHQL_WORKER_ARTIFACT_DIRECTORY;
test('packaged GUI serves the actual CSP page and invokes real read-only doctor without creating identity or enabling service', { skip: !artifact }, async (t) => {
  const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
  assert.equal((await stat(join(artifact, 'install'))).mode & 0o777, 0o700);
  const { createCompanionServer } = await import(pathToFileURL(join(artifact, 'src/companionServer.mjs')).href);
  const state = await mkdtemp(join(tmpdir(), 'packaged-companion-'));
  const gui = await createCompanionServer({ stateDirectory: state });
  t.after(() => { gui.close(); return rm(state, { recursive: true, force: true }); });
  const page = await fetch(gui.origin), html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(html.includes('{{CSP_NONCE}}'), false);
  assert.equal(html.includes(gui.session), false);
  assert.match(html, /\/api\/service-plan/);
  assert.match(html, /\/api\/service-enable/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const post = (path, body = {}, origin = gui.origin) => fetch(`${gui.origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-graphql-companion-session': gui.session }, body: JSON.stringify(body) });
  assert.equal((await post('/api/identity-request', {}, 'https://outside.example')).status, 403);
  const status = await (await post('/api/status')).json();
  assert.equal(status.versions.commit, manifest.commit);
  assert.equal(status.pairing, 'unpaired');
  assert.equal(status.service.active, false);
  assert.deepEqual(status.compatibility.required, manifest.target);
  assert.deepEqual(status.compatibility.actual, Object.fromEntries(['os', 'osRelease', 'arch', 'libc', 'node'].map((key) => [key, status.versions[key]])));
  assert.equal(status.compatibility.supported, status.compatibility.mismatches.length === 0);
  assert.equal((await post('/api/service-enable', { confirm: true, planSha256: 'a'.repeat(64) })).status, 400);
  // This deliberately unqualified tmpfs state cannot initialize a durable identity.
  assert.equal((await post('/api/identity-request')).status, 400);
  await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
});
