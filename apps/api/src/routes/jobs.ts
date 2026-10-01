import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { JobDefinitionSaveSchema, JobDefinitionSpecSchema, JobStartSchema } from '@graphql/contracts/jobs'
import { requirePrincipal } from '../modules/access/http.js'
import type { JobService } from '../modules/jobs/service.js'
interface Scope {workspaceId:string;definitionId:string;executionId:string;fileId:string;revisionId:string}
export function registerJobRoutes(app:FastifyInstance,service:JobService):void {
  const root='/api/management/workspaces/:workspaceId/jobs'
  app.get<{Params:Scope}>(`${root}/choices`,async request=>service.choices(requirePrincipal(request),request.params.workspaceId))
  app.get<{Params:Scope}>(`${root}/definitions`,async request=>({definitions:await service.listDefinitions(requirePrincipal(request),request.params.workspaceId)}))
  app.get<{Params:Scope}>(`${root}/definitions/:definitionId`,async request=>({definition:await service.getDefinition(requirePrincipal(request),request.params.workspaceId,request.params.definitionId)}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/definitions`,async request=>({definition:await service.saveDefinition(requirePrincipal(request),'http',request.params.workspaceId,JobDefinitionSaveSchema.parse(request.body))}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/validate`,async request=>service.validate(requirePrincipal(request),request.params.workspaceId,z.object({spec:JobDefinitionSpecSchema}).strict().parse(request.body).spec))
  app.post<{Params:Scope;Body:unknown}>(`${root}/executions`,async request=>({execution:await service.start(requirePrincipal(request),'http',request.params.workspaceId,JobStartSchema.parse(request.body))}))
  app.get<{Params:Scope}>(`${root}/executions`,async request=>({executions:await service.listExecutions(requirePrincipal(request),request.params.workspaceId)}))
  app.get<{Params:Scope}>(`${root}/executions/:executionId`,async request=>({execution:await service.getExecution(requirePrincipal(request),request.params.workspaceId,request.params.executionId)}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/executions/:executionId/cancel`,async request=>({execution:await service.cancel(requirePrincipal(request),'http',request.params.workspaceId,request.params.executionId,z.object({commandId:z.string().min(1)}).strict().parse(request.body).commandId)}))
  app.get<{Params:Scope;Querystring:unknown}>(`${root}/executions/:executionId/logs`,async request=>{
    const query=z.object({afterSequence:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(request.query)
    return service.readLogs(requirePrincipal(request),request.params.workspaceId,request.params.executionId,query.afterSequence,query.limit)
  })
  app.get<{Params:Scope}>(`${root}/executions/:executionId/artifacts`,async request=>({artifacts:await service.listArtifacts(requirePrincipal(request),request.params.workspaceId,request.params.executionId)}))
  app.get<{Params:Scope}>(`${root}/executions/:executionId/artifacts/:fileId/revisions/:revisionId/content`,async(request,reply)=>{
    const {workspaceId,executionId,fileId,revisionId}=request.params
    const {artifact,bytes}=await service.readArtifact(requirePrincipal(request),workspaceId,executionId,fileId,revisionId)
    reply.header('content-type','application/octet-stream').header('content-disposition','attachment').header('x-content-type-options','nosniff').header('cache-control','no-store')
    reply.header('x-artifact-sha256',artifact.sha256)
    return reply.send(bytes)
  })
}
