import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { DashboardShell } from '../layout/DashboardShell'
import { CartridgeSubassemblyPage } from '../features/cartridgeSubassembly/CartridgeSubassemblyPage'
import { ROUTE_CARTRIDGE_SUBASSEMBLY } from '../shared/contracts'

const rootRoute = createRootRoute({
  component: () => (
    <DashboardShell>
      <Outlet />
    </DashboardShell>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: CartridgeSubassemblyPage,
})

const cartridgeSubassemblyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_CARTRIDGE_SUBASSEMBLY,
  component: CartridgeSubassemblyPage,
})

const routeTree = rootRoute.addChildren([indexRoute, cartridgeSubassemblyRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
