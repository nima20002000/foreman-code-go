#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const help = `Usage: node scripts/ci-laptop-acceptance.mjs --config PATH --scenario all|success|failure|cancel|reconnect|timeout|denied --evidence-dir PATH
Orchestrator-only. Config stays outside build mounts; bearer secrets come only from a named environment variable.
Config: {mainUrl, credentialEnv, deniedCredentialEnv?, integratedSourceSha, approved:{device,root,isolation,network,installation,capacity}, buildMounts:[], jobs:{success,failure,cancel,reconnect,timeout}, reconnectFaultEvidence?}
Each jobs entry is a saved JobDefinitionSpec. Source commit must equal integratedSourceSha. Success argv is corepack,pnpm,build and requires apps/web/dist/index.html. No installs or SSH execution.
Reconnect requires external orchestrator fault evidence; this entry never claims a connection fault it did not observe.
`
const args=process.argv.slice(2)
if(args.includes('--help')) {process.stdout.write(help);process.exit(0)}
function option(name) {const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1].startsWith('--')) throw new Error(`Missing ${name}`);return args[i+1]}
const scenarios=['success','failure','cancel','reconnect','timeout','denied']
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function hash(bytes) {return createHash('sha256').update(bytes).digest('hex')}
async function main() {
  const configPath=resolve(option('--config')), evidenceDir=resolve(option('--evidence-dir')), scenario=option('--scenario')
  if(![...scenarios,'all'].includes(scenario)) throw new Error('Unknown scenario')
  const config=JSON.parse(await readFile(configPath,'utf8'))
  if(!/^[a-f0-9]{40}$/.test(config.integratedSourceSha)) throw new Error('Exact integrated source SHA required')
  if(!['device','root','isolation','network','installation','capacity'].every(key=>config.approved?.[key]===true)) throw new Error('Human/environment approvals missing')
  if(!Array.isArray(config.buildMounts)||!config.buildMounts.length) throw new Error('Approved build mounts required')
  for(const mount of config.buildMounts) {const suffix=relative(resolve(mount),configPath);if(suffix===''||(!suffix.startsWith('..')&&!isAbsolute(suffix))) throw new Error('Config cannot enter build mounts')}
  const url=new URL(config.mainUrl)
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new Error('Invalid main URL')
  function credential(name) {if(!/^[A-Z][A-Z0-9_]*$/.test(name??'')||!process.env[name]) throw new Error('Normal authentication credential unavailable');return process.env[name]}
  const token=credential(config.credentialEnv)
  async function request(path,body,credential=token,raw=false) {
    const response=await fetch(new URL(path,url),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
    if(raw) return response
    if(!response.ok) throw new Error(`Authenticated API request failed (${response.status})`)
    return response.json()
  }
  await mkdir(evidenceDir,{recursive:true,mode:0o700})
  for(const current of scenario==='all'?scenarios:[scenario]) {
    const spec=config.jobs?.[current==='denied'?'success':current]
    if(!spec||spec.source?.commit!==config.integratedSourceSha||spec.target?.hostRef?.kind!=='device'||!spec.target.registration) throw new Error(`Missing actual pinned device/root/spec for ${current}`)
    if(current==='success'&&(JSON.stringify(spec.argv)!==JSON.stringify(['corepack','pnpm','build'])||!spec.outputs.some(output=>output.path==='apps/web/dist/index.html'&&output.required))) throw new Error('Success must perform real pinned build with required compiled HTML')
    const workspaceId=config.workspaceId
    if(!workspaceId) throw new Error('Workspace scope missing')
    const base=`/api/management/workspaces/${encodeURIComponent(workspaceId)}/jobs`
    if(current==='denied') {
      const response=await request(`${base}/executions`,{commandId:randomUUID(),definitionId:'denied-probe',expectedRevision:1},credential(config.deniedCredentialEnv),true)
      if(response.status!==403) throw new Error('Denied caller did not fail with 403')
      await writeFile(resolve(evidenceDir,'denied.json'),JSON.stringify({sourceSha:config.integratedSourceSha,status:403},null,2));continue
    }
    const {definition}=await request(`${base}/definitions`,{commandId:randomUUID(),expectedRevision:null,name:`Acceptance ${current}`,spec})
    const command={commandId:randomUUID(),definitionId:definition.id,expectedRevision:definition.revision}
    const {execution:accepted}=await request(`${base}/executions`,command)
    const root=`${base}/executions/${encodeURIComponent(accepted.id)}`
    if(current==='cancel') {await sleep(1000);await request(`${root}/cancel`,{commandId:randomUUID()})}
    if(current==='reconnect') {
      if(!config.reconnectFaultEvidence?.connectionCutAfterLaunch||!config.reconnectFaultEvidence?.mainRestarted||!config.reconnectFaultEvidence?.observedLaunchCount) throw new Error('Orchestrator connection-cut/main-restart evidence is required')
      const replay=await request(`${base}/executions`,command)
      if(replay.execution.id!==accepted.id||replay.execution.attemptId!==accepted.attemptId) throw new Error('Reconnect submission duplicated execution')
      if(config.reconnectFaultEvidence.observedLaunchCount!==1) throw new Error('One observed launch is required')
    }
    let execution=accepted;const deadline=Date.now()+spec.policy.queueTimeoutMs+spec.policy.preparationTimeoutMs+spec.policy.executionTimeoutMs+60000
    do {if(Date.now()>deadline) throw new Error('Acceptance readback deadline exceeded');await sleep(1000);({execution}=await request(root))} while(execution.process.phase!=='terminal'||['pending','collecting'].includes(execution.publication))
    if(current==='success'&&(execution.process.outcome!=='succeeded'||execution.process.exitCode!==0||execution.publication!=='complete'||execution.resultIssue)) throw new Error('Build/output result is not complete success')
    if(current==='failure'&&(execution.process.outcome!=='build_failed'||execution.process.exitCode!==7)) throw new Error('Exit7 was not preserved as build failure')
    if(current==='cancel'&&(execution.process.outcome!=='cancelled'||!execution.process.processStopped)) throw new Error('Cancellation lacks confirmed owned-process closure')
    if(current==='timeout'&&execution.process.outcome!=='timed_out') throw new Error('Worker-local timeout not observed')
    const logChunks=[];let afterSequence=0
    for(;;) {const page=await request(`${root}/logs?afterSequence=${afterSequence}&limit=100`);logChunks.push(...page.chunks);if(page.nextCursor===afterSequence||!page.chunks.length) break;afterSequence=page.nextCursor}
    const {artifacts}=await request(`${root}/artifacts`)
    for(const artifact of artifacts.filter(item=>item.state==='available')) {
      const response=await request(`${root}/artifacts/${encodeURIComponent(artifact.fileId)}/revisions/${encodeURIComponent(artifact.revisionId)}/content`,undefined,token,true)
      if(!response.ok) throw new Error('Artifact read failed')
      const bytes=Buffer.from(await response.arrayBuffer())
      if(bytes.length!==artifact.byteSize||hash(bytes)!==artifact.sha256) throw new Error('Exact artifact digest/size verification failed')
      await writeFile(resolve(evidenceDir,`${artifact.revisionId.replace(/[^a-zA-Z0-9._-]/g,'_')}.artifact`),bytes,{mode:0o600})
    }
    // Canonical paths may be private; export accepted identity/digests, not host names or credentials.
    const evidence={sourceSha:config.integratedSourceSha,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,specDigest:execution.acceptedSpec.specDigest,source:execution.acceptedSpec.source,process:execution.process,transport:execution.transport,publication:execution.publication,resultIssue:execution.resultIssue,logChunks,artifacts}
    await writeFile(resolve(evidenceDir,`${current}.json`),JSON.stringify(evidence,null,2),{mode:0o600})
  }
}
main().catch(()=>{process.stderr.write('CI acceptance failed. Verify approved config, authenticated API and private evidence; no credential values were printed.\n');process.exitCode=1})
