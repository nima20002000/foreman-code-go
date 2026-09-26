import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { ApprovalInboxSearchSchema, UrlSearchSelectionSchema } from '@graphql/contracts'
import { WorkspaceBoardSearchSchema } from '@graphql/contracts/wave25'
import { RootShell } from './RootShell'
import { BrowserAuthSearchSchema } from '@graphql/contracts/management'
import { SignInRoute, OwnerSetupRoute } from '../features/auth/AuthRoutes'
import { AgentSettingsSearchSchema, HarnessSettingsSearchSchema } from '@graphql/contracts/management'
import { AccountRouteEntry, WorkspaceDefaultsSettingsRouteEntry } from '../routes/SettingsExperienceRoutes'

import { WorkspaceRouteEntry } from '../routes/WorkspaceRouteEntry'
import {
  AgentsRouteEntry,
  BrowsersSettingsRouteEntry,
  ComingSoonRouteEntry,
  GlobalComingSoonRouteEntry,
  GlobalSettingsRouteEntry,
  HarnessSettingsRouteEntry,
  AgentSettingsRouteEntry,
  WorkflowSettingsRouteEntry,
  OperatorAccessSettingsRouteEntry,
  GlobalApprovalsRouteEntry,
  WorkspaceApprovalsRouteEntry,
  WorkspaceLocationSettingsRouteEntry,
  SettingsRouteEntry,
  WorkflowsRouteEntry,
  WorkspacesRouteEntry,
} from '../routes/WorkspaceSectionRoutes'

const rootRoute = createRootRoute({ component: RootShell })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/workspaces' })
  },
})

const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  component: WorkspacesRouteEntry,
})

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId',
  validateSearch: WorkspaceBoardSearchSchema,
  component: WorkspaceRouteEntry,
})

// Linkable Board selections are children of the board, not independent screen mounts.
const nextDraftRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'workflows/$workflowId/draft',
})

const runGraphRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'workflows/$workflowId/runs/$runId/graph/$workflowVersionId/$executionSemanticsVersion',
})

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/workflows',
  component: WorkflowsRouteEntry,
})

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/agents',
  validateSearch: UrlSearchSelectionSchema,
  component: AgentsRouteEntry,
})

function comingSoonRoute(
  path:
    | '/workspaces/$workspaceId/tasks'
    | '/workspaces/$workspaceId/runs'
    | '/workspaces/$workspaceId/terminal'
    | '/workspaces/$workspaceId/files',
  section: 'tasks' | 'runs' | 'terminal' | 'files',
  label: string,
) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <ComingSoonRouteEntry section={section} label={label} />,
  })
}

const tasksRoute = comingSoonRoute('/workspaces/$workspaceId/tasks', 'tasks', 'Tasks')
const runsRoute = comingSoonRoute('/workspaces/$workspaceId/runs', 'runs', 'Runs')
const terminalRoute = comingSoonRoute('/workspaces/$workspaceId/terminal', 'terminal', 'Terminal')
const filesRoute = comingSoonRoute('/workspaces/$workspaceId/files', 'files', 'Files')
const browsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/browsers',
  component: BrowsersSettingsRouteEntry,
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/settings',
  component: SettingsRouteEntry,
})
const workspaceLocationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/settings/location',
  component: WorkspaceLocationSettingsRouteEntry,
})
const globalTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: () => <GlobalComingSoonRouteEntry section="terminal" label="Terminal" />,
})
const globalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: GlobalSettingsRouteEntry,
})
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: AccountRouteEntry,
})
const harnessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/harnesses',
  validateSearch: HarnessSettingsSearchSchema,
  component: HarnessSettingsRouteEntry,
})
const agentSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/agents',
  validateSearch: AgentSettingsSearchSchema,
  component: AgentSettingsRouteEntry,
})
const workspaceDefaultsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/workspaces',
  component: WorkspaceDefaultsSettingsRouteEntry,
})
const workflowSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/workflows',
  component: WorkflowSettingsRouteEntry,
})
const operatorAccessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/operator-access',
  component: OperatorAccessSettingsRouteEntry,
})
const globalApprovalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/approvals',
  validateSearch: ApprovalInboxSearchSchema,
  component: GlobalApprovalsRouteEntry,
})
const workspaceApprovalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/approvals',
  validateSearch: ApprovalInboxSearchSchema,
  component: WorkspaceApprovalsRouteEntry,
})

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: BrowserAuthSearchSchema,
  component: SignInRoute,
})
const ownerSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  validateSearch: BrowserAuthSearchSchema,
  component: OwnerSetupRoute,
})

export const routeTree = rootRoute.addChildren([
  signInRoute,
  ownerSetupRoute,
  indexRoute,
  workspacesRoute,
  workspaceRoute.addChildren([nextDraftRoute, runGraphRoute]),
  workflowsRoute,
  agentsRoute,
  browsersRoute,
  tasksRoute,
  runsRoute,
  terminalRoute,
  filesRoute,
  settingsRoute,
  workspaceLocationSettingsRoute,
  globalTerminalRoute,
  globalSettingsRoute,
  accountRoute,
  harnessSettingsRoute,
  agentSettingsRoute,
  workflowSettingsRoute,
  workspaceDefaultsSettingsRoute,
  operatorAccessSettingsRoute,
  globalApprovalsRoute,
  workspaceApprovalsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
