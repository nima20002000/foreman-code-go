import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { UrlSearchSelectionSchema } from '@graphql/contracts'
import { RootShell } from './RootShell'

import { WorkspaceRouteEntry } from '../routes/WorkspaceRouteEntry'
import {
  AgentsRouteEntry,
  BrowsersSettingsRouteEntry,
  ComingSoonRouteEntry,
  GlobalComingSoonRouteEntry,
  GlobalSettingsRouteEntry,
  HarnessSettingsRouteEntry,
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
  validateSearch: UrlSearchSelectionSchema,
  component: WorkspaceRouteEntry,
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
const harnessSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/harnesses',
  component: HarnessSettingsRouteEntry,
})

export const routeTree = rootRoute.addChildren([
  indexRoute,
  workspacesRoute,
  workspaceRoute,
  workflowsRoute,
  agentsRoute,
  browsersRoute,
  tasksRoute,
  runsRoute,
  terminalRoute,
  filesRoute,
  settingsRoute,
  globalTerminalRoute,
  globalSettingsRoute,
  harnessSettingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
