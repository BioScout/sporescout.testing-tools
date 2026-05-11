import { Link, Outlet, createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Box, Button, Stack, Typography } from '@mui/material'
import { DashboardShell } from '../layout/DashboardShell'
import { CartridgeSubassemblyPage } from '../features/cartridgeSubassembly/CartridgeSubassemblyPage'
import { LinearStagePage } from '../features/linearStage/LinearStagePage'
import { ROUTE_CARTRIDGE_SUBASSEMBLY, ROUTE_LINEAR_STAGE } from '../shared/contracts'

const rootRoute = createRootRoute({
  component: () => (
    <DashboardShell>
      <Outlet />
    </DashboardShell>
  ),
  notFoundComponent: NotFoundPage,
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

const linearStageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_LINEAR_STAGE,
  component: LinearStagePage,
})

const routeTree = rootRoute.addChildren([indexRoute, cartridgeSubassemblyRoute, linearStageRoute])

const packagedFileHistory =
  typeof window !== 'undefined' && window.location.protocol === 'file:' ? createHashHistory() : undefined

export const router = createRouter({
  routeTree,
  ...(packagedFileHistory ? { history: packagedFileHistory } : {}),
})

function NotFoundPage() {
  return (
    <Box
      sx={{
        minHeight: 'calc(100vh - 8rem)',
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
      }}
    >
      <Stack spacing={2} alignItems="center">
        <Typography variant="h5">Page not found</Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 480 }}>
          This local manufacturing tool only includes cartridge subassembly and linear stage workflows.
        </Typography>
        <Button variant="contained" component={Link} to={ROUTE_CARTRIDGE_SUBASSEMBLY}>
          Open Cartridge Subassembly
        </Button>
      </Stack>
    </Box>
  )
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
