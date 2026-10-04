import { WorkflowVersionV3Schema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
/** Existing native-only tests must prove they did not receive a non-agent job node. */
export function agentOnlyVersion(value:unknown) {
  const version=WorkflowVersionV3Schema.parse(value)
  const nodes=version.definition.nodes.map(node=>{if(node.kind==='job')throw new Error('Native fixture contains a job node');return node})
  return {...version,definition:{...version.definition,nodes}}
}
export type AgentOnlyVersion=ReturnType<typeof agentOnlyVersion>
export function nativeNode(version:WorkflowVersionV3,index:number) {
  const node=version.definition.nodes[index]
  if(!node||node.kind==='job')throw new Error('Native fixture requires an actual Agent node')
  return node
}
export function nativeGraphNode(graph:WorkflowVersionV3['definition'],index:number) {
  const node=graph.nodes[index]
  if(!node||node.kind==='job')throw new Error('Native fixture requires an actual Agent node')
  return node
}
