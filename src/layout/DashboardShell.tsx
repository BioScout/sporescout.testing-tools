import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import ChecklistIcon from '@mui/icons-material/Checklist'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import CloseIcon from '@mui/icons-material/Close'
import EngineeringIcon from '@mui/icons-material/Engineering'
import MenuIcon from '@mui/icons-material/Menu'
import {
  AppBar,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Divider,
  Drawer,
  IconButton,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import { grey } from '@mui/material/colors'
import { useState } from 'react'
import logoUrl from '../assets/logo-full.svg?url'
import { DASHBOARD_SIDEBAR_WIDTH } from '../shared/contracts'

interface DashboardShellProps {
  children: React.ReactNode
}

const topBarHeights = ['3.5rem', '4rem'] as const

export function DashboardShell({ children }: DashboardShellProps) {
  const theme = useTheme()
  const [drawerOpen, setDrawerOpen] = useState(true)

  const openedMixin = {
    width: DASHBOARD_SIDEBAR_WIDTH,
    transition: theme.transitions.create('width', {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
    overflowX: 'hidden',
  }

  const closedMixin = {
    transition: theme.transitions.create('width', {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
    overflowX: 'hidden',
    width: { xs: 0, sm: 0, md: `calc(${theme.spacing(8)} + 1px)` },
  }

  return (
    <Box sx={{ display: 'flex', position: 'relative', height: '100vh' }}>
      <AppBar
        position="fixed"
        elevation={2}
        sx={{
          zIndex: theme.zIndex.drawer + (drawerOpen ? -1 : 1),
          transition: theme.transitions.create(['width', 'margin'], {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.leavingScreen,
          }),
          ...(drawerOpen && {
            marginLeft: { xs: 0, sm: 0, md: DASHBOARD_SIDEBAR_WIDTH },
            width: {
              xs: '100%',
              sm: '100%',
              md: `calc(100% - ${DASHBOARD_SIDEBAR_WIDTH}px)`,
            },
            transition: theme.transitions.create(['width', 'margin'], {
              easing: theme.transitions.easing.sharp,
              duration: theme.transitions.duration.enteringScreen,
            }),
          }),
        }}
      >
        <Toolbar sx={{ zIndex: 1190, display: 'flex', gap: '0.5rem', minHeight: topBarHeights }}>
          <IconButton
            size="large"
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <ChevronLeftIcon /> : <MenuIcon />}
          </IconButton>
          <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0, gap: 1 }}>
            <Typography
              variant="h6"
              component="div"
              noWrap
              sx={{
                fontSize: '1.3rem',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: 'flex',
                alignItems: 'center',
                flex: '0 1 auto',
              }}
            >
              Cartridge Subassembly
            </Typography>
          </Box>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        open={drawerOpen}
        elevation={4}
        sx={{
          width: DASHBOARD_SIDEBAR_WIDTH,
          flexShrink: 0,
          whiteSpace: 'nowrap',
          boxSizing: 'border-box',
          ...(drawerOpen
            ? {
                ...openedMixin,
                '& .MuiDrawer-paper': openedMixin,
              }
            : {
                ...closedMixin,
                '& .MuiDrawer-paper': closedMixin,
              }),
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            height: topBarHeights,
          }}
        >
          <Box component="img" src={logoUrl} sx={{ maxWidth: '6rem' }} />
          <IconButton
            size="large"
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={() => setDrawerOpen(false)}
            sx={{ position: 'absolute', top: 8, right: 0, color: grey[900] }}
          >
            {drawerOpen && <CloseIcon />}
          </IconButton>
        </Box>
        <Divider />
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {drawerOpen ? <ManufacturingAccordion /> : <CollapsedCartridgeLink />}
          </Box>
        </Box>
      </Drawer>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          position: { xs: 'absolute', sm: 'absolute', md: 'relative' },
          top: { xs: topBarHeights[0], sm: topBarHeights[1], md: 'initial' },
          height: {
            xs: `calc(100vh - ${topBarHeights[0]})`,
            sm: `calc(100vh - ${topBarHeights[1]})`,
            md: 'auto',
          },
          width: { xs: '100%', sm: '100%', md: 'auto' },
          overflowY: 'auto',
          backgroundColor: grey[50],
          px: { xs: 1, sm: '1rem', md: theme.spacing(3) },
          pt: { xs: 2, sm: '1rem', md: theme.spacing(3) },
          pb: { xs: '6rem', sm: '1rem', md: theme.spacing(3) },
          mt: { xs: 0, sm: 0, md: topBarHeights[1] },
          transition: theme.transitions.create('margin', {
            easing: theme.transitions.easing.sharp,
            duration: theme.transitions.duration.leavingScreen,
          }),
          ...(drawerOpen && {
            transition: theme.transitions.create('margin', {
              easing: theme.transitions.easing.easeOut,
              duration: theme.transitions.duration.enteringScreen,
            }),
            marginLeft: 0,
          }),
        }}
      >
        {children}
      </Box>
    </Box>
  )
}

function ManufacturingAccordion() {
  return (
    <Accordion expanded disableGutters sx={{ boxShadow: 'none', border: 'none', color: 'primary.secondary' }}>
      <AccordionSummary
        expandIcon={<ArrowDropDownIcon />}
        sx={{
          display: 'flex',
          alignItems: 'center',
          '&:hover': {
            backgroundColor: grey[100],
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            gap: '0.5rem',
            py: '0.25rem',
            color: 'primary.main',
          }}
        >
          <EngineeringIcon />
          <Typography sx={{ pl: '0.25rem' }}>Manufacturing</Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', p: 0, pl: '1rem' }}>
        <CartridgeMenuItem drawerOpen />
      </AccordionDetails>
    </Accordion>
  )
}

function CollapsedCartridgeLink() {
  return <CartridgeMenuItem drawerOpen={false} />
}

function CartridgeMenuItem({ drawerOpen }: { drawerOpen: boolean }) {
  return (
    <Tooltip title="Cartridge Subassembly" placement="right" disableHoverListener={drawerOpen}>
      <ListItemButton
        selected
        sx={{
          minHeight: 48,
          justifyContent: drawerOpen ? 'initial' : 'center',
          py: '0.7rem',
        }}
      >
        <ListItemIcon
          sx={{
            minWidth: 0,
            mr: drawerOpen ? '0.4rem' : 0,
            justifyContent: 'center',
            color: 'primary.main',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <ChecklistIcon />
          {drawerOpen && (
            <ListItemText
              primary="Cartridge Subassembly"
              sx={{
                opacity: 1,
                color: 'primary.main',
                pl: '0.7rem',
              }}
            />
          )}
        </ListItemIcon>
      </ListItemButton>
    </Tooltip>
  )
}
