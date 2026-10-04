import { afterEach,describe,expect,it,vi } from 'vitest'
import pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator,commandInputHash } from '../src/modules/commands/postgres.js'
const principal:ManagementPrincipal={id:'actual-job-command-actor',name:'Job actor',audience:'operator',grants:[],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
afterEach(()=>vi.restoreAllMocks())
function fixture(options:{receipt?:unknown;failReceipt?:boolean}={}) {
  let inTransaction=false,writes:string[]=[]
  const committed:string[]=[]
  const query=vi.fn(async(text:string)=>{
    if(text==='begin'){inTransaction=true;writes=[]}
    if(text==='commit'){committed.push(...writes);inTransaction=false;writes=[]}
    if(text==='rollback'){inTransaction=false;writes=[]}
    if(text.startsWith('insert')) {
      expect(inTransaction).toBe(true)
      if(options.failReceipt&&text.includes('management_command_receipts'))throw new Error('receipt persistence failed')
      writes.push(text)
    }
    return {rows:text.includes('select input_hash')&&options.receipt?[options.receipt]:[],rowCount:0,command:'SELECT',oid:0,fields:[]}
  })
  const client={query,release:vi.fn()},connection={options:{},connect:async()=>client,end:vi.fn(async()=>undefined)}
  vi.spyOn(pg,'Pool').mockImplementation(function(){return connection} as never)
  return {coordinator:new PostgresCommandCoordinator(connection as unknown as pg.Pool),query,committed,get inTransaction(){return inTransaction}}
}
describe('job acceptance and original command receipt atomicity',()=>{
  it('does source preparation outside SQL and commits job, dispatch, command receipt and audit together',async()=>{
    const f=fixture(),prepare=vi.fn(async()=>expect(f.inTransaction).toBe(false)),authorize=vi.fn(async()=>undefined)
    await f.coordinator.execute({principal,source:'mcp',operation:'job.start',commandId:'start-command',targetKey:'workspace',payload:{definitionId:'actual-definition'},dedicatedConnection:true,authorize,prepare,perform:async sql=>{
      expect(f.inTransaction).toBe(true);await sql.query('insert into job_executions values ($1)',['actual-job']);await sql.query('insert into job_dispatch_intents values ($1)',['actual-operation']);return {id:'actual-job'}
    }})
    expect(prepare).toHaveBeenCalledOnce();expect(authorize).toHaveBeenCalledTimes(2)
    expect(f.committed).toHaveLength(4);expect(f.committed[2]).toContain('management_command_receipts');expect(f.committed[3]).toContain('management_audit')
  })
  it('rolls back the job and dispatch if command receipt persistence fails',async()=>{
    const f=fixture({failReceipt:true})
    await expect(f.coordinator.execute({principal,source:'http',operation:'job.start',commandId:'start-command',targetKey:'workspace',payload:{},dedicatedConnection:true,prepare:async()=>undefined,perform:async sql=>{await sql.query('insert into job_executions values ($1)',['actual-job']);await sql.query('insert into job_dispatch_intents values ($1)',['actual-operation']);return {id:'actual-job'}}})).rejects.toThrow('receipt persistence failed')
    expect(f.committed).toEqual([]);expect(f.query.mock.calls.some(([sql])=>sql==='rollback')).toBe(true)
  })
  it('returns the original accepted execution on command retry without another preparation or admission',async()=>{
    const payload={definitionId:'actual-definition'},f=fixture({receipt:{input_hash:commandInputHash(payload),target_key:'workspace',result:{id:'original-job'}}}),prepare=vi.fn(),perform=vi.fn()
    const result=await f.coordinator.execute({principal,source:'mcp',operation:'job.start',commandId:'start-command',targetKey:'workspace',payload,dedicatedConnection:true,prepare,perform})
    expect(result).toEqual({value:{id:'original-job'},replayed:true});expect(prepare).not.toHaveBeenCalled();expect(perform).not.toHaveBeenCalled()
  })
})
