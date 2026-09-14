import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { UrlSearchSelectionSchema } from '@graphql/contracts'

import { App } from './App'
import { WorkspaceRouteEntry } from '../routes/WorkspaceRouteEntry'
import {
  AgentsRouteEntry,
  BrowsersSettingsRouteEntry,
  ComingSoonRouteEntry,
  GlobalComingSoonRouteEntry,
  GlobalSettingsRouteEntry,
  SettingsRouteEntry,
} from '../routes/WorkspaceSectionRoutes'

const rootRoute = createRootRoute({
  component: Outlet,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: App,
})

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId',
  validateSearch: UrlSearchSelectionSchema,
  component: WorkspaceRouteEntry,
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

export const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute,
  agentsRoute,
  browsersRoute,
  tasksRoute,
  runsRoute,
  terminalRoute,
  filesRoute,
  settingsRoute,
  globalTerminalRoute,
  globalSettingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
