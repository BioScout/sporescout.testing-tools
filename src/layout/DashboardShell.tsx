import BuildIcon from '@mui/icons-material/Build'
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing'
import {
  AppBar,
  Box,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
  useTheme,
} from '@mui/material'
import { DASHBOARD_SIDEBAR_WIDTH } from '../shared/contracts'

interface DashboardShellProps {
  children: React.ReactNode
}

export function DashboardShell({ children }: DashboardShellProps) {
  const theme = useTheme()

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: 'grey.50' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          width: `calc(100% - ${DASHBOARD_SIDEBAR_WIDTH}px)`,
          ml: `${DASHBOARD_SIDEBAR_WIDTH}px`,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Toolbar sx={{ minHeight: { xs: '3.5rem', sm: '4rem' }, gap: 2 }}>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Cartridge Subassembly
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Manufacturing
          </Typography>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width: DASHBOARD_SIDEBAR_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: DASHBOARD_SIDEBAR_WIDTH,
            boxSizing: 'border-box',
            borderRight: `1px solid ${theme.palette.divider}`,
          },
        }}
      >
        <Toolbar sx={{ minHeight: { xs: '3.5rem', sm: '4rem' }, px: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <PrecisionManufacturingIcon color="primary" />
            <Typography variant="subtitle1" fontWeight={500}>
              BioScout
            </Typography>
          </Box>
        </Toolbar>
        <Divider />
        <List sx={{ px: 1, py: 1.5 }}>
          <ListItemButton selected sx={{ borderRadius: 1, mb: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 38, color: 'primary.main' }}>
              <BuildIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Manufacturing" primaryTypographyProps={{ variant: 'body2' }} />
          </ListItemButton>
          <ListItemButton selected sx={{ borderRadius: 1, pl: 5 }}>
            <ListItemText
              primary="Cartridge Subassembly"
              primaryTypographyProps={{ variant: 'body2', color: 'primary.main' }}
            />
          </ListItemButton>
        </List>
      </Drawer>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          height: '100vh',
          overflow: 'auto',
          pt: { xs: '3.5rem', sm: '4rem' },
          bgcolor: 'grey.50',
        }}
      >
        <Box sx={{ p: { xs: 2, md: 3 } }}>{children}</Box>
      </Box>
    </Box>
  )
}
