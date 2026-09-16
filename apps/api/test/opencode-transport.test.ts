import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { it } from 'vitest'

import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeServer.js'
import { environment, errorCode } from './opencode-fixtures.js'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-opencode-pr13-'))
  const binary = join(directory, 'opencode.cjs')
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),{spawn}=require('node:child_process');
const dir=${JSON.stringify(directory)};
const args=process.argv.slice(2);
if(args.includes('--version')) {
 fs.writeFileSync(dir+'/version.pid', String(process.pid));
 if(fs.existsSync(dir+'/hang-version')) setInterval(()=>{},1000);
 else console.log('1.18.31');
} else {
 const username=process.env.OPENCODE_SERVER_USERNAME || 'opencode';
 const auth='Basic '+Buffer.from(username+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
 const server=http.createServer((request,response)=>{
  if(request.headers.authorization!==auth){response.statusCode=401;response.end('{}');return;}
  response.setHeader('content-type','application/json');
  if(request.url==='/global/health') {
   if(fs.existsSync(dir+'/fail-health-once')) {fs.unlinkSync(dir+'/fail-health-once');response.statusCode=503;response.end('{}');return;}
   const send=()=>response.end(JSON.stringify({healthy:true,version:'1.18.31'}));
   if(fs.existsSync(dir+'/delay-health')) setTimeout(send,250); else send();
  } else if(request.url==='/test-env') response.end(JSON.stringify({token:process.env.GRAPHQL_APP_MCP_TOKEN??null,username,pid:process.pid}));
  else if(request.url==='/spawn-child') {
   const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
   fs.writeFileSync(dir+'/descendant.pid',String(child.pid));
   response.end(JSON.stringify({pid:child.pid}));
  } else if(request.url==='/exit-root') {response.end('{}');setImmediate(()=>process.exit(0));}
  else {response.statusCode=404;response.end('{}');}
 });
 server.listen(0,'127.0.0.1',()=>{
  fs.writeFileSync(dir+'/server.pid',String(process.pid));
  console.log('opencode server listening on http://127.0.0.1:'+server.address().port);
 });
}
`, { mode: 0o700 })
  await chmod(binary, 0o700)
  return { directory, binary }
}
async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    // A killed orphan may remain a zombie until the container init reaps it.
    if (process.platform === 'linux') {
      try { if (/\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return false } catch { return false }
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function expectStopped(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await isRunning(pid))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Fixture process ${pid} remained running`)
}

