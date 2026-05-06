import { createTheme } from '@mui/material/styles'
import { DASHBOARD_PRIMARY, DASHBOARD_SECONDARY } from '../shared/contracts'

export const dashboardTheme = createTheme({
  palette: {
    primary: {
      main: DASHBOARD_PRIMARY,
    },
    secondary: {
      main: DASHBOARD_SECONDARY,
    },
    background: {
      default: '#fafafa',
      paper: '#ffffff',
    },
  },
  typography: {
    fontFamily: '"Roboto", sans-serif',
    h5: {
      fontWeight: 500,
      letterSpacing: 0,
    },
    h6: {
      fontWeight: 500,
      letterSpacing: 0,
    },
    button: {
      textTransform: 'none',
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          boxShadow: 'none',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
  },
})
