import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { mkdir, open, readdir, type FileHandle } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { MaterializationReceipt, SourceManifest } from '@graphql/contracts/source-materialization'
import { z } from 'zod'
import type { JobExecution } from '@graphql/contracts/jobs'
import { JOB_RUNTIME_WORKSPACE_LAYOUT } from '@graphql/contracts/job-runtime'
import type { SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import { sourceMaterializationDigest } from './bindingHash.js'
import { qualifiedGit } from './capture.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SourceError, sourceSha256, verifySourceBytes, verifySourceManifest } from './manifest.js'
import type { MaterializationAttempt, SourceMaterializationPort } from './ports.js'

/** CI gets a freshly generated object database and explicit Git environment.
 * It contains this approved snapshot only, with no source hooks/config/helpers,
 * no shared .git and no implied approval to transfer repository history.
 */
export async function createPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; manifest: SourceManifest; materializer: SourceMaterializationPort;
  attempt: MaterializationAttempt;
}): Promise<{ workTree: string; gitDirectory: string; generatedCommit: string; sourceCommit: string | null }> {
  const manifest = verifySourceManifest(input.manifest), receipt = input.receipt
  if (manifest.snapshotId !== receipt.binding.snapshotId || manifest.manifestDigest !== receipt.verifiedManifestDigest)
    throw new SourceError('SOURCE_PIN_CONFLICT', 'Repository generation requires the accepted complete source snapshot.')
  const expected = { binding: receipt.binding, attempt: input.attempt }
  const workTree = await input.materializer.resolve(receipt, expected)
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  let gitDirectory: string
  try {
    if (JSON.stringify(await identity(root)) !== JSON.stringify(receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    const reservation = await openChildDirectory(root, receipt.materializationId)
    try {
      const prior = await open(anchored(reservation, 'repository-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (prior) {
        return await readPrivateRepository(prior, reservation, receipt, manifest, workTree)
      }
      await mkdir(anchored(reservation, 'repository'), { mode: 0o700 })
    }
    finally { await reservation.close() }
    gitDirectory = join(receipt.binding.canonicalPath, receipt.materializationId, 'repository')
  } finally { await root.close() }
  // Every Git subprocess uses only this new store, qualified system Git, no
  // global/system config, no replace refs, no hooks and no interactive prompts.
  await qualifiedGit(gitDirectory, ['init', '--bare', '--template=', `--object-format=${manifest.git?.objectFormat ?? 'sha1'}`])
  for (const entry of manifest.entries) {
    const object = (await qualifiedGit(gitDirectory, ['hash-object', '-w', '--no-filters', '--', join(workTree, entry.path)])).toString().trim()
    verifySourceBytes(entry, await qualifiedGit(gitDirectory, ['cat-file', 'blob', object], entry.byteSize + 1))
    await qualifiedGit(gitDirectory, ['update-index', '--add', '--cacheinfo', entry.executable ? '100755' : '100644', object, entry.path])
  }
  const tree = (await qualifiedGit(gitDirectory, ['write-tree'])).toString().trim()
  const generatedCommit = (await qualifiedGit(gitDirectory, ['-c', 'user.name=GraphQL Source', '-c', 'user.email=source@graphql.invalid', 'commit-tree', tree, '-m', `Source snapshot ${manifest.snapshotId}\nManifest ${manifest.manifestDigest}`])).toString().trim()
  await qualifiedGit(gitDirectory, ['update-ref', 'HEAD', generatedCommit])
  await qualifiedGit(gitDirectory, ['config', 'core.bare', 'false'])
  await qualifiedGit(gitDirectory, ['config', 'core.worktree', workTree])
  await input.materializer.verify(receipt, expected)
  const owner = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    const reservation = await openChildDirectory(owner, receipt.materializationId)
    try {
      const repository = await openChildDirectory(reservation, 'repository')
      let configDigest: string
      try {
        const config = await open(anchored(repository, 'config'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { configDigest = sourceSha256(await config.readFile()) } finally { await config.close() }
      } finally { await repository.close() }
      const record = await open(anchored(reservation, 'repository-receipt.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await record.writeFile(JSON.stringify({ materializationId: receipt.materializationId, manifestDigest: manifest.manifestDigest,
        receiptDigest: sourceSha256(Buffer.from(JSON.stringify(receipt))), generatedCommit, configDigest })); await record.sync() }
      finally { await record.close() }
      await reservation.sync(); await owner.sync()
    } finally { await reservation.close() }
  } finally { await owner.close() }
  return { workTree, gitDirectory, generatedCommit, sourceCommit: manifest.git?.commit ?? null }
}

/** Verify only the retained original repository. Missing receipts fail closed;
 * this path cannot initialize Git, write objects or replace source state. */
export async function verifyPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; materializer: SourceMaterializationPort; attempt: MaterializationAttempt;
}) {
  const receipt = input.receipt
  const workTree = await input.materializer.resolve(receipt, { binding: receipt.binding, attempt: input.attempt })
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if (JSON.stringify(await identity(root)) !== JSON.stringify(receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    const reservation = await openChildDirectory(root, receipt.materializationId)
    try {
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let manifest: SourceManifest
      try {
        const stat = await record.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid original source receipt.')
        const stored = JSON.parse(await record.readFile('utf8')) as { receipt: MaterializationReceipt; manifest: SourceManifest }
        manifest = verifySourceManifest(stored.manifest)
        if (!isDeepStrictEqual(stored.receipt, receipt) || manifest.snapshotId !== receipt.binding.snapshotId
          || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Stored source receipt changed.')
      } finally { await record.close() }
      const prior = await open(anchored(reservation, 'repository-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      return await readPrivateRepository(prior, reservation, receipt, manifest, workTree)
    } finally { await reservation.close() }
  } finally { await root.close() }
}

async function readPrivateRepository(prior: FileHandle, reservation: FileHandle, receipt: MaterializationReceipt, manifest: SourceManifest, workTree: string) {
  try {
    const stat = await prior.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Invalid private repository receipt.')
    const saved = JSON.parse(await prior.readFile('utf8')) as { materializationId: string; manifestDigest: string; receiptDigest: string; generatedCommit: string; configDigest: string }
    const repository = await openChildDirectory(reservation, 'repository')
    try {
      const config = await open(anchored(repository, 'config'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await config.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || sourceSha256(await config.readFile()) !== saved.configDigest)
          throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Private repository configuration changed.')
      } finally { await config.close() }
    } finally { await repository.close() }
    const gitDirectory = join(receipt.binding.canonicalPath, receipt.materializationId, 'repository')
    if (saved.materializationId !== receipt.materializationId || saved.manifestDigest !== manifest.manifestDigest
      || saved.receiptDigest !== sourceSha256(Buffer.from(JSON.stringify(receipt))) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.generatedCommit)
      || (await qualifiedGit(gitDirectory, ['rev-parse', 'HEAD'])).toString().trim() !== saved.generatedCommit)
      throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Private repository no longer matches the original materialization.')
    return { workTree, gitDirectory, generatedCommit: saved.generatedCommit, sourceCommit: manifest.git?.commit ?? null }
  } finally { await prior.close() }
}


export const JOB_PRIVATE_GIT_LAYOUT = JOB_RUNTIME_WORKSPACE_LAYOUT
const Filesystem = z.object({device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/),mountId:z.string().regex(/^\d+$/)}).strict()
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const PrivateJobRepositoryMountsSchema = z.object({version:z.literal(1),layout:z.literal(JOB_PRIVATE_GIT_LAYOUT),
  workspaceId:z.string().min(1),executionId:z.string().min(1),attemptId:z.string().min(1),operationId:z.string().min(1),
  owner:z.object({grantId:z.string().min(1),epoch:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
  specDigest:Digest,bindingHash:Digest,materializationId:z.uuid(),materializationDigest:Digest,
  git:z.object({directory:z.string().startsWith('/'),filesystem:Filesystem,generatedCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sourceCommit:z.string().nullable(),repositoryReceiptDigest:Digest,configDigest:Digest,indexDigest:Digest,mountpoint:Filesystem}).strict(),
  scheduler:z.object({directory:z.string().startsWith('/'),filesystem:Filesystem}).strict(),
}).strict()
export type PrivateJobRepositoryMounts = z.infer<typeof PrivateJobRepositoryMountsSchema> & {receiptDigest:string}
function mountBody(raw:PrivateJobRepositoryMounts) {
  const {receiptDigest,...record}=raw
  Digest.parse(receiptDigest)
  return PrivateJobRepositoryMountsSchema.parse(record)
}
async function gitChild(parent:FileHandle,name:string) {
  const child=await open(anchored(parent,name),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try {
    const stat=await child.stat(),before=await identity(parent),after=await identity(child)
    if(stat.uid!==process.getuid?.()||(stat.mode&0o022)||before.device!==after.device||before.mountId!==after.mountId)
      throw new SourceError('SOURCE_REPOSITORY_INVALID','Original Git reference directory changed.')
    return child
  } catch(error) {await child.close();throw error}
}
const schedulerReceipt = 'job-heavy-jobs-receipt.json'
async function privateFile(directory:FileHandle,name:string,maxBytes:number):Promise<Buffer> {
  const handle=await open(anchored(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try {
    const stat=await handle.stat()
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o022)||stat.size>maxBytes)
      throw new SourceError('SOURCE_REPOSITORY_INVALID','Original private Git record changed.')
    return await handle.readFile()
  } finally {await handle.close()}
}
function jobRepositoryOwner(execution:JobExecution) {
  return {workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,
    owner:execution.owner,specDigest:execution.acceptedSpec.specDigest,bindingHash:execution.acceptedSpec.bindingHash,
    materializationId:execution.acceptedSpec.source.materializationId,materializationDigest:execution.acceptedSpec.source.materializationDigest}
}
function requireJobRepositoryOwner(execution:JobExecution,mounts:PrivateJobRepositoryMounts) {
  const expected=jobRepositoryOwner(execution),parent=dirname(execution.acceptedSpec.target.destination.canonicalProjectRoot)
  if(!isDeepStrictEqual(expected,{workspaceId:mounts.workspaceId,executionId:mounts.executionId,attemptId:mounts.attemptId,
    operationId:mounts.operationId,owner:mounts.owner,specDigest:mounts.specDigest,bindingHash:mounts.bindingHash,
    materializationId:mounts.materializationId,materializationDigest:mounts.materializationDigest})
    ||parent.split('/').at(-1)!==mounts.materializationId
    ||execution.acceptedSpec.target.destination.canonicalProjectRoot!==join(parent,'tree')
    ||mounts.git.directory!==join(parent,'repository')||mounts.scheduler.directory!==join(parent,'job-heavy-jobs')
    ||mounts.git.sourceCommit!==execution.acceptedSpec.source.commit)
    throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Git mounts belong to another original Job materialization/owner.')
}
/** Creates only exact app-owned mountpoint/state metadata under an already verified
 * original materialization. Incomplete claims persist; no aged-lock deletion or cleanup. */
export async function preparePrivateJobRepositoryMounts(input:{record:SourceMaterializationRecord;execution:JobExecution;
  attempt:MaterializationAttempt;materializer:SourceMaterializationPort;reauthorize:()=>Promise<void>}):Promise<PrivateJobRepositoryMounts> {
  const {record,execution}=input,receipt=record.receipt
  if(record.operationId!==execution.operationId||receipt.executionId!==execution.id||receipt.attemptId!==execution.attemptId
    ||receipt.binding.workspaceId!==execution.workspaceId||receipt.materializationId!==execution.acceptedSpec.source.materializationId
    ||sourceMaterializationDigest(record)!==execution.acceptedSpec.source.materializationDigest||record.finalDispatchBindingHash!==execution.acceptedSpec.bindingHash||receipt.binding.accessMode!=='exclusive-write')
    throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Scheduler reservation requires the exact original Job/source owner.')
  await input.reauthorize()
  const original=await verifyPrivateSourceRepository({receipt,attempt:input.attempt,materializer:input.materializer})
  if(original.workTree!==execution.acceptedSpec.target.destination.canonicalProjectRoot||original.sourceCommit!==execution.acceptedSpec.source.commit)
    throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original private Git placement changed.')
  const root=await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if(!isDeepStrictEqual(await identity(root),receipt.binding.filesystem))throw new SourceError('SOURCE_ROOT_CHANGED','Original Job root changed.')
    const reservation=await openChildDirectory(root,receipt.materializationId)
    try {
      try {
        const claim=JSON.parse((await privateFile(reservation,'job-heavy-jobs-claim.json',16384)).toString())
    if(!isDeepStrictEqual(claim,jobRepositoryOwner(execution)))throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original scheduler claim changed.')
    const bytes=await privateFile(reservation,schedulerReceipt,32768),saved=PrivateJobRepositoryMountsSchema.parse(JSON.parse(bytes.toString()))
        const mounts={...saved,receiptDigest:sourceSha256(bytes)}
        requireJobRepositoryOwner(execution,mounts);await input.reauthorize();await verifyPrivateJobRepositoryMounts(execution,mounts)
        return mounts
      } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      await input.reauthorize()
      // EXCL ownership fence: interrupted initialization is retained, never guessed/reinitialized.
      const claim=await open(anchored(reservation,'job-heavy-jobs-claim.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
      try {await claim.writeFile(JSON.stringify(jobRepositoryOwner(execution)));await claim.sync();await reservation.sync()} finally {await claim.close()}
      const git=await openChildDirectory(reservation,'repository')
      try {
        await mkdir(anchored(git,'graphql-heavy-jobs'),{mode:0o700})
        await mkdir(anchored(reservation,'job-heavy-jobs'),{mode:0o700})
        const mountpoint=await openChildDirectory(git,'graphql-heavy-jobs'),scheduler=await openChildDirectory(reservation,'job-heavy-jobs')
        try {
          if((await readdir(anchored(mountpoint))).length||(await readdir(anchored(scheduler))).length)throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Only fresh private scheduler directories may be reserved.')
          const saved=PrivateJobRepositoryMountsSchema.parse({version:1,layout:JOB_PRIVATE_GIT_LAYOUT,...jobRepositoryOwner(execution),
            git:{directory:original.gitDirectory,filesystem:await identity(git),generatedCommit:original.generatedCommit,sourceCommit:original.sourceCommit,
              repositoryReceiptDigest:sourceSha256(await privateFile(reservation,'repository-receipt.json',16384)),
              configDigest:sourceSha256(await privateFile(git,'config',16384)),indexDigest:sourceSha256(await privateFile(git,'index',4*1024*1024)),mountpoint:await identity(mountpoint)},
            scheduler:{directory:join(receipt.binding.canonicalPath,receipt.materializationId,'job-heavy-jobs'),filesystem:await identity(scheduler)}})
          await input.reauthorize()
          const bytes=Buffer.from(JSON.stringify(saved)),file=await open(anchored(reservation,schedulerReceipt),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
          try {await file.writeFile(bytes);await file.sync()} finally {await file.close()}
          await mountpoint.sync();await scheduler.sync();await git.sync();await reservation.sync();await root.sync()
          const mounts={...saved,receiptDigest:sourceSha256(bytes)}
          requireJobRepositoryOwner(execution,mounts);await input.reauthorize();await verifyPrivateJobRepositoryMounts(execution,mounts)
          return mounts
        } finally {await mountpoint.close();await scheduler.close()}
      } finally {await git.close()}
    } finally {await reservation.close()}
  } finally {await root.close()}
}
/** Read-only original-record check before native create. Does not initialize Git,
 * reopen arbitrary paths, drop held state, or reverify an already mutable Job tree. */
export async function verifyPrivateJobRepositoryMounts(execution:JobExecution,raw:PrivateJobRepositoryMounts):Promise<void> {
  const mounts={...mountBody(raw),receiptDigest:raw.receiptDigest}
  requireJobRepositoryOwner(execution,mounts)
  const reservation=await openPrivateRoot(dirname(mounts.git.directory))
  try {
    const claim=JSON.parse((await privateFile(reservation,'job-heavy-jobs-claim.json',16384)).toString())
    if(!isDeepStrictEqual(claim,jobRepositoryOwner(execution)))throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original scheduler claim changed.')
    const bytes=await privateFile(reservation,schedulerReceipt,32768)
    if(sourceSha256(bytes)!==mounts.receiptDigest||!isDeepStrictEqual(PrivateJobRepositoryMountsSchema.parse(JSON.parse(bytes.toString())),mountBody(mounts)))
      throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original scheduler receipt changed.')
    const repositoryReceipt=await privateFile(reservation,'repository-receipt.json',16384)
    if(sourceSha256(repositoryReceipt)!==mounts.git.repositoryReceiptDigest)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original repository receipt changed.')
    const original=JSON.parse(repositoryReceipt.toString()) as {generatedCommit:string;configDigest:string}
    if(original.generatedCommit!==mounts.git.generatedCommit||original.configDigest!==mounts.git.configDigest)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original Git pins changed.')
    const git=await openChildDirectory(reservation,'repository'),scheduler=await openChildDirectory(reservation,'job-heavy-jobs')
    try {
      if(!isDeepStrictEqual(await identity(git),mounts.git.filesystem)||!isDeepStrictEqual(await identity(scheduler),mounts.scheduler.filesystem))
        throw new SourceError('SOURCE_ROOT_CHANGED','Original Git/scheduler directory identity changed.')
      const mountpoint=await openChildDirectory(git,'graphql-heavy-jobs')
      try {if(!isDeepStrictEqual(await identity(mountpoint),mounts.git.mountpoint)||(await readdir(anchored(mountpoint))).length)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original empty scheduler mountpoint changed.')} finally {await mountpoint.close()}
      if(sourceSha256(await privateFile(git,'config',16384))!==mounts.git.configDigest||sourceSha256(await privateFile(git,'index',4*1024*1024))!==mounts.git.indexDigest)
        throw new SourceError('SOURCE_REPOSITORY_INVALID','Original Git configuration/index changed.')
      const head=(await privateFile(git,'HEAD',4096)).toString().trim()
      let commit=head
      if(head.startsWith('ref: ')) {
        const ref=head.slice(5)
        if(!/^refs\/heads\/[a-zA-Z0-9_-]+$/.test(ref))throw new SourceError('SOURCE_REPOSITORY_INVALID','Unexpected original private Git HEAD.')
        const refs=await gitChild(git,'refs'),heads=await gitChild(refs,'heads')
        try {commit=(await privateFile(heads,ref.slice('refs/heads/'.length),4096)).toString().trim()} finally {await heads.close();await refs.close()}
      }
      if(commit!==mounts.git.generatedCommit)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original private Git HEAD changed.')
    } finally {await git.close();await scheduler.close()}
  } finally {await reservation.close()}
}
