import { JobRuntimeProfileSaveRecordSchema } from '@graphql/contracts/job-verification-runtime'
import type { FastifyInstance } from 'fastify'
import { JobRuntimeQualificationCommandSchema } from '@foreman-code/contracts/job-runtime'
import { z } from 'zod'
import { requireBrowserSession, requirePrincipal } from '../modules/access/http.js'
import type { JobRuntimeProfiles } from '../modules/jobs/runtimeProfiles.js'
interface Scope {workspaceId:string;profileId:string;approvalId:string}
export function registerJobRuntimeProfileRoutes(app:FastifyInstance,service:JobRuntimeProfiles):void {
  const root='/api/management/workspaces/:workspaceId/jobs'
  app.get<{Params:Scope}>(`${root}/runtime-profiles`,request=>service.list(requirePrincipal(request),request.params.workspaceId))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-profiles`,async request=>({profile:await service.save(requirePrincipal(request),'http',request.params.workspaceId,JobRuntimeProfileSaveRecordSchema.parse(request.body))}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-profiles/:profileId/qualification-requests`,async request=>{
    const input=z.object({commandId:z.string().min(1),expectedRevision:z.number().int().positive()}).strict().parse(request.body)
    return {approval:await service.requestQualification(requirePrincipal(request),'http',request.params.workspaceId,{...input,profileId:request.params.profileId})}
  })
  app.get<{Params:Scope}>(`${root}/runtime-qualifications/:approvalId`,request=>service.getQualification(requirePrincipal(request),request.params.workspaceId,request.params.approvalId))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-qualifications/:approvalId/run`,async request=>({profile:await service.qualify(requirePrincipal(request),'http',request.params.workspaceId,JobRuntimeQualificationCommandSchema.parse(request.body).commandId,request.params.approvalId)}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-qualifications/:approvalId/approve`,async request=>{requireBrowserSession(request);return {approval:await service.approve(requirePrincipal(request),'http',request.params.workspaceId,JobRuntimeQualificationCommandSchema.parse(request.body).commandId,request.params.approvalId)}})
}