it.skipIf(process.platform === 'win32')('[F10,F24] strips inherited App tokens and pins the managed username', async () => {
  const previousToken = process.env.GRAPHQL_APP_MCP_TOKEN
  const previousUsername = process.env.OPENCODE_SERVER_USERNAME
  process.env.GRAPHQL_APP_MCP_TOKEN = 'PARENT_CANARY_NOT_A_REAL_SECRET'
  process.env.OPENCODE_SERVER_USERNAME = 'inherited-custom-user'
  const { directory, binary } = await fixture()
  try {
    for (const selected of [undefined, { agentId: 'agent-1', variables: {} }, environment('explicit-child-token')]) {
      const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1', ...(selected ? { environment: selected } : {}) })
      try {
        const actual = await (await server.request('/test-env')).json() as { token: string | null; username: string }
        assert.equal(actual.token, selected?.variables.GRAPHQL_APP_MCP_TOKEN ?? null)
        assert.equal(actual.username, 'opencode')
      } finally { await server.dispose() }
    }
  } finally {
    if (previousToken === undefined) delete process.env.GRAPHQL_APP_MCP_TOKEN; else process.env.GRAPHQL_APP_MCP_TOKEN = previousToken
    if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME; else process.env.OPENCODE_SERVER_USERNAME = previousUsername
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

it.skipIf(process.platform === 'win32')('[F11,F29] disposal invalidates a startup blocked in version probing', async () => {
  const { directory, binary } = await fixture()
  const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1' })
  await writeFile(join(directory, 'hang-version'), '')
  try {
    const starting = assert.rejects(server.ensure())
    let pid: number | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { pid = Number(await readFile(join(directory, 'version.pid'), 'utf8')); break } catch { await new Promise((resolve) => setTimeout(resolve, 5)) }
    }
    assert(pid)
    await server.dispose()
    await starting
    await expectStopped(pid)
    await assert.rejects(readFile(join(directory, 'server.pid')))
  } finally { await server.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('[F12] canceling one health check does not terminate the shared server', async () => {
  const { directory, binary } = await fixture()
  const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1', environment: environment() })
  try {
    await server.ensure()
    const originalPid = Number(await readFile(join(directory, 'server.pid'), 'utf8'))
    await writeFile(join(directory, 'delay-health'), '')
    const abort = new AbortController()
    const checked = assert.rejects(server.ensure(abort.signal), /caller canceled/)
    setTimeout(() => abort.abort(new Error('caller canceled')), 10)
    await checked
    assert.equal(await isRunning(originalPid), true)
    await rm(join(directory, 'delay-health'))
    const actual = await (await server.request('/test-env')).json() as { pid: number }
    assert.equal(actual.pid, originalPid)
  } finally { await server.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('[F13] disposal kills a descendant that ignores termination', async () => {
  const { directory, binary } = await fixture()
  const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1' })
  let descendant: number | undefined
  try {
    const actual = await (await server.request('/spawn-child')).json() as { pid: number }
    descendant = actual.pid
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await isRunning(descendant), true)
    await server.dispose()
    await expectStopped(descendant)
  } finally {
    await server.dispose()
    if (descendant && await isRunning(descendant)) process.kill(descendant, 'SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('[F13] an exited root is not mistaken for a terminated descendant group', async () => {
  const { directory, binary } = await fixture()
  const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1' })
  let descendant: number | undefined
  try {
    descendant = (await (await server.request('/spawn-child')).json() as { pid: number }).pid
    await new Promise((resolve) => setTimeout(resolve, 50))
    await (await server.request('/exit-root')).text()
    await expectStopped(Number(await readFile(join(directory, 'server.pid'), 'utf8')))
    await server.dispose()
    await expectStopped(descendant)
  } finally {
    await server.dispose()
    if (descendant && await isRunning(descendant)) process.kill(descendant, 'SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('[F15] a failed start retains desired scoped credentials for the next attempt', async () => {
  const { directory, binary } = await fixture()
  const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1', environment: environment('retained-scoped-token') })
  try {
    await writeFile(join(directory, 'fail-health-once'), '')
    await assert.rejects(server.ensure())
    const actual = await (await server.request('/test-env')).json() as { token: string }
    assert.equal(actual.token, 'retained-scoped-token')
    await assert.rejects(server.restart({ agentId: 'another-agent', variables: {} }), errorCode('OPENCODE_CREDENTIAL_OWNER_MISMATCH'))
    assert.equal((await (await server.request('/test-env')).json() as { token: string }).token, 'retained-scoped-token')
  } finally { await server.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('[F29] the single startup budget also times out a version command that never exits', async () => {
  const { directory, binary } = await fixture()
  const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-1', startupTimeoutMs: 150 })
  await writeFile(join(directory, 'hang-version'), '')
  try {
    await assert.rejects(server.ensure(), errorCode('OPENCODE_SERVER_START_TIMEOUT'))
    await expectStopped(Number(await readFile(join(directory, 'version.pid'), 'utf8')))
    await assert.rejects(readFile(join(directory, 'server.pid')))
  } finally { await server.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('[F19] an SSE body does not receive the ordinary whole-request deadline', async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  const deadlines: number[] = []
  let receivedSignal: AbortSignal | null | undefined
  let cancelled = false
  const server = new ManagedOpenCodeServer({ binary: 'unused', workingDirectory: '/unused', ownerAgentId: 'agent-1' })
  const raw = server as unknown as { baseUrl: string; password: string; rawRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> }
  raw.baseUrl = 'http://127.0.0.1:1'; raw.password = 'fixture-password'
  try {
    AbortSignal.timeout = (milliseconds) => { deadlines.push(milliseconds); return new AbortController().signal }
    globalThis.fetch = async (_input, init) => {
      receivedSignal = init?.signal
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const response = await raw.rawRequest('/event', { headers: { accept: 'text/event-stream' } })
    assert.deepEqual(deadlines, [])
    assert.equal(receivedSignal?.aborted, false)
    await response.body?.cancel()
    assert.equal(cancelled, true)
    await (await raw.rawRequest('/ordinary-json', {})).body?.cancel()
    assert.deepEqual(deadlines, [30_000])
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout }
})
