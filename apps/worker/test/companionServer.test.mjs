import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createCompanionServer } from '../src/companionServer.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-http-'));
  const htmlFile = join(directory, 'companion.html');
  await writeFile(htmlFile, '<script nonce="{{CSP_NONCE}}"></script>');
  const calls = [];
  const gui = await createCompanionServer({ stateDirectory: directory, htmlFile, runCli: async (command, input) => {
    calls.push({ command, input });
    return command === 'identity-request' ? 'GQLWR1.public' : command === 'pair' ? '{}' : JSON.stringify({ pairing: 'unpaired', connection: 'offline', service: { active: false } });
  }, ...options });
  t.after(() => { gui.close(); return rm(directory, { recursive: true, force: true }); });
  const post = (path, body = {}, headers = {}) => fetch(`${gui.origin}${path}`, { method: 'POST', headers: { origin: gui.origin, 'content-type': 'application/json', 'x-graphql-companion-session': gui.session, ...headers }, body: JSON.stringify(body) });
  return { gui, calls, post };
}

test('loopback GUI requires its exact host, origin and session before executing any command', async (t) => {
  const f = await fixture(t);
  assert.match(f.gui.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: '' }]) assert.equal((await f.post('/api/status', {}, headers)).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const call = request(`${f.gui.origin}/api/status`, { method: 'POST', headers: { host: 'attacker.example', origin: f.gui.origin, 'x-graphql-companion-session': f.gui.session, 'content-type': 'application/json' } }, (response) => { response.resume(); resolve(response.statusCode); });
    call.on('error', reject); call.end('{}');
  });
  assert.equal(rejectedHost, 403);
  for (const token of ['', 'a'.repeat(43), 'é'.repeat(43)]) assert.equal((await f.post('/api/status', {}, { 'x-graphql-companion-session': token })).status, 401);
  assert.deepEqual(f.calls, []);
  const page = await fetch(f.gui.origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.equal(html.includes('{{CSP_NONCE}}'), false);
  assert.equal(html.includes(f.gui.session), false);
});

test('GUI routes only genuine request/status/pair commands, with private code supplied as input', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.post('/api/identity-request')).json(), { code: 'GQLWR1.public' });
  const paired = await f.post('/api/pair', { enrollmentCode: 'GQLWE1.private-test-code' });
  assert.deepEqual(await paired.json(), { paired: true });
  assert.deepEqual(f.calls, [{ command: 'identity-request', input: undefined }, { command: 'pair', input: 'GQLWE1.private-test-code' }]);
  const status = await (await f.post('/api/status')).json();
  assert.equal(status.service.active, false);
  assert.equal((await f.post('/api/service', { enabled: true })).status, 404);
  assert.equal((await f.post('/api/pair', { enrollmentCode: 'x'.repeat(8193) })).status, 400);
  assert.equal((await f.post('/api/pair', { enrollmentCode: 'x'.repeat(17000) })).status, 413);
  assert.equal(f.calls.length, 3);
});

test('closing the GUI ends its session without issuing worker or service commands', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.post('/api/close')).json(), { closed: true });
  assert.deepEqual(f.calls, []);
  await assert.rejects(fetch(`${f.gui.origin}/`));
});

test('service enable is separate from pairing, requires explicit confirmation and actual paired readback', async (t) => {
  const enables = []; let paired = false;
  const f = await fixture(t, { runCli: async () => JSON.stringify({ pairing: paired ? 'paired' : 'unpaired' }), serviceController: { plan: async () => ({ planSha256: 'a'.repeat(64) }), enable: async (sha) => { enables.push(sha); return { enabled: true }; } } });
  assert.deepEqual(await (await f.post('/api/service-plan')).json(), { planSha256: 'a'.repeat(64) });
  assert.equal((await f.post('/api/service-enable', { planSha256: 'a'.repeat(64) })).status, 400);
  assert.equal((await f.post('/api/service-enable', { confirm: true, planSha256: 'a'.repeat(64) })).status, 400);
  assert.deepEqual(enables, []);
  paired = true;
  assert.deepEqual(await (await f.post('/api/service-enable', { confirm: true, planSha256: 'a'.repeat(64) })).json(), { enabled: true });
  assert.deepEqual(enables, ['a'.repeat(64)]);
});

test('GUI sessions expire and separate launches get different credentials', async (t) => {
  const first = await fixture(t, { lifetimeMs: 50 }), second = await fixture(t);
  assert.notEqual(first.gui.session, second.gui.session);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(fetch(first.gui.origin));
  assert.equal((await second.post('/api/status')).status, 200);
});

test('read-only preview cannot create identity, pair or change a service', async (t) => {
  const f = await fixture(t, { readOnly: true });
  for (const path of ['/api/identity-request', '/api/pair', '/api/service-enable']) assert.equal((await f.post(path, { enrollmentCode: 'GQLWE1.test', confirm: true, planSha256: 'a'.repeat(64) })).status, 403);
  assert.deepEqual(f.calls, []);
  const status = await (await f.post('/api/status')).json();
  assert.equal(status.readOnly, true);
  assert.equal(status.compatibility.supported, false);
});
