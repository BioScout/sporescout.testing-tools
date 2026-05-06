import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloseIcon from '@mui/icons-material/Close'
import DownloadDoneIcon from '@mui/icons-material/DownloadDone'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import KeyIcon from '@mui/icons-material/Key'
import LockIcon from '@mui/icons-material/Lock'
import LockOpenIcon from '@mui/icons-material/LockOpen'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import ScienceIcon from '@mui/icons-material/Science'
import UsbIcon from '@mui/icons-material/Usb'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_STATION_SETTINGS,
  ENGINEERING_PASSWORD,
  type ConnectionMode,
  type GuiEventEnvelope,
  type MeasurementSummary,
  type OverrideRecord,
  type ReadinessItem,
  type SerialPortInfo,
  type StationSettings,
  type StorageSummary,
  type TestPhase,
  type UpdateCheckResult,
} from '../../shared/contracts'
import { explainCartridgeSerial, isValidCartridgeSerial, normalizeCartridgeSerial } from '../../shared/cartridgeSerial'
import { parseSerialLine } from '../../shared/serialParser'
import {
  FLOW_STEPS,
  buildCartridgeOpenCommand,
  buildCartridgePhaseCommand,
  buildReadinessItems,
  extractGuidance,
  extractMeasurement,
  extractRunUid,
  markReadinessItem,
  progressLabel,
  type WorkflowStepId,
} from '../../shared/workflow'
import { getTestingToolsApi } from '../../services/testingToolsApi'

type GuidanceState = {
  guidance?: string
  sealedOpenRatio?: number
  sampleQuality?: string
}

type ProgressState = {
  phase: TestPhase
  elapsedMs: number
  active: boolean
}

const api = getTestingToolsApi()

