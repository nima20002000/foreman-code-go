import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { UrlSearchSelectionSchema } from '@graphql/contracts'

import { App } from './App'
import { WorkspaceRouteEntry } from '../routes/WorkspaceRouteEntry'

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

export const routeTree = rootRoute.addChildren([indexRoute, workspaceRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
