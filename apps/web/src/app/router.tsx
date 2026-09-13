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
  path: '/workspaces/$workspaceId/tasks' | '/workspaces/$workspaceId/runs' | '/workspaces/$workspaceId/terminal',
  section: 'tasks' | 'runs' | 'terminal',
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

export const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute,
  agentsRoute,
  browsersRoute,
  tasksRoute,
  runsRoute,
  terminalRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