export function CartridgeSubassemblyPage() {
  const [settings, setSettings] = useState<StationSettings>(DEFAULT_STATION_SETTINGS)
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [mode, setMode] = useState<ConnectionMode>(window.testingTools ? 'serial' : 'mock')
  const [selectedPort, setSelectedPort] = useState('')
  const [connected, setConnected] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState('Disconnected')
  const [operator, setOperator] = useState('')
  const [batch, setBatch] = useState('')
  const [currentStep, setCurrentStep] = useState<WorkflowStepId>('connect')
  const [readiness, setReadiness] = useState<ReadinessItem[]>(buildReadinessItems())
  const [cartridgeInput, setCartridgeInput] = useState('')
  const [cartridgeSerial, setCartridgeSerial] = useState('')
  const [faultText, setFaultText] = useState('')
  const [latestAction, setLatestAction] = useState('Waiting for tester connection.')
  const [runUid, setRunUid] = useState('')
  const [measurements, setMeasurements] = useState<Record<string, MeasurementSummary>>({})
  const [guidance, setGuidance] = useState<GuidanceState>({})
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [rawLines, setRawLines] = useState<string[]>([])
  const [events, setEvents] = useState<GuiEventEnvelope[]>([])
  const [engineeringOpen, setEngineeringOpen] = useState(false)
  const [engineeringUnlocked, setEngineeringUnlocked] = useState(false)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [engineeringPassword, setEngineeringPassword] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideAction, setOverrideAction] = useState('Repeat measurement')
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>({
    checked_at: '',
    status: 'idle',
    message: 'Update check has not run.',
  })
  const progressTimer = useRef<number | undefined>()
  const unlockTimer = useRef<number | undefined>()

  const cartridgeError = explainCartridgeSerial(cartridgeInput)
  const canStartTest =
    connected &&
    operator.trim().length > 0 &&
    batch.trim().length > 0 &&
    cartridgeSerial.length > 0 &&
    isValidCartridgeSerial(cartridgeSerial)

  useEffect(() => {
    let mounted = true

    api.getSettings().then((loadedSettings) => {
      if (!mounted) return
      setSettings(loadedSettings)
      setBatch(loadedSettings.latestBatch)
    })

    api.listSerialPorts().then((availablePorts) => {
      if (!mounted) return
      setPorts(availablePorts)
      setSelectedPort(availablePorts[0]?.path ?? '')
    }).catch(() => {
      if (!mounted) return
      setPorts([])
    })

    api.checkForUpdates().then((result) => {
      if (!mounted) return
      setUpdateResult(result)
    })

    api.getStorageSummary().then((summary) => {
      if (!mounted) return
      setStorageSummary(summary)
    })

    const removeLineListener = api.onSerialLine((line) => {
      setRawLines((current) => [line, ...current].slice(0, 120))
      const parsed = parseSerialLine(line)
      if (parsed.kind === 'gui-response' && parsed.envelope?.type === 'response') {
        setLatestAction(`${parsed.envelope.command}: ${parsed.envelope.ok ? 'ok' : 'failed'}`)
      }
    })

    const removeEventListener = api.onDeviceEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 120))
      const measurement = extractMeasurement(event)
      if (measurement) {
        setMeasurements((current) => ({ ...current, [measurement.phase]: measurement }))
      }

      if (event.event_name === 'dd_cartridge_air_leak_summary') {
        setGuidance(extractGuidance(event))
      }
    })

    return () => {
      mounted = false
      removeLineListener()
      removeEventListener()
      stopProgressTimer()
      stopUnlockTimer()
    }
  }, [])

  const activeSteps = useMemo(() => {
    const railStep = currentStep === 'scan' ? 'insert' : currentStep
    const activeIndex = FLOW_STEPS.findIndex((step) => step.id === railStep)
    return FLOW_STEPS.map((step, index) => ({
      ...step,
      status:
        faultText && step.id === currentStep
          ? 'failed'
          : index < activeIndex
            ? 'complete'
            : index === activeIndex
              ? 'active'
              : 'pending',
    }))
  }, [currentStep, faultText])

  async function connectTester() {
    setFaultText('')
    setDeviceStatus('Connecting')
    setCurrentStep('connect')
    const result = await api.connect({ mode, path: mode === 'serial' ? selectedPort : undefined })

    if (!result.ok) {
      setDeviceStatus('Fault')
      setFaultText(result.error ?? 'Could not connect to tester.')
      return
    }

    setConnected(true)
    setDeviceStatus(mode === 'mock' ? 'Mock ready' : `Connected ${result.path}`)
    setCurrentStep('ready')
    await runReadiness()
  }

  async function runReadiness() {
    let items = buildReadinessItems()
    setReadiness(items)
    setLatestAction('Running tester readiness checks.')

    for (const item of items) {
      items = markReadinessItem(items, item.id, 'running')
      setReadiness(items)
      const result = await api.sendCommand(item.command)
      const response = result.response
      if (!result.accepted || !response?.ok) {
        items = markReadinessItem(items, item.id, 'failed', response?.error ?? result.error ?? 'No response')
        setReadiness(items)
        setFaultText(`${item.label} failed.`)
        setDeviceStatus('Fault')
        return
      }

      items = markReadinessItem(items, item.id, 'passed', formatReadinessDetail(response.result))
      setReadiness(items)
    }

    setDeviceStatus('Ready')
    setCurrentStep('insert')
    setLatestAction('Tester ready. Insert cartridge and scan serial.')
  }

  function acceptCartridgeScan(value: string) {
    const normalized = normalizeCartridgeSerial(value)
    setCartridgeInput(normalized)
    if (!isValidCartridgeSerial(normalized)) {
      setCartridgeSerial('')
      return
    }

    setCartridgeSerial(normalized)
    setLatestAction(`Cartridge ${normalized} scanned.`)
  }

  async function startTest() {
    if (!canStartTest) {
      setFaultText('Operator, batch, and a valid cartridge scan are required.')
      return
    }

    setFaultText('')
    setGuidance({})
    setMeasurements({})
    setCurrentStep('test')
    setDeviceStatus('Testing')

    const openCommand = buildCartridgeOpenCommand(cartridgeSerial, settings.defaultFixtureId)
    const openResult = await runMeasurementPhase('open', openCommand)
    const firmwareRunUid = openResult.response ? extractRunUid(openResult.response) : undefined
    if (!firmwareRunUid) {
      setFaultText('Open step did not return a firmware run_uid.')
      setDeviceStatus('Fault')
      return
    }
    setRunUid(firmwareRunUid)

    const nozzleCommand = buildCartridgePhaseCommand('nozzle', firmwareRunUid, settings.defaultNozzleId)
    const nozzleResult = await runMeasurementPhase('nozzle', nozzleCommand)
    if (!nozzleResult.response?.ok) return

    const sealedCommand = buildCartridgePhaseCommand('sealed', firmwareRunUid, settings.defaultSealFixtureId)
    const sealedResult = await runMeasurementPhase('sealed', sealedCommand)
    if (!sealedResult.response?.ok) return

    setDeviceStatus('Remove cartridge')
    setCurrentStep('remove')
    setLatestAction('Testing complete. Remove cartridge and leave solenoid locked.')
  }

  async function runMeasurementPhase(phase: TestPhase, command: string) {
    startProgressTimer(phase)
    setLatestAction(`${phase} measurement running.`)
    const result = await api.sendCommand(command)
    if (mode === 'mock') {
      await delay(500)
    }
    stopProgressTimer()

    if (!result.accepted || !result.response?.ok) {
      setFaultText(result.response?.error ?? result.error ?? `${phase} command failed.`)
      setDeviceStatus('Fault')
    }

    return result
  }

  async function unlockForRemoval() {
    setLatestAction('Unlock requested by operator.')
    await api.sendCommand('solenoid Unlock')
    setLatestAction('Solenoid unlocked. It will be locked again automatically.')
    stopUnlockTimer()
    unlockTimer.current = window.setTimeout(() => {
      void lockSolenoid()
    }, 45000)
  }

  async function lockSolenoid() {
    stopUnlockTimer()
    await api.sendCommand('solenoid Lock')
    setLatestAction('Solenoid locked.')
  }

  async function confirmRemoved() {
    await lockSolenoid()
    setDeviceStatus('Ready')
    setCurrentStep('next')
    setLatestAction('Cartridge removed. Bay empty for next cartridge.')
  }

  function nextCartridge() {
    setCartridgeInput('')
    setCartridgeSerial('')
    setRunUid('')
    setGuidance({})
    setMeasurements({})
    setFaultText('')
    setCurrentStep('insert')
  }

  function openEngineering() {
    if (engineeringUnlocked) {
      setEngineeringOpen(true)
      return
    }
    setPasswordDialogOpen(true)
  }

  async function saveEngineeringOverride() {
    if (!overrideReason.trim() || !operator.trim()) {
      setFaultText('Override requires operator and reason.')
      return
    }

    const override: OverrideRecord = {
      id: crypto.randomUUID(),
      run_uid: runUid,
      cartridge_serial: cartridgeSerial,
      operator,
      action: overrideAction,
      reason: overrideReason.trim(),
      created_at: new Date().toISOString(),
    }

    await api.saveOverride(override)
    setOverrideReason('')
    setLatestAction(`Engineering override recorded: ${overrideAction}.`)
    setStorageSummary(await api.getStorageSummary())
  }

  async function saveStationSettings(nextSettings: StationSettings) {
    setSettings(nextSettings)
    await api.saveSettings(nextSettings)
  }

  function startProgressTimer(phase: TestPhase) {
    stopProgressTimer()
    const startedAt = Date.now()
    setProgress({ phase, elapsedMs: 0, active: true })
    progressTimer.current = window.setInterval(() => {
      setProgress({ phase, elapsedMs: Date.now() - startedAt, active: true })
    }, 100)
  }

  function stopProgressTimer() {
    if (progressTimer.current !== undefined) {
      window.clearInterval(progressTimer.current)
      progressTimer.current = undefined
    }
    setProgress(null)
  }

  function stopUnlockTimer() {
    if (unlockTimer.current !== undefined) {
      window.clearTimeout(unlockTimer.current)
      unlockTimer.current = undefined
    }
  }

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} alignItems={{ lg: 'center' }}>
          <Box sx={{ minWidth: 260, flex: 1 }}>
            <Typography variant="h5">SporeScout Cartridge Subassembly Tester</Typography>
            <Typography color="text.secondary" variant="body2">
              Operator-guided cartridge leak characterization.
            </Typography>
          </Box>

          <Autocomplete
            freeSolo
            options={settings.operators}
            value={operator}
            onChange={(_event, value) => setOperator(value ?? '')}
            onInputChange={(_event, value) => setOperator(value)}
            sx={{ width: 190 }}
            renderInput={(params) => (
              <TextField {...params} label="Operator" required size="small" error={!operator.trim()} />
            )}
          />

          <Autocomplete
            freeSolo
            options={settings.batches}
            value={batch}
            onChange={(_event, value) => setBatch(value ?? '')}
            onInputChange={(_event, value) => setBatch(value)}
            sx={{ width: 190 }}
            renderInput={(params) => <TextField {...params} label="Batch" required size="small" />}
          />

          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>Mode</InputLabel>
            <Select label="Mode" value={mode} onChange={(event) => setMode(event.target.value as ConnectionMode)}>
              <MenuItem value="mock">Mock</MenuItem>
              <MenuItem value="serial">Serial</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 180 }} disabled={mode === 'mock'}>
            <InputLabel>COM port</InputLabel>
            <Select label="COM port" value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)}>
              {ports.map((port) => (
                <MenuItem key={port.path} value={port.path}>
                  {port.friendlyName ?? port.path}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Tooltip title="Connect tester and run readiness">
            <span>
              <Button variant="contained" startIcon={<UsbIcon />} onClick={connectTester}>
                Connect
              </Button>
            </span>
          </Tooltip>

          <Tooltip title="Engineering">
            <IconButton onClick={openEngineering} color={engineeringUnlocked ? 'primary' : 'default'}>
              <ScienceIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 34 }}>
        <StatusChip label={deviceStatus} connected={connected} />
        <Chip size="small" label={`Update: ${updateResult.status}`} color={updateResult.status === 'failed' ? 'warning' : 'default'} />
        {runUid && <Chip size="small" label={`run_uid ${runUid}`} />}
        {faultText && <Alert severity="error" sx={{ py: 0, flex: 1 }}>{faultText}</Alert>}
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '220px minmax(0, 1fr) 330px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 1.5, height: 'fit-content' }}>
          <Typography variant="subtitle2" sx={{ px: 1, mb: 1 }}>
            Progress
          </Typography>
          <List dense disablePadding>
            {activeSteps.map((step) => (
              <ListItem key={step.id} disableGutters sx={{ px: 1 }}>
                <ListItemIcon sx={{ minWidth: 30 }}>
                  {step.status === 'complete' ? (
                    <CheckCircleIcon color="success" fontSize="small" />
                  ) : step.status === 'failed' ? (
                    <ErrorOutlineIcon color="error" fontSize="small" />
                  ) : (
                    <Box
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: '2px solid',
                        borderColor: step.status === 'active' ? 'primary.main' : 'grey.300',
                      }}
                    />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={step.label}
                  primaryTypographyProps={{
                    variant: 'body2',
                    color: step.status === 'active' ? 'primary.main' : 'text.primary',
                    fontWeight: step.status === 'active' ? 500 : 400,
                  }}
                />
              </ListItem>
            ))}
          </List>
        </Paper>

        <Paper variant="outlined" sx={{ minHeight: 470, p: 3 }}>
          {renderMainStep()}
        </Paper>

        <Paper variant="outlined" sx={{ p: 2, height: 'fit-content' }}>
          <Typography variant="subtitle2" gutterBottom>
            Current Run
          </Typography>
          <Stack spacing={1.25}>
            <DetailRow label="Cartridge" value={cartridgeSerial || 'Not scanned'} />
            <DetailRow label="Operator" value={operator || 'Required'} />
            <DetailRow label="Batch" value={batch || 'Required'} />
            <DetailRow label="Fixture" value={settings.defaultFixtureId} />
            <DetailRow label="Nozzle" value={settings.defaultNozzleId} />
            <DetailRow label="Seal" value={settings.defaultSealFixtureId} />
            <Divider />
            <DetailRow label="Open" value={measurementValue(measurements.open)} />
            <DetailRow label="Nozzle" value={measurementValue(measurements.nozzle)} />
            <DetailRow label="Sealed" value={measurementValue(measurements.sealed)} />
            <DetailRow
              label="Guidance"
              value={guidance.guidance ?? 'Waiting'}
              valueColor={guidance.guidance === 'ACCEPT_SINGLE_PASS' ? 'success.main' : 'text.primary'}
            />
          </Stack>
        </Paper>
      </Box>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography variant="body2" color="text.secondary" sx={{ minWidth: 130 }}>
            Latest device action
          </Typography>
          <Typography variant="body2">{latestAction}</Typography>
        </Stack>
      </Paper>

      <EngineeringPasswordDialog
        open={passwordDialogOpen}
        password={engineeringPassword}
        onPasswordChange={setEngineeringPassword}
        onClose={() => setPasswordDialogOpen(false)}
        onUnlock={() => {
          if (engineeringPassword === ENGINEERING_PASSWORD) {
            setEngineeringUnlocked(true)
            setEngineeringOpen(true)
            setPasswordDialogOpen(false)
            setEngineeringPassword('')
            setFaultText('')
          } else {
            setFaultText('Engineering password did not match.')
          }
        }}
      />

      <EngineeringDrawer
        open={engineeringOpen}
        onClose={() => setEngineeringOpen(false)}
        rawLines={rawLines}
        events={events}
        measurements={measurements}
        storageSummary={storageSummary}
        settings={settings}
        saveSettings={saveStationSettings}
        updateResult={updateResult}
        onCheckUpdates={async () => setUpdateResult(await api.checkForUpdates())}
        overrideReason={overrideReason}
        setOverrideReason={setOverrideReason}
        overrideAction={overrideAction}
        setOverrideAction={setOverrideAction}
        saveOverride={saveEngineeringOverride}
      />
    </Stack>
  )

  function renderMainStep() {
    if (currentStep === 'connect' || currentStep === 'ready') {
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Connect tester</Typography>
            <Typography color="text.secondary">
              Select the tester connection. Readiness runs automatically after connection.
            </Typography>
          </Box>
          <ReadinessList items={readiness} />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" startIcon={<UsbIcon />} onClick={connectTester}>
              Connect tester
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={runReadiness} disabled={!connected}>
              Re-run readiness
            </Button>
          </Stack>
        </Stack>
      )
    }

    if (currentStep === 'insert') {
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Insert cartridge</Typography>
            <Typography color="text.secondary">
              Bay should be empty and solenoid locked before the cartridge clicks into place.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button startIcon={<LockOpenIcon />} onClick={unlockForRemoval}>
              Unlock for recovery
            </Button>
            <Button startIcon={<LockIcon />} onClick={lockSolenoid}>
              Lock solenoid
            </Button>
          </Stack>
          <Button variant="contained" onClick={() => setCurrentStep('scan')} sx={{ alignSelf: 'flex-start' }}>
            Cartridge inserted
          </Button>
        </Stack>
      )
    }

    if (currentStep === 'scan') {
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Scan cartridge serial</Typography>
            <Typography color="text.secondary">
              Scanner input is treated as keyboard text followed by Enter.
            </Typography>
          </Box>
          <TextField
            autoFocus
            label="Cartridge serial"
            value={cartridgeInput}
            error={Boolean(cartridgeError)}
            helperText={cartridgeError ?? 'Ready to start test.'}
            onChange={(event) => acceptCartridgeScan(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                acceptCartridgeScan(cartridgeInput)
              }
            }}
            sx={{ maxWidth: 360 }}
          />
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            onClick={startTest}
            disabled={!canStartTest}
            sx={{ alignSelf: 'flex-start' }}
          >
            Start testing
          </Button>
        </Stack>
      )
    }

    if (currentStep === 'test') {
      const progressValue = progress ? Math.min(100, (progress.elapsedMs / 15000) * 100) : 0
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Testing cartridge</Typography>
            <Typography color="text.secondary">
              Firmware runs strict open, nozzle, then sealed measurements using the generated run_uid.
            </Typography>
          </Box>
          {progress ? (
            <Box>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {progressLabel(progress.phase, progress.elapsedMs)}
              </Typography>
              <LinearProgress variant="determinate" value={progressValue} sx={{ height: 8, borderRadius: 1 }} />
            </Box>
          ) : (
            <LinearProgress />
          )}
          <MeasurementTable measurements={measurements} />
        </Stack>
      )
    }

    if (currentStep === 'remove') {
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Remove cartridge</Typography>
            <Typography color="text.secondary">
              End with cartridge removed, bay empty, and solenoid locked.
            </Typography>
          </Box>
          {guidance.guidance && (
            <Alert severity={guidance.guidance === 'ACCEPT_SINGLE_PASS' ? 'success' : 'warning'}>
              {guidance.guidance}
              {typeof guidance.sealedOpenRatio === 'number'
                ? `, sealed/open ratio ${guidance.sealedOpenRatio.toFixed(3)}`
                : ''}
            </Alert>
          )}
          <Stack direction="row" spacing={1}>
            <Button startIcon={<LockOpenIcon />} onClick={unlockForRemoval}>
              Unlock for removal
            </Button>
            <Button startIcon={<LockIcon />} onClick={lockSolenoid}>
              Lock solenoid
            </Button>
            <Button variant="contained" startIcon={<DownloadDoneIcon />} onClick={confirmRemoved}>
              Confirm removed
            </Button>
          </Stack>
        </Stack>
      )
    }

    return (
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h6">Ready for next cartridge</Typography>
          <Typography color="text.secondary">
            The previous cartridge cycle ended with the bay empty and solenoid locked.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={nextCartridge}>
            Next cartridge
          </Button>
          <Button onClick={() => setCurrentStep('connect')}>Exit test</Button>
        </Stack>
      </Stack>
    )
  }
}

