import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { FileWithRevision } from '@graphql/contracts/files'
import { JobInputAuthority } from '../src/modules/files/jobInputs/authority.js'
import type { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import type { JobPreparationPort } from '../src/modules/jobs/ports.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
const principal:ManagementPrincipal={id:'actor',name:'Actor',audience:'operator',grants:[{actions:['workspaces:read'],scope:{workspaceIds:['workspace']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
function fixture(){const pool=new pg.Pool(),authority=new JobInputAuthority(pool,{} as PostgresJobDispatch,{} as JobPreparationPort);let revoked=false;const statements:string[]=[]
 const sql={query:async(statement:string)=>{statements.push(statement);if(statement.includes('management_principals'))return {rows:[{id:principal.id,name:principal.name,audience:principal.audience,grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:revoked?new Date():null,delegated_from:null}]};if(statement.includes('workspaces'))return {rows:[{archived_at:null}]};throw new Error(`Unexpected query: ${statement}`)}} as JobSql
 const pin={path:'input.md',fileId:'file',revisionId:'revision',sha256:'1'.repeat(64),byteSize:3},value={file:{fileId:'file',currentRevisionId:'revision',createdAt:'2026-10-01T00:00:00.000Z',scope:{kind:'workspace_reference',workspaceId:'workspace'},state:'ready'},revision:pin} as unknown as FileWithRevision
 const read=vi.spyOn(authority.files,'read').mockResolvedValue({value,storageKey:'opaque',lifecycleState:'ready'} as never)
 return {pool,authority,sql,pin,read,statements,value,revoke:()=>{revoked=true}}
}
afterEach(()=>vi.restoreAllMocks())
it('supports empty declared inputs with actual live SQL authority, without execution or bytes',async()=>{const f=fixture();try{await f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[]);expect(f.statements).toHaveLength(1);expect(f.read).not.toHaveBeenCalled()}finally{await f.pool.end()}})
it('validates exact revision and scope through canonical metadata at Save/Start',async()=>{const f=fixture();try{await f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[f.pin]);expect(f.read).toHaveBeenCalledWith('file','revision',f.sql);expect(f.statements.some(value=>value.includes('from workspaces'))).toBe(true)}finally{await f.pool.end()}})
it('rejects a changed pinned digest and cross-workspace source',async()=>{const f=fixture();try{await expect(f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[{...f.pin,sha256:'2'.repeat(64)}])).rejects.toThrow('differs');await expect(f.authority.validateDeclaredJobInputs(f.sql,principal,'elsewhere',[f.pin])).rejects.toThrow('outside')}finally{await f.pool.end()}})
it('rejects revocation before even an empty input admission',async()=>{const f=fixture();try{f.revoke();await expect(f.authority.validateDeclaredJobInputs(f.sql,principal,'workspace',[])).rejects.toThrow('no longer active')}finally{await f.pool.end()}})