function ReadinessList({ items }: { items: ReadinessItem[] }) {
  return (
    <List disablePadding>
      {items.map((item) => (
        <ListItem key={item.id} disableGutters>
          <ListItemIcon sx={{ minWidth: 36 }}>
            {item.status === 'passed' ? (
              <CheckCircleIcon color="success" />
            ) : item.status === 'failed' ? (
              <ErrorOutlineIcon color="error" />
            ) : item.status === 'running' ? (
              <RefreshIcon color="primary" />
            ) : (
              <Box sx={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid', borderColor: 'grey.300' }} />
            )}
          </ListItemIcon>
          <ListItemText
            primary={item.label}
            secondary={item.detail ?? item.command}
            primaryTypographyProps={{ variant: 'body2' }}
            secondaryTypographyProps={{ variant: 'caption' }}
          />
        </ListItem>
      ))}
    </List>
  )
}

function EngineeringPasswordDialog(props: {
  open: boolean
  password: string
  onPasswordChange: (value: string) => void
  onClose: () => void
  onUnlock: () => void
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Engineering access</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          type="password"
          label="Password"
          value={props.password}
          onChange={(event) => props.onPasswordChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') props.onUnlock()
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<KeyIcon />} onClick={props.onUnlock}>
          Unlock
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function EngineeringDrawer(props: {
  open: boolean
  onClose: () => void
  rawLines: string[]
  events: GuiEventEnvelope[]
  measurements: Record<string, MeasurementSummary>
  storageSummary: StorageSummary | null
  settings: StationSettings
  saveSettings: (settings: StationSettings) => Promise<void>
  updateResult: UpdateCheckResult
  onCheckUpdates: () => Promise<void>
  overrideReason: string
  setOverrideReason: (value: string) => void
  overrideAction: string
  setOverrideAction: (value: string) => void
  saveOverride: () => Promise<void>
}) {
  return (
    <Drawer anchor="right" open={props.open} onClose={props.onClose}>
      <Box sx={{ width: 520, p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h6">Engineering</Typography>
            <Typography color="text.secondary" variant="body2">
              Protected diagnostics within Cartridge Subassembly.
            </Typography>
          </Box>
          <IconButton onClick={props.onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>

        <EngineeringSection title="Raw serial console">
          <LogBlock lines={props.rawLines} empty="No serial lines captured." />
        </EngineeringSection>

        <EngineeringSection title="Mirrored event stream">
          <LogBlock
            lines={props.events.map((event) => `${event.event_name} ${JSON.stringify(event.data)}`)}
            empty="No mirrored events captured."
          />
        </EngineeringSection>

        <EngineeringSection title="Measurements and ratios">
          <MeasurementTable measurements={props.measurements} dense />
        </EngineeringSection>

        <EngineeringSection title="Local payload storage">
          <Stack spacing={1}>
            <DetailRow label="SQLite" value={props.storageSummary?.databasePath ?? 'Not loaded'} />
            <DetailRow label="JSONL" value={props.storageSummary?.jsonlPath ?? 'Not loaded'} />
            <DetailRow label="Events" value={String(props.storageSummary?.eventCount ?? 0)} />
            <DetailRow label="Commands" value={String(props.storageSummary?.commandCount ?? 0)} />
            <DetailRow label="Overrides" value={String(props.storageSummary?.overrideCount ?? 0)} />
          </Stack>
        </EngineeringSection>

        <EngineeringSection title="Station settings">
          <StationSettingsPanel settings={props.settings} saveSettings={props.saveSettings} />
        </EngineeringSection>

        <EngineeringSection title="Overrides">
          <Stack spacing={1.5}>
            <FormControl size="small" fullWidth>
              <InputLabel>Action</InputLabel>
              <Select
                label="Action"
                value={props.overrideAction}
                onChange={(event) => props.setOverrideAction(event.target.value)}
              >
                <MenuItem value="Repeat measurement">Repeat measurement</MenuItem>
                <MenuItem value="Accept single pass">Accept single pass</MenuItem>
                <MenuItem value="Cancel run">Cancel run</MenuItem>
                <MenuItem value="Record fixture issue">Record fixture issue</MenuItem>
              </Select>
            </FormControl>
            <TextField
              label="Reason"
              multiline
              minRows={3}
              value={props.overrideReason}
              onChange={(event) => props.setOverrideReason(event.target.value)}
            />
            <Button variant="contained" onClick={props.saveOverride} sx={{ alignSelf: 'flex-start' }}>
              Save override
            </Button>
          </Stack>
        </EngineeringSection>

        <EngineeringSection title="Update diagnostics">
          <Stack spacing={1}>
            <DetailRow label="Status" value={props.updateResult.status} />
            <DetailRow label="Version" value={props.updateResult.version ?? 'Unknown'} />
            <DetailRow label="Message" value={props.updateResult.message ?? 'No message'} />
            <Button startIcon={<RefreshIcon />} onClick={props.onCheckUpdates} sx={{ alignSelf: 'flex-start' }}>
              Check now
            </Button>
          </Stack>
        </EngineeringSection>
      </Box>
    </Drawer>
  )
}

function EngineeringSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Accordion disableGutters defaultExpanded={title === 'Raw serial console'}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  )
}

function StationSettingsPanel(props: {
  settings: StationSettings
  saveSettings: (settings: StationSettings) => Promise<void>
}) {
  const updateDefault = (key: keyof StationSettings, listKey: keyof StationSettings, value: string) => {
    const currentList = props.settings[listKey]
    const nextList = Array.isArray(currentList) ? Array.from(new Set([...currentList, value].filter(Boolean))) : []
    void props.saveSettings({ ...props.settings, [key]: value, [listKey]: nextList })
  }

  return (
    <Stack spacing={1.5}>
      <EditableDefault
        label="Fixture"
        value={props.settings.defaultFixtureId}
        options={props.settings.fixtureIds}
        onChange={(value) => updateDefault('defaultFixtureId', 'fixtureIds', value)}
      />
      <EditableDefault
        label="Nozzle"
        value={props.settings.defaultNozzleId}
        options={props.settings.nozzleIds}
        onChange={(value) => updateDefault('defaultNozzleId', 'nozzleIds', value)}
      />
      <EditableDefault
        label="Seal fixture"
        value={props.settings.defaultSealFixtureId}
        options={props.settings.sealFixtureIds}
        onChange={(value) => updateDefault('defaultSealFixtureId', 'sealFixtureIds', value)}
      />
      <EditableDefault
        label="Latest batch"
        value={props.settings.latestBatch}
        options={props.settings.batches}
        onChange={(value) => updateDefault('latestBatch', 'batches', value)}
      />
    </Stack>
  )
}

function EditableDefault(props: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  return (
    <Autocomplete
      freeSolo
      options={props.options}
      value={props.value}
      onChange={(_event, value) => props.onChange(value ?? '')}
      onInputChange={(_event, value) => props.onChange(value)}
      renderInput={(params) => <TextField {...params} label={props.label} size="small" />}
    />
  )
}

function MeasurementTable({ measurements, dense = false }: { measurements: Record<string, MeasurementSummary>; dense?: boolean }) {
  const rows: TestPhase[] = ['open', 'nozzle', 'sealed']
  return (
    <Table size={dense ? 'small' : 'medium'}>
      <TableHead>
        <TableRow>
          <TableCell>State</TableCell>
          <TableCell align="right">Trimmed slpm</TableCell>
          <TableCell align="right">Raw mean</TableCell>
          <TableCell align="right">CV</TableCell>
          <TableCell>Quality</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((phase) => {
          const measurement = measurements[phase]
          return (
            <TableRow key={phase}>
              <TableCell sx={{ textTransform: 'capitalize' }}>{phase}</TableCell>
              <TableCell align="right">{measurement ? measurement.slpm.toFixed(3) : '-'}</TableCell>
              <TableCell align="right">{measurement ? measurement.raw_mean_slpm.toFixed(3) : '-'}</TableCell>
              <TableCell align="right">
                {measurement ? `${(measurement.coefficient_of_variation * 100).toFixed(1)}%` : '-'}
              </TableCell>
              <TableCell>{measurement?.sample_quality ?? '-'}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function LogBlock({ lines, empty }: { lines: string[]; empty: string }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        minHeight: 160,
        maxHeight: 260,
        overflow: 'auto',
        bgcolor: 'grey.50',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
      }}
    >
      {lines.length ? lines.join('\n') : empty}
    </Box>
  )
}

function StatusChip({ label, connected }: { label: string; connected: boolean }) {
  return (
    <Chip
      size="small"
      color={connected ? 'success' : 'default'}
      label={label}
      sx={{ minWidth: 96 }}
    />
  )
}

function DetailRow({
  label,
  value,
  valueColor,
}: {
  label: string
  value: string
  valueColor?: string
}) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" color={valueColor ?? 'text.primary'} textAlign="right">
        {value}
      </Typography>
    </Stack>
  )
}

function measurementValue(measurement?: MeasurementSummary): string {
  return measurement ? `${measurement.slpm.toFixed(3)} slpm` : '-'
}

function formatReadinessDetail(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
