import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloseIcon from '@mui/icons-material/Close'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyIcon from '@mui/icons-material/Key'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import ScienceIcon from '@mui/icons-material/Science'
import UsbIcon from '@mui/icons-material/Usb'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  FormControlLabel,
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
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_STATION_SETTINGS,
  LINEAR_STAGE_READINESS_COMMAND,
  canonicalHardwareId,
  isKnownOption,
  isTesterDeviceSerial,
  type CommandDispatchResult,
  type ConnectionMode,
  type GuiEventEnvelope,
  type HistoricalRecords,
  type LinearStageMode,
  type LocalRunContext,
  type OverrideRecord,
  type ReadinessItem,
  type SerialPortInfo,
  type StationSettings,
  type StorageSummary,
  type UpdateCheckResult,
} from '../../shared/contracts'
import { appVersionStatusColor, appVersionStatusLabel, formatDisplayVersion } from '../../shared/appVersion'
import { parseSerialLine } from '../../shared/serialParser'
import { getDefaultConnectionMode, getTestingToolsApi } from '../../services/testingToolsApi'
import {
  LINEAR_STAGE_MODE_CONFIGS,
  LINEAR_STAGE_MODE_ORDER,
  commandForLinearStageMode,
  knownPlannedStepNumberForLinearStageMode,
  modeForLinearStageCommand,
  normalizeLinearStageMode,
  plannedStepNumberForLinearStageMode,
  plannedStepsForLinearStageMode,
} from './linearStageWorkflow'

type LinearWorkflowStep = 'connect' | 'ready' | 'clear' | 'run' | 'review' | 'next'
type LinearRunStatus = 'waiting' | 'running' | 'pass' | 'warn' | 'fail'
type LinearStepResult = 'Pass' | 'Warn' | 'Fail' | 'Unknown'

interface LinearStageStep {
  id: string
  number: number
  name: string
  result: LinearStepResult
  expected?: unknown
  measured?: unknown
  error?: string
}

interface AxisSummary {
  axis: string
  passed: boolean
  failed: number
  warned: number
  total: number
  metrics: NumericMetric[]
}

interface NumericMetric {
  id: string
  stepName: string
  result: LinearStepResult
  label: string
  value: number
  unit?: string
  axis?: string
  threshold?: MetricThreshold
}

interface MetricThreshold {
  min?: number
  max?: number
  target?: number
  kind: 'range' | 'target' | 'direction'
  label: string
}

interface LinearStageEvidence {
  safety: string[]
  scan: string[]
  upload: string[]
  artifacts: string[]
  errors: string[]
  issues: string[]
}

interface LinearStageSummary {
  runId: string
  command: string
  mode?: LinearStageMode
  testName: string
  status: LinearRunStatus
  resultCode?: number
  profile?: string
  steps: LinearStageStep[]
  axes: AxisSummary[]
  metrics: NumericMetric[]
  evidence: LinearStageEvidence
  raw: unknown
}

type RunProgress = {
  active: boolean
  elapsedMs: number
}

type LiveLinearStageStepStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail'

interface LiveLinearStageStep {
  number: number
  name: string
  status: LiveLinearStageStepStatus
  expected?: unknown
  measured?: unknown
  error?: string
  raw?: string
  source: 'planned' | 'serial' | 'event'
  startedAt?: string
  completedAt?: string
}

interface LiveLinearStageRun {
  runId: string
  command: string
  mode: LinearStageMode
  firmwareRunId?: string
  startedAt: string
  active: boolean
  steps: LiveLinearStageStep[]
  currentStepNumber?: number
  overallStatus?: LinearRunStatus
  lastLine?: string
  metadata: string[]
  artifacts: string[]
}

type LiveLinearStageUpdate =
  | {
      kind: 'start'
      number: number
      name: string
      expected?: unknown
      raw: string
      source: 'serial' | 'event'
      mode?: LinearStageMode
      runId?: string
      artifacts?: string[]
    }
  | {
      kind: 'result'
      number: number
      name?: string
      result: LinearStepResult
      expected?: unknown
      measured?: unknown
      error?: string
      raw: string
      source: 'serial' | 'event'
      mode?: LinearStageMode
      runId?: string
      artifacts?: string[]
    }
  | {
      kind: 'overall'
      status: LinearRunStatus
      raw: string
      mode?: LinearStageMode
      runId?: string
      artifacts?: string[]
    }
  | {
      kind: 'metadata'
      message: string
      raw: string
      mode?: LinearStageMode
      runId?: string
      artifacts?: string[]
    }

const api = getTestingToolsApi()
const HISTORY_PAGE_LIMIT = 500
const DEFAULT_LINEAR_STAGE_MODE: LinearStageMode = 'production_full'
const DEFAULT_LINEAR_STAGE_COMMAND = commandForLinearStageMode(DEFAULT_LINEAR_STAGE_MODE)
const ACTIVE_CONTEXT_CLEAR_DELAY_MS = 30_000
const HISTORY_REFRESH_DELAY_MS = 350
type LinearStageCommand = string

const LINEAR_FLOW_STEPS: Array<{ id: LinearWorkflowStep; label: string }> = [
  { id: 'connect', label: 'Connect' },
  { id: 'ready', label: 'Ready' },
  { id: 'clear', label: 'Clear stage' },
  { id: 'run', label: 'Run test' },
  { id: 'review', label: 'Review result' },
  { id: 'next', label: 'Next / Exit' },
]

function buildReadinessItems(): ReadinessItem[] {
  return [
    {
      id: 'firmware',
      label: 'Checking firmware version',
      command: LINEAR_STAGE_READINESS_COMMAND,
      info: 'Confirms the tester is responding over the selected serial connection before any stage movement is allowed.',
      status: 'pending',
    },
    {
      id: 'cm4_power',
      label: 'Checking tester computer power',
      command: LINEAR_STAGE_READINESS_COMMAND,
      info: 'Turns on and verifies the tester computer power rail without starting stage motion.',
      status: 'pending',
    },
    {
      id: 'cm4_ready',
      label: 'Checking tester computer ready',
      command: LINEAR_STAGE_READINESS_COMMAND,
      info: 'Confirms the tester computer has booted and is accepting commands before the motion test can run.',
      status: 'pending',
    },
    {
      id: 'tester_power',
      label: 'Checking tester power',
      command: LINEAR_STAGE_READINESS_COMMAND,
      info: 'Verifies the 24 V stage power path before motor power is enabled.',
      status: 'pending',
    },
    {
      id: 'steppers_power',
      label: 'Checking stage motor power',
      command: LINEAR_STAGE_READINESS_COMMAND,
      info: 'Confirms the stage motor power switch is ready. The stage will not move until the run command starts.',
      status: 'pending',
    },
    {
      id: 'operator',
      label: 'Checking operator selection',
      command: 'local',
      info: 'Operator is saved with the local record for this linear-stage run.',
      status: 'pending',
    },
    {
      id: 'batch',
      label: 'Checking batch selection',
      command: 'local',
      info: 'Batch is saved with the local record and future replay payloads.',
      status: 'pending',
    },
    {
      id: 'tester',
      label: 'Checking tester serial',
      command: 'local',
      info: 'Confirms the selected tester serial uses the expected SS-A-001-XXX-YYYY format.',
      status: 'pending',
    },
    {
      id: 'stage_clear',
      label: 'Checking stage area is clear',
      command: 'operator',
      info: 'The operator must confirm the stage is clear before the motion test starts.',
      status: 'pending',
    },
  ]
}

export function LinearStagePage() {
  const [settings, setSettings] = useState<StationSettings>(DEFAULT_STATION_SETTINGS)
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [mode, setMode] = useState<ConnectionMode>(getDefaultConnectionMode())
  const [connectedMode, setConnectedMode] = useState<ConnectionMode | undefined>()
  const [selectedPort, setSelectedPort] = useState('')
  const [connected, setConnected] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState('Disconnected')
  const [operator, setOperator] = useState('')
  const [batch, setBatch] = useState('')
  const [testerDeviceSerial, setTesterDeviceSerial] = useState(DEFAULT_STATION_SETTINGS.defaultTesterDeviceSerial)
  const [currentStep, setCurrentStep] = useState<LinearWorkflowStep>('connect')
  const [readiness, setReadiness] = useState<ReadinessItem[]>(buildReadinessItems())
  const [stageClear, setStageClear] = useState(false)
  const [faultText, setFaultText] = useState('')
  const [latestAction, setLatestAction] = useState('Waiting for tester connection.')
  const [rawLines, setRawLines] = useState<string[]>([])
  const [events, setEvents] = useState<GuiEventEnvelope[]>([])
  const [engineeringOpen, setEngineeringOpen] = useState(false)
  const [engineeringUnlocked, setEngineeringUnlocked] = useState(false)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [engineeringPassword, setEngineeringPassword] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [overrideAction, setOverrideAction] = useState('Repeat linear-stage test')
  const [storageSummary, setStorageSummary] = useState<StorageSummary | null>(null)
  const [historicalRecords, setHistoricalRecords] = useState<HistoricalRecords>({
    commands: [],
    responses: [],
    events: [],
    overrides: [],
  })
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyTextFilter, setHistoryTextFilter] = useState('')
  const [historyRunFilter, setHistoryRunFilter] = useState('')
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>({
    checked_at: '',
    status: 'idle',
    message: 'Update check has not run.',
  })
  const [appVersion, setAppVersion] = useState('')
  const [runSummary, setRunSummary] = useState<LinearStageSummary | null>(null)
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null)
  const [linearStageMode, setLinearStageMode] = useState<LinearStageMode>(DEFAULT_LINEAR_STAGE_MODE)
  const [linearCommand, setLinearCommand] = useState(DEFAULT_LINEAR_STAGE_COMMAND)
  const [activeRunId, setActiveRunId] = useState('')
  const [liveRun, setLiveRun] = useState<LiveLinearStageRun | null>(null)
  const progressTimer = useRef<number | undefined>()
  const suiteCompletionTimer = useRef<number | undefined>()
  const contextClearTimer = useRef<number | undefined>()
  const historyRefreshTimer = useRef<number | undefined>()
  const operationToken = useRef(0)
  const liveRunRef = useRef<LiveLinearStageRun | null>(null)
  const completedLinearRunIdsRef = useRef<Set<string>>(new Set())
  const serialAvailable = Boolean(window.testingTools)

  const operatorValid = isKnownOption(operator, settings.operators)
  const batchValid = isKnownOption(batch, settings.batches)
  const testerSerialValid = isTesterDeviceSerial(testerDeviceSerial)
  const selectedModeConfig = LINEAR_STAGE_MODE_CONFIGS[linearStageMode]
  const selectedLinearCommand = normalizeLinearStageCommand(linearCommand)
  const readinessReady = readiness.every((item) => item.status === 'passed')
  const canStartTest = connected && connectedMode === mode && Boolean(selectedLinearCommand) && operatorValid && batchValid && testerSerialValid && stageClear && readinessReady && !runProgress?.active
  const runControlsLocked = Boolean(runProgress?.active) || currentStep === 'review'

  const activeSteps = useMemo(() => buildProgressSteps(currentStep, runSummary?.status), [currentStep, runSummary?.status])
  const visibleHistory = historicalRecords
  const liveCompletedCount = liveRun?.steps.filter((step) => step.status === 'pass' || step.status === 'warn' || step.status === 'fail').length ?? 0
  const liveCurrentStep = liveRun?.steps.find((step) => step.status === 'running')
  const failedStepCount = runSummary?.steps.filter((step) => step.result === 'Fail').length ?? liveRun?.steps.filter((step) => step.status === 'fail').length ?? 0
  const warningStepCount = runSummary?.steps.filter((step) => step.result === 'Warn').length ?? liveRun?.steps.filter((step) => step.status === 'warn').length ?? 0

  useEffect(() => {
    liveRunRef.current = liveRun
  }, [liveRun])

  useEffect(() => {
    let mounted = true

    api.getSettings().then((loadedSettings) => {
      if (!mounted) return
      setSettings(loadedSettings)
      setBatch(loadedSettings.latestBatch)
      setTesterDeviceSerial(loadedSettings.defaultTesterDeviceSerial)
    })

    api.getRuntimeConfig().then((config) => {
      if (!mounted) return
      setAppVersion(config.appVersion ?? '')
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

    api.getActiveRunContext().then((context) => {
      if (!mounted) return
      if (context?.workflow === 'linear_stage') {
        void api.setActiveRunContext(undefined)
      }
    }).catch(() => undefined)

    refreshLocalRecords().catch(() => undefined)

    const unsubscribeLine = api.onSerialLine((line) => {
      setRawLines((current) => [line, ...current].slice(0, 300))
      const liveUpdate = parseLiveLinearStageSerialLine(line)
      if (liveUpdate) {
        setLiveRun((current) => applyLiveLinearStageUpdate(current, liveUpdate))
        setLatestAction(liveActionText(liveUpdate))
      }
      const parsed = parseSerialLine(line)
      if (parsed.kind === 'legacy-response' || parsed.kind === 'gui-response') {
        setLatestAction(line)
      }
    })
    const unsubscribeEvent = api.onDeviceEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 150))
      if (isLinearStageEvent(event)) {
        const liveUpdate = parseLiveLinearStageEvent(event, liveRunRef.current)
        let nextRun = liveRunRef.current
        if (liveUpdate) {
          nextRun = applyLiveLinearStageUpdate(liveRunRef.current, liveUpdate)
          liveRunRef.current = nextRun
          setLiveRun(nextRun)
        }
        setLatestAction(`${event.event_name}: ${String(event.data.step_name ?? event.data.result ?? 'linear stage update')}`)
        if (nextRun && isLinearStageTerminalSuiteEvent(event)) {
          void completeLinearStageRunFromSuiteEvent(event, nextRun)
        }
        scheduleHistoryRefresh()
      }
    })
    const unsubscribeStatus = api.onConnectionStatus((status) => {
      setConnected(status.connected)
      setConnectedMode(status.connected ? status.mode : undefined)
      setDeviceStatus(status.connected ? 'Connected' : 'Disconnected')
      if (!status.connected) {
        resetMotionReadiness('connect')
      }
    })

    return () => {
      mounted = false
      unsubscribeLine()
      unsubscribeEvent()
      unsubscribeStatus()
      stopProgressTimer()
      clearContextClearTimer()
      clearHistoryRefreshTimer()
    }
    // Initial subscriptions must be registered once; handlers intentionally read current state through setters/refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setReadiness((items) => items.map((item) => item.id === 'stage_clear'
      ? { ...item, status: stageClear ? 'passed' : 'pending', detail: stageClear ? 'Confirmed clear' : 'Waiting for confirmation' }
      : item))
  }, [stageClear])

  async function connectTester() {
    if (runControlsLocked) {
      setFaultText('Finish the current linear-stage run review before reconnecting the tester.')
      return
    }
    if (mode === 'serial' && !serialAvailable) {
      setFaultText('Serial hardware access is only available in the Electron app. Browser preview is mock-only.')
      setDeviceStatus('Fault')
      return
    }
    if (mode === 'serial' && !selectedPort) {
      setFaultText('Select a COM port before connecting.')
      return
    }

    setFaultText('')
    setDeviceStatus('Connecting')
    setLatestAction('Opening tester connection.')
    resetMotionReadiness('connect')
    const result = await api.connect({ mode, path: selectedPort || undefined })
    if (!result.ok) {
      setConnected(false)
      setConnectedMode(undefined)
      setDeviceStatus('Fault')
      setFaultText(result.error ?? 'Could not connect to tester.')
      setLatestAction(result.error ?? 'Connection failed.')
      return
    }

    setConnected(true)
    setConnectedMode(result.mode)
    setDeviceStatus('Connected')
    setLatestAction('Tester connected. Running readiness checks.')
    await runReadiness(beginOperation(), true)
  }

  async function runReadiness(token = beginOperation(), connectionConfirmed = connected) {
    if (!connectionConfirmed) {
      setFaultText('Connect the tester before running readiness checks.')
      setLatestAction('Waiting for tester connection.')
      setCurrentStep('connect')
      return
    }

    const firmwareItems = buildReadinessItems()
    setReadiness(
      firmwareItems.map((item) =>
        ['firmware', 'cm4_power', 'cm4_ready', 'tester_power', 'steppers_power'].includes(item.id)
          ? { ...item, status: 'running', detail: 'Checking now' }
          : item,
      ),
    )
    setFaultText('')
    setLatestAction('Preparing tester hardware for linear-stage readiness.')

    const response = await api.sendCommand(LINEAR_STAGE_READINESS_COMMAND)
    if (token !== operationToken.current) return

    const commandAccepted = response.accepted && !response.timedOut && response.response?.ok === true
    const readinessResult = asRecord(response.response?.result)
    const firmwarePassed = commandAccepted && readinessResult.firmware_version !== undefined
    const firmwareDetail = firmwarePassed
      ? `firmware ${String(readinessResult.firmware_version)}${asString(readinessResult.hardware_version) ? `, ${String(readinessResult.hardware_version)}` : ''}`
      : response.error ?? response.response?.error ?? 'No firmware readiness response.'
    const operatorAction = asString(readinessResult.operator_action)

    const nextItems = firmwareItems.map((item) => {
      if (item.id === 'firmware') {
        return { ...item, status: firmwarePassed ? 'passed' : 'failed', detail: firmwareDetail } satisfies ReadinessItem
      }
      if (item.id === 'cm4_power') {
        return readinessItemFromCheck(item, readinessResult, 'cm4_power', 'Tester computer power is ready.', 'Tester computer power is not ready.')
      }
      if (item.id === 'cm4_ready') {
        return readinessItemFromCheck(item, readinessResult, 'cm4_ready', 'Tester computer is ready.', 'Tester computer is not ready.')
      }
      if (item.id === 'tester_power') {
        return readinessItemFromCheck(item, readinessResult, 'tester_power', 'Tester power is ready.', 'Tester power is not ready.')
      }
      if (item.id === 'steppers_power') {
        return readinessItemFromCheck(item, readinessResult, 'steppers_power', 'Stage motor power is ready.', 'Stage motor power is waiting for tester computer and power.')
      }
      if (item.id === 'operator') {
        return { ...item, status: operatorValid ? 'passed' : 'failed', detail: operatorValid ? 'Ready' : 'Select or enter an operator.' } satisfies ReadinessItem
      }
      if (item.id === 'batch') {
        return { ...item, status: batchValid ? 'passed' : 'failed', detail: batchValid ? 'Ready' : 'Select or enter a batch.' } satisfies ReadinessItem
      }
      if (item.id === 'tester') {
        return { ...item, status: testerSerialValid ? 'passed' : 'failed', detail: testerSerialValid ? 'Ready' : 'Tester serial format is invalid.' } satisfies ReadinessItem
      }
      return { ...item, status: stageClear ? 'passed' : 'pending', detail: stageClear ? 'Confirmed clear' : 'Confirm before starting motion.' } satisfies ReadinessItem
    })
    setReadiness(nextItems)

    const ready = nextItems.every((item) => item.status === 'passed')
    if (!commandAccepted) {
      setDeviceStatus('Fault')
      setFaultText('Firmware readiness did not respond. Check the selected serial connection.')
      setLatestAction('Readiness failed at firmware readiness check.')
      setCurrentStep('ready')
      return
    }

    if (ready) {
      setDeviceStatus('Ready')
      setLatestAction('Ready to run linear-stage test.')
      setCurrentStep('run')
      return
    }

    const hardwareFailed = nextItems.some(
      (item) => ['firmware', 'cm4_power', 'cm4_ready', 'tester_power', 'steppers_power'].includes(item.id) && item.status === 'failed',
    )
    setDeviceStatus(hardwareFailed ? 'Fault' : 'Connected')
    setFaultText(operatorAction && hardwareFailed ? operatorAction : '')
    setLatestAction(operatorAction ?? 'Complete operator, batch, tester serial, and stage-clear checks before running.')
    setCurrentStep(stageClear ? 'ready' : 'clear')
  }

  async function startLinearStageTest() {
    if (!canStartTest) {
      setFaultText('Complete readiness and confirm the stage is clear before starting.')
      await runReadiness()
      return
    }

    if (!selectedLinearCommand) {
      setFaultText('Select a valid linear-stage test command before starting.')
      return
    }

    const suiteSessionId = buildLinearStageSuiteSessionId()
    const commandMode = modeForLinearStageCommand(selectedLinearCommand) ?? linearStageMode
    const suiteCommand = commandForLinearStageMode(commandMode, suiteSessionId)
    const runId = `linear-${suiteSessionId}-${crypto.randomUUID().slice(0, 8)}`
    completedLinearRunIdsRef.current.delete(runId)
    const initialLiveRun = buildInitialLiveLinearStageRun(runId, suiteCommand, commandMode)
    setActiveRunId(runId)
    setLinearCommand(suiteCommand)
    setRunSummary(null)
    setLiveRun(initialLiveRun)
    liveRunRef.current = initialLiveRun
    setFaultText('')
    setDeviceStatus('Busy')
    setCurrentStep('run')
    setLatestAction('Running linear-stage test. Keep the stage clear.')
    startProgressTimer()
    scheduleSuiteCompletionTimeout(runId, suiteCommand, commandMode)

    const context: LocalRunContext = {
      workflow: 'linear_stage',
      linear_stage_run_id: runId,
      linear_stage_mode: commandMode,
      station_id: settings.stationId,
      operator,
      batch,
      tester_device_serial: canonicalHardwareId(testerDeviceSerial),
    }

    let response: CommandDispatchResult
    try {
      const arm = await api.armLinearStageTest(context)
      if (!arm.ok || !arm.armId) {
        throw new Error(arm.error ?? 'Stage-clear arm failed before the tester command was sent.')
      }
      response = await api.runLinearStageTest(arm.armId, suiteCommand)
    } catch (error) {
      stopProgressTimer()
      const errorSummary = summarizeLiveLinearStageRun(markLiveRunCommandError(liveRunRef.current, error instanceof Error ? error.message : 'Command failed before completion.'), runId, suiteCommand, commandMode)
      if (errorSummary.steps.length > 0) {
        setRunSummary(errorSummary)
      }
      setFaultText(error instanceof Error ? error.message : 'Linear-stage command failed before it reached the tester.')
      setDeviceStatus('Fault')
      setCurrentStep('review')
      setLatestAction('Linear-stage command did not start cleanly.')
      void api.setActiveRunContext(undefined)
      await refreshLocalRecords()
      return
    }

    if (!response.accepted || response.timedOut || !response.response?.ok) {
      stopProgressTimer()
      const liveFallback = summarizeLiveLinearStageRun(
        markLiveRunCommandError(liveRunRef.current, response.timedOut ? 'The command timed out before the final firmware response.' : response.error ?? response.response?.error),
        runId,
        suiteCommand,
        commandMode,
      )
      const summary = liveFallback.steps.length
        ? liveFallback
        : summarizeLinearStageResult(
            response.response?.result ?? { error: response.error ?? response.response?.error ?? 'No response before timeout.' },
            runId,
            selectedLinearCommand,
            commandMode,
          )
      const failedSummary = { ...summary, status: 'fail' as const }
      setRunSummary(failedSummary)
      setLiveRun((current) => current ? { ...current, active: false, overallStatus: 'fail' } : current)
      setFaultText(response.timedOut ? 'The command timed out before a response was received.' : response.error ?? response.response?.error ?? 'Linear-stage test failed.')
      setDeviceStatus('Fault')
      setCurrentStep('review')
      setLatestAction('Linear-stage test failed or timed out. Review the failed steps before repeating or returning the tester to service.')
      await refreshLocalRecords()
      scheduleContextClear(runId)
      scheduleHistoryRefresh()
      return
    }

    if (response.response.result_omitted === true && response.response.result === undefined) {
      stopProgressTimer()
      const liveFallback = summarizeLiveLinearStageRun(liveRunRef.current, runId, response.command, commandMode)
      const baseSummary = liveFallback.steps.length ? liveFallback : summarizeOmittedLinearStageResult(response.response, runId, response.command, commandMode)
      const summary: LinearStageSummary = {
        ...baseSummary,
        status: 'fail',
        raw: {
          ...(typeof baseSummary.raw === 'object' && baseSummary.raw !== null ? baseSummary.raw : { raw: baseSummary.raw }),
          result_omitted: true,
          omitted_message: response.response.message,
        },
      }
      setRunSummary(summary)
      setLiveRun((current) => current ? { ...current, active: false, overallStatus: summary.status } : current)
      setFaultText('The tester completed but the full result payload was not captured. Keep the tester connected and repeat after engineering review.')
      setDeviceStatus('Fault')
      setLatestAction('Linear-stage result payload was omitted before the GUI captured full details.')
      setCurrentStep('review')
      await refreshLocalRecords()
      scheduleContextClear(runId)
      scheduleHistoryRefresh()
      return
    }

    if (isLinearStageSuiteQueueAcknowledgement(response.response.result)) {
      const queuedMessage = 'Suite runner accepted the linear-stage request. Waiting for published suite/session completion payloads.'
      setLatestAction(queuedMessage)
      setLiveRun((current) => {
        if (!current) return current
        const nextRun = {
          ...current,
          metadata: [queuedMessage, ...current.metadata].slice(0, 30),
        }
        liveRunRef.current = nextRun
        return nextRun
      })
      await refreshLocalRecords()
      scheduleHistoryRefresh()
      return
    }

    stopProgressTimer()
    const summary = summarizeLinearStageResult(response.response.result, runId, response.command, commandMode)
    setRunSummary(summary)
    setLiveRun(liveRunFromSummary(summary, liveRunRef.current))
    setDeviceStatus(summary.status === 'pass' ? 'Ready' : summary.status === 'warn' ? 'Warning' : 'Fault')
    setLatestAction(summary.status === 'pass' ? 'Linear-stage test passed.' : 'Linear-stage test needs review.')
    setCurrentStep('review')
    await refreshLocalRecords()
    scheduleContextClear(runId)
    scheduleHistoryRefresh()
  }

  async function completeLinearStageRunFromSuiteEvent(event: GuiEventEnvelope, currentRun: LiveLinearStageRun) {
    if (!currentRun.active && completedLinearRunIdsRef.current.has(currentRun.runId)) return
    completedLinearRunIdsRef.current.add(currentRun.runId)
    const eventStatus = parseEventStatus(event.data) ?? currentRun.overallStatus ?? 'fail'
    const eventDetail = asRecord(event.data.detail ?? event.data.Detail)
    const eventResult = resultCodeFromStatus(eventStatus)
    const eventMode = normalizeLinearStageMode(event.data.linear_stage_mode ?? event.data.mode ?? event.data.session_type) ?? currentRun.mode
    const finalRun: LiveLinearStageRun = {
      ...currentRun,
      active: false,
      overallStatus: eventStatus,
      metadata: [`Suite completion: ${event.event_name} ${statusLabel(eventStatus)}`, ...currentRun.metadata].slice(0, 30),
    }
    const summary = Object.keys(eventDetail).length > 0
      ? summarizeLinearStageResult(
          {
            Name: asString(event.data.test_name) ?? 'LINEAR_STAGE_COMPREHENSIVE',
            Result: eventResult,
            mode: eventMode,
            linear_stage_mode: eventMode,
            Profile: event.data.profile,
            Detail: eventDetail,
            ...event.data,
          },
          currentRun.runId,
          currentRun.command,
          eventMode,
        )
      : summarizeLiveLinearStageRun(finalRun, currentRun.runId, currentRun.command, eventMode)
    const finalSummary = summary.status === eventStatus
      ? summary
      : { ...summary, status: summary.evidence.issues.length ? 'fail' as const : eventStatus }

    stopProgressTimer()
    setRunSummary(finalSummary)
    const nextLiveRun = liveRunFromSummary(finalSummary, finalRun)
    liveRunRef.current = nextLiveRun
    setLiveRun(nextLiveRun)
    setDeviceStatus(finalSummary.status === 'pass' ? 'Ready' : finalSummary.status === 'warn' ? 'Warning' : 'Fault')
    setLatestAction(finalSummary.status === 'pass' ? 'Linear-stage suite completed and published.' : 'Linear-stage suite completed with evidence that needs review.')
    setCurrentStep('review')
    if (finalSummary.status !== 'pass') {
      setFaultText('Linear-stage suite completion payload reported failed or incomplete evidence.')
    }
    await refreshLocalRecords()
    scheduleContextClear(currentRun.runId)
    scheduleHistoryRefresh()
  }

  async function saveEngineeringOverride() {
    if (!overrideReason.trim()) {
      setFaultText('Engineering override requires a reason.')
      return
    }

    const override: OverrideRecord = {
      id: crypto.randomUUID(),
      operator: operator || 'Engineering',
      action: overrideAction,
      reason: overrideReason.trim(),
      created_at: new Date().toISOString(),
      run_uid: activeRunId,
    }
    try {
      await api.saveOverride(override)
      setOverrideReason('')
      setLatestAction(`Engineering override recorded: ${overrideAction}.`)
      await refreshLocalRecords()
    } catch (error) {
      setFaultText(error instanceof Error ? error.message : 'Engineering override could not be saved.')
    }
  }

  function resetForNextRun() {
    setRunSummary(null)
    setLiveRun(null)
    liveRunRef.current = null
    completedLinearRunIdsRef.current.clear()
    setStageClear(false)
    setActiveRunId('')
    setFaultText('')
    setDeviceStatus('Ready')
    setCurrentStep('clear')
    setLatestAction('Ready for the next linear-stage run after stage-clear confirmation.')
    clearContextClearTimer()
    void api.setActiveRunContext(undefined)
  }

  function requireFreshStageClearForRepeat() {
    setRunSummary(null)
    setLiveRun(null)
    liveRunRef.current = null
    completedLinearRunIdsRef.current.clear()
    setStageClear(false)
    setCurrentStep('clear')
    setFaultText('')
    setDeviceStatus('Ready')
    setLatestAction('Confirm the stage is clear before repeating the motion test.')
    clearContextClearTimer()
    void api.setActiveRunContext(undefined)
  }

  function resetMotionReadiness(step: LinearWorkflowStep = 'connect') {
    beginOperation()
    stopProgressTimer()
    clearContextClearTimer()
    setRunProgress(undefined)
    setLiveRun(null)
    liveRunRef.current = null
    completedLinearRunIdsRef.current.clear()
    setStageClear(false)
    setReadiness(buildReadinessItems())
    setCurrentStep(step)
    void api.setActiveRunContext(undefined)
  }

  async function handleModeChange(nextMode: ConnectionMode) {
    if (runControlsLocked) {
      setFaultText('Finish the current linear-stage run review before changing the connection mode.')
      return
    }
    if (nextMode === mode) return
    if (nextMode === 'serial' && !serialAvailable) {
      setFaultText('Serial hardware access is only available in the Electron app. Browser preview is mock-only.')
      return
    }
    setMode(nextMode)
    setConnected(false)
    setConnectedMode(undefined)
    setDeviceStatus('Disconnected')
    setLatestAction('Connection mode changed. Reconnect tester before testing.')
    resetMotionReadiness('connect')
    await api.disconnect()
  }

  function handleLinearStageModeChange(nextMode: LinearStageMode) {
    if (runControlsLocked) {
      setFaultText('Finish the current linear-stage run review before changing test mode.')
      return
    }
    if (nextMode === linearStageMode) return
    setLinearStageMode(nextMode)
    setLinearCommand(commandForLinearStageMode(nextMode))
    setRunSummary(null)
    setLiveRun(null)
    liveRunRef.current = null
    completedLinearRunIdsRef.current.clear()
    setStageClear(false)
    setCurrentStep(readinessReady ? 'clear' : currentStep)
    setLatestAction(`${LINEAR_STAGE_MODE_CONFIGS[nextMode].label} selected. Confirm stage clear before starting.`)
    void api.setActiveRunContext(undefined)
  }

  function handleLinearCommandChange(command: string) {
    setLinearCommand(command)
    const commandMode = modeForLinearStageCommand(command)
    if (commandMode) {
      setLinearStageMode(commandMode)
    }
  }

  async function handlePortChange(nextPort: string) {
    if (runControlsLocked) {
      setFaultText('Finish the current linear-stage run review before changing the COM port.')
      return
    }
    setSelectedPort(nextPort)
    if (!connected) return
    setConnected(false)
    setConnectedMode(undefined)
    setDeviceStatus('Disconnected')
    setLatestAction('COM port changed. Reconnect tester before testing.')
    resetMotionReadiness('connect')
    await api.disconnect()
  }

  function scheduleContextClear(runId: string) {
    clearContextClearTimer()
    contextClearTimer.current = window.setTimeout(() => {
      void api.getActiveRunContext().then((context) => {
        if (context?.linear_stage_run_id === runId) {
          return api.setActiveRunContext(undefined)
        }
        return undefined
      })
    }, ACTIVE_CONTEXT_CLEAR_DELAY_MS)
  }

  function clearContextClearTimer() {
    if (contextClearTimer.current !== undefined) {
      window.clearTimeout(contextClearTimer.current)
      contextClearTimer.current = undefined
    }
  }

  function scheduleHistoryRefresh() {
    clearHistoryRefreshTimer()
    historyRefreshTimer.current = window.setTimeout(() => {
      void refreshLocalRecords()
    }, HISTORY_REFRESH_DELAY_MS)
  }

  function clearHistoryRefreshTimer() {
    if (historyRefreshTimer.current !== undefined) {
      window.clearTimeout(historyRefreshTimer.current)
      historyRefreshTimer.current = undefined
    }
  }

  async function refreshLocalRecords(offset = historyOffset, textFilter = historyTextFilter, runIdFilter = historyRunFilter) {
    const [summary, records] = await Promise.all([
      api.getStorageSummary(),
      api.getHistoricalRecords({
        limit: HISTORY_PAGE_LIMIT,
        offset,
        workflow: 'linear_stage',
        linearStageRunId: runIdFilter || undefined,
        text: textFilter || undefined,
      }),
    ])
    setStorageSummary(summary)
    setHistoricalRecords(records)
    setHistoryOffset(offset)
  }

  function updateHistoryTextFilter(value: string) {
    setHistoryTextFilter(value)
    void refreshLocalRecords(0, value)
  }

  function updateHistoryRunFilter(value: string) {
    setHistoryRunFilter(value)
    void refreshLocalRecords(0, historyTextFilter, value)
  }

  async function commitSettingSelection(
    defaultKey: keyof StationSettings,
    listKey: keyof StationSettings,
    value: string,
  ) {
    const trimmed = canonicalizeStationValue(defaultKey, value)
    if (!trimmed) return
    const existingList = settings[listKey]
    const nextList = Array.isArray(existingList) ? Array.from(new Set([...existingList, trimmed])) : [trimmed]
    const nextSettings = { ...settings, [defaultKey]: trimmed, [listKey]: nextList }
    setSettings(nextSettings)
    setSettings(await api.saveSettings(nextSettings))
  }

  async function addSettingOption(listKey: keyof StationSettings, value: string) {
    const trimmed = canonicalizeStationValue(listKey, value)
    if (!trimmed) return
    const existingList = settings[listKey]
    const nextList = Array.isArray(existingList) ? Array.from(new Set([...existingList, trimmed])) : [trimmed]
    const nextSettings = { ...settings, [listKey]: nextList }
    setSettings(nextSettings)
    setSettings(await api.saveSettings(nextSettings))
  }

  function updateTesterSerial(value: string) {
    setTesterDeviceSerial(value)
    void commitSettingSelection('defaultTesterDeviceSerial', 'testerDeviceSerials', value)
  }

  function updateBatch(value: string) {
    setBatch(value)
    void commitSettingSelection('latestBatch', 'batches', value)
  }

  function openEngineering() {
    if (engineeringUnlocked) {
      setEngineeringOpen(true)
      return
    }
    setPasswordDialogOpen(true)
  }

  function beginOperation() {
    operationToken.current += 1
    return operationToken.current
  }

  function startProgressTimer() {
    stopProgressTimer()
    const startedAt = Date.now()
    setRunProgress({ active: true, elapsedMs: 0 })
    progressTimer.current = window.setInterval(() => {
      setRunProgress({ active: true, elapsedMs: Date.now() - startedAt })
    }, 500)
  }

  function stopProgressTimer() {
    if (progressTimer.current !== undefined) {
      window.clearInterval(progressTimer.current)
      progressTimer.current = undefined
    }
    clearSuiteCompletionTimer()
    setRunProgress(null)
  }

  function scheduleSuiteCompletionTimeout(runId: string, command: string, mode: LinearStageMode) {
    clearSuiteCompletionTimer()
    const config = LINEAR_STAGE_MODE_CONFIGS[mode]
    suiteCompletionTimer.current = window.setTimeout(() => {
      const currentRun = liveRunRef.current
      if (!currentRun || currentRun.runId !== runId || !currentRun.active) return
      const message = `Suite runner did not publish a completion payload within the ${config.timeoutLabel}.`
      const failedRun = markLiveRunCommandError(currentRun, message)
      if (!failedRun) return
      const summary = summarizeLiveLinearStageRun(failedRun, runId, command, mode)
      liveRunRef.current = failedRun
      setLiveRun(failedRun)
      setRunSummary({ ...summary, status: 'fail' })
      setDeviceStatus('Fault')
      setFaultText(message)
      setLatestAction(message)
      setCurrentStep('review')
      setRunProgress(null)
      void api.setActiveRunContext(undefined)
      scheduleHistoryRefresh()
    }, config.timeoutMs)
  }

  function clearSuiteCompletionTimer() {
    if (suiteCompletionTimer.current !== undefined) {
      window.clearTimeout(suiteCompletionTimer.current)
      suiteCompletionTimer.current = undefined
    }
  }

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h5">SporeScout Linear Stage Tester</Typography>
            <Typography color="text.secondary" variant="body2">
              Operator-guided motion, optical response, and scan audit validation.
            </Typography>
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(220px, 1fr))' }, gap: 1.5 }}>
            <EditableConfigField
              label="Operator"
              value={operator}
              options={settings.operators}
              required
              error={!operatorValid}
              errorMessage={operator.trim() ? 'Press Enter to save this operator before testing.' : 'Operator is required.'}
              info="Required for every run. Select your name, or type a new name and press Enter."
              disabled={runControlsLocked}
              onValueChange={setOperator}
              onCommit={(value) => addSettingOption('operators', value)}
            />
            <EditableConfigField
              label="Batch"
              value={batch}
              options={settings.batches}
              required
              error={!batchValid}
              errorMessage={batch.trim() ? 'Press Enter to save this batch before testing.' : 'Batch is required.'}
              info="Batch is stored with the local record for this test. Type a new batch and press Enter to save it as the default."
              disabled={runControlsLocked}
              onValueChange={setBatch}
              onCommit={updateBatch}
            />
            <EditableConfigField
              label="Tester serial"
              value={testerDeviceSerial}
              options={settings.testerDeviceSerials}
              required
              error={!testerSerialValid}
              errorMessage="Expected format: SS-A-001-XXX-YYYY."
              info="Serial for the complete tester/electronics assembly. Type a replacement tester serial and press Enter to save it."
              disabled={runControlsLocked}
              onValueChange={setTesterDeviceSerial}
              onCommit={updateTesterSerial}
            />
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: '160px minmax(260px, 1fr) 150px 48px',
              },
              gap: 1.5,
              alignItems: 'center',
            }}
          >
            <Tooltip title={serialAvailable ? 'Use Serial for a real tester over USB. Mock runs the workflow without hardware.' : 'Browser preview is mock-only. Use the Electron app for real serial hardware.'}>
              <FormControl size="small" fullWidth disabled={runControlsLocked}>
                <InputLabel>Mode</InputLabel>
                <Select label="Mode" value={mode} onChange={(event) => void handleModeChange(event.target.value as ConnectionMode)}>
                  <MenuItem value="mock">Mock</MenuItem>
                  <MenuItem value="serial" disabled={!serialAvailable}>Serial</MenuItem>
                </Select>
              </FormControl>
            </Tooltip>
            <Tooltip title={serialAvailable ? 'Select the USB serial connection for the tester.' : 'Real serial ports are disabled in browser preview.'}>
              <FormControl size="small" fullWidth disabled={mode === 'mock' || !serialAvailable || runControlsLocked}>
                <InputLabel>COM port</InputLabel>
                <Select label="COM port" value={selectedPort} onChange={(event) => void handlePortChange(event.target.value)}>
                  {ports.map((port) => (
                    <MenuItem key={port.path} value={port.path}>
                      {port.friendlyName ?? port.path}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Tooltip>
            <Button variant="contained" startIcon={<UsbIcon />} onClick={connectTester} disabled={runControlsLocked} sx={{ width: '100%' }}>
              Connect
            </Button>
            <Tooltip title="Engineering">
              <IconButton aria-label="Open engineering" onClick={openEngineering} color={engineeringUnlocked ? 'primary' : 'default'}>
                <ScienceIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Stack>
      </Paper>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 34, flexWrap: 'wrap' }}>
        <StatusChip label={deviceStatus} connected={connected} status={runSummary?.status} />
        <Chip size="small" label={appVersionStatusLabel(appVersion, updateResult)} color={appVersionStatusColor(updateResult)} />
        {updateResult.status === 'available' && <Chip size="small" label={`Update: v${formatDisplayVersion(updateResult.version)}`} color="warning" />}
        {activeRunId && <Chip size="small" label={activeRunId} onClick={() => updateHistoryRunFilter(activeRunId)} />}
        {faultText && <Alert severity="error" sx={{ py: 0, flex: 1 }}>{faultText}</Alert>}
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '220px minmax(0, 1fr)', xl: '220px minmax(0, 1fr) 330px' }, gap: 2, minWidth: 0 }}>
        <Paper variant="outlined" sx={{ p: 1.5, height: 'fit-content' }}>
          <Typography variant="subtitle2" sx={{ px: 1, mb: 1 }}>
            Progress
          </Typography>
          <List dense disablePadding>
            {activeSteps.map((step) => (
              <ListItem key={step.id} disableGutters sx={{ px: 1 }}>
                <ListItemIcon sx={{ minWidth: 30 }}>
                  <StepIcon status={step.status} />
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

        <Paper variant="outlined" data-linear-stage-workflow-step={currentStep} sx={{ minHeight: 500, minWidth: 0, p: 3 }}>
          {renderMainStep()}
        </Paper>

        <Paper variant="outlined" sx={{ p: 2, height: 'fit-content', minWidth: 0, gridColumn: { lg: '1 / -1', xl: 'auto' } }}>
          <Typography variant="subtitle2" gutterBottom>
            Current Run
          </Typography>
          <Stack spacing={1.25}>
            <DetailRow label="Operator" value={operator || 'Required'} />
            <DetailRow label="Batch" value={batch || 'Required'} />
            <DetailRow label="Tester" value={testerDeviceSerial || 'Required'} />
            <LinearStageModeSelector
              mode={linearStageMode}
              disabled={runControlsLocked}
              onModeChange={handleLinearStageModeChange}
            />
            <DetailRow label="Mode" value={selectedModeConfig.shortLabel} />
            <DetailRow label="Command" value={selectedLinearCommand ?? linearCommand} />
            <DetailRow label="Stage clear" value={stageClear ? 'Confirmed' : 'Required'} valueColor={stageClear ? 'success.main' : 'warning.main'} />
            <Divider />
            <LinearResultLine summary={runSummary} />
            <DetailRow label="Live progress" value={liveRun ? `${liveCompletedCount}/${liveRun.steps.length}` : '-'} />
            <DetailRow label="Current step" value={liveCurrentStep ? `${liveCurrentStep.number}. ${liveCurrentStep.name}` : '-'} />
            <DetailRow label="Failed steps" value={String(failedStepCount)} />
            <DetailRow label="Warnings" value={String(warningStepCount)} />
            <DetailRow label="Metrics" value={String(runSummary?.metrics.length ?? 0)} />
          </Stack>
        </Paper>
      </Box>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }}>
          <Typography variant="body2" color="text.secondary" sx={{ minWidth: 130 }}>
            Latest device action
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{latestAction}</Typography>
        </Stack>
      </Paper>

      <LinearHistoryPanel
        records={visibleHistory}
        rawRecords={historicalRecords}
        storageSummary={storageSummary}
        offset={historyOffset}
        limit={HISTORY_PAGE_LIMIT}
        textFilter={historyTextFilter}
        runFilter={historyRunFilter}
        activeRunId={activeRunId}
        onTextFilterChange={updateHistoryTextFilter}
        onRunFilterChange={updateHistoryRunFilter}
        onPage={(offset) => refreshLocalRecords(offset)}
        onRefresh={() => refreshLocalRecords()}
      />

      <EngineeringPasswordDialog
        open={passwordDialogOpen}
        password={engineeringPassword}
        onPasswordChange={setEngineeringPassword}
        onClose={() => setPasswordDialogOpen(false)}
        onUnlock={() => {
          void api.unlockEngineering(engineeringPassword).then((result) => {
            if (result.ok) {
              setEngineeringUnlocked(true)
              setEngineeringOpen(true)
              setPasswordDialogOpen(false)
              setEngineeringPassword('')
              setFaultText('')
            } else {
              setFaultText(result.error ?? 'Engineering password did not match.')
            }
          })
        }}
      />

      <EngineeringDrawer
        open={engineeringOpen}
        onClose={() => setEngineeringOpen(false)}
        rawLines={rawLines}
        events={events}
        summary={runSummary}
        storageSummary={storageSummary}
        command={linearCommand}
        onCommandChange={handleLinearCommandChange}
        commandValid={Boolean(selectedLinearCommand)}
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
              Select the tester connection. The app checks firmware response and operator setup before motion is allowed.
            </Typography>
          </Box>
          <ReadinessList items={readiness} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" startIcon={<UsbIcon />} onClick={connectTester}>
              Connect tester
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={() => runReadiness()} disabled={!connected}>
              Re-run readiness
            </Button>
          </Stack>
        </Stack>
      )
    }

    if (currentStep === 'clear') {
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Clear stage area</Typography>
            <Typography color="text.secondary">
              Confirm there are no tools, loose parts, hands, or packaging in the stage travel path.
            </Typography>
          </Box>
          <Alert severity="warning" icon={<WarningAmberIcon />}>
            The next step moves the X, Y, and Z stages. Keep the stage clear for the entire test.
          </Alert>
          <FormControlLabel
            control={<Checkbox checked={stageClear} onChange={(event) => setStageClear(event.target.checked)} />}
            label="Stage area is clear and ready for motion"
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" disabled={!stageClear} onClick={() => runReadiness()}>
              Confirm readiness
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={() => runReadiness()} disabled={!connected}>
              Re-check tester
            </Button>
          </Stack>
        </Stack>
      )
    }

    if (currentStep === 'run') {
      return (
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h6">Run linear-stage test</Typography>
            <Typography color="text.secondary">
              {selectedModeConfig.scope} {selectedModeConfig.operatorNote}
            </Typography>
          </Box>
          <Alert severity={runProgress?.active || canStartTest ? 'info' : 'warning'}>
            {runProgress?.active
              ? 'Test is running. Keep the stage clear until the tester parks.'
              : canStartTest
                ? 'Ready to start. Keep the stage clear after pressing Start.'
                : 'Complete all readiness checks before starting.'}
          </Alert>
          {runProgress?.active && (
            <Box>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }}>
                <Typography variant="body2">Linear-stage routine running</Typography>
                <Typography variant="body2" color="text.secondary">
                  {formatElapsed(runProgress.elapsedMs)}
                </Typography>
              </Stack>
              <LinearProgress />
            </Box>
          )}
          <LiveLinearStagePanel liveRun={liveRun} elapsedMs={runProgress?.elapsedMs} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={startLinearStageTest} disabled={!canStartTest || Boolean(runProgress?.active)}>
              Start test
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={() => runReadiness()} disabled={!connected || Boolean(runProgress?.active)}>
              Re-run readiness
            </Button>
          </Stack>
        </Stack>
      )
    }

    if (currentStep === 'review') {
      return (
        <Stack spacing={2}>
          <LinearResultSummary summary={runSummary} />
          <LinearEvidencePanel summary={runSummary} />
          <LiveLinearStagePanel liveRun={liveRun} elapsedMs={runProgress?.elapsedMs} />
          <AxisSummaryPanel summary={runSummary} />
          <MetricHistogramPanel summary={runSummary} />
          <StepResultTable summary={runSummary} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant="contained" onClick={resetForNextRun}>
              Next run
            </Button>
            <Button startIcon={<RefreshIcon />} onClick={requireFreshStageClearForRepeat} disabled={Boolean(runProgress?.active)}>
              Repeat test
            </Button>
            <Button onClick={() => {
              void api.setActiveRunContext(undefined)
              setCurrentStep('next')
            }}>
              Exit
            </Button>
          </Stack>
        </Stack>
      )
    }

    return (
      <Stack spacing={2.5}>
        <Box>
          <Typography variant="h6">Exit test</Typography>
          <Typography color="text.secondary">
            The linear-stage command parks the steppers before returning. Leave the tester connected if another run is planned.
          </Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={resetForNextRun}>
            Start another run
          </Button>
          <Button onClick={() => setCurrentStep('connect')}>Back to connect</Button>
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
            <StepIcon status={item.status === 'passed' ? 'complete' : item.status === 'failed' ? 'failed' : item.status === 'running' ? 'active' : 'pending'} />
          </ListItemIcon>
          <ListItemText
            primary={
              <Stack component="span" direction="row" alignItems="center" spacing={0.75}>
                <Box component="span">{item.label}</Box>
                <InlineInfoIcon title={item.info} />
              </Stack>
            }
            secondary={readinessStatusText(item)}
            primaryTypographyProps={{ variant: 'body2' }}
            secondaryTypographyProps={{ variant: 'caption' }}
          />
        </ListItem>
      ))}
    </List>
  )
}

function StepIcon({ status }: { status: 'pending' | 'active' | 'complete' | 'failed' | 'warning' }) {
  if (status === 'complete') return <CheckCircleIcon color="success" fontSize="small" />
  if (status === 'failed') return <ErrorOutlineIcon color="error" fontSize="small" />
  if (status === 'warning') return <WarningAmberIcon color="warning" fontSize="small" />
  if (status === 'active') return <RefreshIcon color="primary" fontSize="small" />
  return <Box sx={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid', borderColor: 'grey.300' }} />
}

function EditableConfigField(props: {
  label: string
  value: string
  options: string[]
  info: string
  onValueChange: (value: string) => void
  onCommit: (value: string) => void | Promise<void>
  required?: boolean
  error?: boolean
  errorMessage?: string
  disabled?: boolean
}) {
  const commit = () => {
    const trimmedValue = props.value.trim()
    if (trimmedValue) {
      void props.onCommit(trimmedValue)
    }
  }

  return (
    <Autocomplete
      freeSolo
      options={props.options}
      value={props.value}
      inputValue={props.value}
      disabled={props.disabled}
      onChange={(_event, value) => {
        const nextValue = value ?? ''
        props.onValueChange(nextValue)
        if (nextValue.trim()) {
          void props.onCommit(nextValue)
        }
      }}
      onInputChange={(_event, value) => props.onValueChange(value)}
      sx={{ minWidth: 0 }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={props.label}
          required={props.required}
          size="small"
          error={props.error}
          helperText={props.error ? props.errorMessage : undefined}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                <InlineInfoIcon title={props.info} />
                {params.InputProps.endAdornment}
              </Box>
            ),
          }}
        />
      )}
    />
  )
}

function InlineInfoIcon({ title }: { title: string }) {
  return (
    <Tooltip title={title} enterDelay={250}>
      <IconButton
        aria-label={title}
        size="small"
        sx={{ color: 'text.secondary', flexShrink: 0, lineHeight: 0, p: 0.25 }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  )
}

function StatusChip({ label, connected, status }: { label: string; connected: boolean; status?: LinearRunStatus }) {
  const color = status === 'fail' ? 'error' : status === 'warn' ? 'warning' : connected ? 'success' : 'default'
  return <Chip size="small" label={label} color={color} />
}

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" textAlign="right" color={valueColor ?? 'text.primary'} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
        {value}
      </Typography>
    </Stack>
  )
}

function LinearStageModeSelector({
  mode,
  disabled,
  onModeChange,
}: {
  mode: LinearStageMode
  disabled: boolean
  onModeChange: (mode: LinearStageMode) => void
}) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
        Test mode
      </Typography>
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
        {LINEAR_STAGE_MODE_ORDER.map((candidate) => {
          const config = LINEAR_STAGE_MODE_CONFIGS[candidate]
          const selected = candidate === mode
          return (
            <Tooltip key={candidate} title={`${config.scope} ${config.operatorNote}`}>
              <span>
                <Button
                  size="small"
                  variant={selected ? 'contained' : 'outlined'}
                  disabled={disabled}
                  onClick={() => onModeChange(candidate)}
                  sx={{ minWidth: 86 }}
                >
                  {config.shortLabel}
                </Button>
              </span>
            </Tooltip>
          )
        })}
      </Stack>
    </Box>
  )
}

function LinearResultLine({ summary }: { summary: LinearStageSummary | null }) {
  const status = summary?.status ?? 'waiting'
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2} alignItems="center">
      <Typography variant="body2" color="text.secondary">
        Result
      </Typography>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <ResultIcon status={status} />
        <Typography variant="body2" textAlign="right" color={statusColor(status)} sx={{ overflowWrap: 'anywhere' }}>
          {statusLabel(status)}
        </Typography>
      </Stack>
    </Stack>
  )
}

function ResultIcon({ status }: { status: LinearRunStatus }) {
  if (status === 'pass') return <CheckCircleIcon color="success" fontSize="small" />
  if (status === 'warn') return <WarningAmberIcon color="warning" fontSize="small" />
  if (status === 'fail') return <ErrorOutlineIcon color="error" fontSize="small" />
  if (status === 'running') return <RefreshIcon color="primary" fontSize="small" />
  return <InfoOutlinedIcon color="disabled" fontSize="small" />
}

function LinearResultSummary({ summary }: { summary: LinearStageSummary | null }) {
  const status = summary?.status ?? 'waiting'
  const failed = summary?.steps.filter((step) => step.result === 'Fail').length ?? 0
  const warned = summary?.steps.filter((step) => step.result === 'Warn').length ?? 0

  return (
    <Box data-linear-stage-result-summary data-linear-stage-result-status={status} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
      <Stack spacing={1.25}>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <ResultIcon status={status} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1">{statusLabel(status)}</Typography>
              <Typography variant="body2" color="text.secondary">
                {status === 'pass'
                  ? 'The firmware reported a complete pass and parked the steppers.'
                  : status === 'waiting'
                    ? 'Run the test to populate result details.'
                    : 'Review the failed or warning steps before moving the tester back into service.'}
                </Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
            <Metric label="Mode" value={summary?.mode ? LINEAR_STAGE_MODE_CONFIGS[summary.mode].shortLabel : '-'} />
            <Metric label="Steps" value={String(summary?.steps.length ?? 0)} />
            <Metric label="Failed" value={String(failed)} color={failed ? 'error.main' : 'success.main'} />
            <Metric label="Warnings" value={String(warned)} color={warned ? 'warning.main' : 'success.main'} />
          </Stack>
        </Stack>
      </Stack>
    </Box>
  )
}

function LinearEvidencePanel({ summary }: { summary: LinearStageSummary | null }) {
  if (!summary) return null

  const evidence = summary.evidence
  const hasIssues = evidence.issues.length > 0
  const sections = [
    { title: 'Safety state', lines: evidence.safety, empty: 'No explicit final safety fields were reported.' },
    { title: 'Scan and optical evidence', lines: evidence.scan, empty: 'No scan or overlap evidence is expected for this mode.' },
    { title: 'Upload and supporting files', lines: [...evidence.upload, ...evidence.artifacts], empty: 'No artifact or upload paths were reported.' },
  ]

  return (
    <Box data-linear-stage-evidence-status={hasIssues ? 'fail' : 'clean'} sx={{ border: '1px solid', borderColor: hasIssues ? 'error.light' : 'success.light', borderRadius: 1, p: 1.5 }}>
      <Stack spacing={1.25}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between">
          <Box>
            <Typography variant="subtitle1">Evidence review</Typography>
            <Typography variant="body2" color="text.secondary">
              Final status includes safety, scan audit, artifact generation, upload, and optical overlap evidence.
            </Typography>
          </Box>
          <Chip
            size="small"
            color={hasIssues ? 'error' : 'success'}
            icon={hasIssues ? <ErrorOutlineIcon /> : <CheckCircleIcon />}
            label={hasIssues ? 'Needs review' : 'Clean evidence'}
          />
        </Stack>

        {hasIssues && (
          <Alert severity="error">
            <Stack spacing={0.5}>
              {evidence.issues.map((issue) => (
                <Typography key={issue} variant="body2">
                  {issue}
                </Typography>
              ))}
            </Stack>
          </Alert>
        )}

        {evidence.errors.length > 0 && (
          <Alert severity="warning">
            <Stack spacing={0.5}>
              {evidence.errors.map((error) => (
                <Typography key={error} variant="body2">
                  {error}
                </Typography>
              ))}
            </Stack>
          </Alert>
        )}

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
          {sections.map((section) => (
            <Box key={section.title} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25, minWidth: 0 }}>
              <Typography variant="subtitle2" gutterBottom>
                {section.title}
              </Typography>
              {section.lines.length ? (
                <Stack spacing={0.5}>
                  {section.lines.slice(0, 8).map((line) => (
                    <Typography key={line} variant="caption" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                      {line}
                    </Typography>
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {section.empty}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      </Stack>
    </Box>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ minWidth: 72 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" color={color ?? 'text.primary'} sx={{ lineHeight: 1.25 }}>
        {value}
      </Typography>
    </Box>
  )
}

function LiveLinearStagePanel({ liveRun, elapsedMs }: { liveRun: LiveLinearStageRun | null; elapsedMs?: number }) {
  if (!liveRun) return null

  const completedSteps = liveRun.steps.filter((step) => isLiveStepComplete(step.status))
  const completed = completedSteps.length
  const failedSteps = liveRun.steps.filter((step) => step.status === 'fail')
  const failed = failedSteps.length
  const warned = liveRun.steps.filter((step) => step.status === 'warn').length
  const unreported = liveRun.active ? 0 : liveRun.steps.filter((step) => step.status === 'pending').length
  const current = liveRun.steps.find((step) => step.status === 'running')
  const next = current
    ? liveRun.steps.find((step) => step.number > current.number && step.status === 'pending')
    : liveRun.steps.find((step) => step.status === 'pending')
  const lastCompleted = completedSteps[completedSteps.length - 1]
  const firstFailed = failedSteps[0]
  const progressPct = liveRun.steps.length ? Math.round((completed / liveRun.steps.length) * 100) : 0
  const status = liveRun.overallStatus ?? (liveRun.active ? 'running' : failed ? 'fail' : warned ? 'warn' : completed ? 'pass' : 'waiting')
  const positionText = current
    ? `Now: ${current.number}. ${current.name}`
    : liveRun.active && next
      ? `Between phases: ${completed}/${liveRun.steps.length} complete. Waiting for ${next.number}. ${next.name} to start.`
      : unreported
        ? `Run ended with ${unreported}/${liveRun.steps.length} planned phases not reported.`
      : next
        ? `Next: ${next.number}. ${next.name}`
        : 'All planned steps have reported.'
  const nowFallback = liveRun.active && next
    ? `Between phases. Waiting for ${next.number}. ${next.name} to start.`
    : liveRun.active
      ? 'Waiting for firmware to report the next phase.'
      : 'No active phase.'
  const nextFallback = liveRun.active
    ? 'Waiting for the final firmware response.'
    : unreported
      ? 'No further phases reported after the failure.'
    : 'All planned phases reported.'

  return (
    <Box data-linear-stage-live-active={liveRun.active ? 'true' : 'false'} data-linear-stage-live-status={status} sx={{ border: '1px solid', borderColor: liveStatusBorderColor(status), borderRadius: 1, overflow: 'hidden' }}>
      <Box sx={{ p: 1.5, bgcolor: liveRun.active ? 'rgba(19, 151, 241, 0.08)' : 'grey.50', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} justifyContent="space-between">
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <ResultIcon status={status} />
              <Typography variant="subtitle2">
                {liveRun.active ? `${LINEAR_STAGE_MODE_CONFIGS[liveRun.mode].label} in progress` : `${LINEAR_STAGE_MODE_CONFIGS[liveRun.mode].shortLabel} live trace ${statusLabel(status)}`}
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {positionText}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
            <Metric label="Progress" value={`${completed}/${liveRun.steps.length}`} color={failed ? 'error.main' : warned ? 'warning.main' : 'success.main'} />
            <Metric label="Failed" value={String(failed)} color={failed ? 'error.main' : 'success.main'} />
            <Metric label="Elapsed" value={elapsedMs !== undefined ? formatElapsed(elapsedMs) : '-'} />
          </Stack>
        </Stack>
        <Box sx={{ mt: 1.25 }}>
          <LinearProgress variant="determinate" value={progressPct} color={failed ? 'error' : warned ? 'warning' : 'primary'} />
        </Box>
        {firstFailed && liveRun.active && (
          <Alert severity="error" icon={<ErrorOutlineIcon />} sx={{ mt: 1.25, py: 0.75 }}>
            Step {firstFailed.number} failed: {firstFailed.name}. The tester may keep moving to finish safety checks and park, but this run already needs review.
          </Alert>
        )}
      </Box>

      <Box sx={{ p: 1.5 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 1, mb: 1.5 }}>
          <LivePhaseCard title="Now" step={current} active={liveRun.active} fallback={nowFallback} />
          <LivePhaseCard title="Latest result" step={lastCompleted} active={liveRun.active} fallback="No phase has completed yet." />
          <LivePhaseCard title="Next up" step={next} active={liveRun.active} fallback={nextFallback} />
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1.3fr) minmax(320px, 0.7fr)' }, gap: 1.5 }}>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              Completed, current, and upcoming firmware phases
            </Typography>
            <Box sx={{ maxHeight: 360, overflow: 'auto', pr: 0.5 }}>
              <Stack spacing={0.75}>
                {liveRun.steps.map((step) => (
                  <Box
                    key={`${step.number}-${step.name}`}
                    data-linear-stage-phase={step.name}
                    sx={{
                      border: '1px solid',
                      borderColor: liveStepBorderColor(step.status),
                      bgcolor: step.status === 'running' ? 'rgba(19, 151, 241, 0.08)' : 'background.paper',
                      borderRadius: 1,
                      p: 1,
                    }}
                  >
                    <Stack direction="row" spacing={1} alignItems="flex-start">
                      <StepIcon status={liveStepIconStatus(step.status)} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1}>
                          <Typography variant="body2" sx={{ fontWeight: step.status === 'running' ? 600 : 400 }}>
                            {step.number}. {step.name}
                          </Typography>
                          <Typography variant="caption" color={liveStepTextColor(step.status)}>
                            {liveStepLabel(step.status, liveRun.active)}
                          </Typography>
                        </Stack>
                        {(step.measured !== undefined || step.error) && (
                          <Typography variant="caption" color={step.status === 'fail' ? 'error.main' : 'text.secondary'} sx={{ display: 'block', mt: 0.25, overflowWrap: 'anywhere' }}>
                            {step.error ?? compactInlineValue(step.measured)}
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  </Box>
                ))}
              </Stack>
            </Box>
          </Box>

          <Stack spacing={1.5}>
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
              <Typography variant="subtitle2" gutterBottom>
                Current context
              </Typography>
              <DetailRow label="Command" value={liveRun.command} />
              {current ? (
                <Stack spacing={0.75}>
                  <DetailRow label="Step" value={`${current.number}. ${current.name}`} />
                  <DetailRow label="Status" value={liveStepLabel(current.status)} valueColor={liveStepTextColor(current.status)} />
                  <DetailRow label="Next" value={next ? `${next.number}. ${next.name}` : 'Waiting for final response'} />
                  {current.expected !== undefined && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">Expected</Typography>
                      <CompactJson value={current.expected} />
                    </Box>
                  )}
                  {current.measured !== undefined && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">Measured</Typography>
                      <CompactJson value={current.measured} />
                    </Box>
                  )}
                  {current.error && (
                    <Alert severity="error" sx={{ py: 0.5 }}>
                      {current.error}
                    </Alert>
                  )}
                </Stack>
              ) : (
                <Stack spacing={0.75}>
                  <Typography variant="body2" color="text.secondary">
                    {liveRun.active && next
                      ? `Waiting for firmware to start step ${next.number}. ${next.name}.`
                      : 'Waiting for the next firmware step update.'}
                  </Typography>
                  {lastCompleted && (
                    <DetailRow label="Last completed" value={`${lastCompleted.number}. ${lastCompleted.name}`} />
                  )}
                  {next && (
                    <DetailRow label="Next" value={`${next.number}. ${next.name}`} />
                  )}
                </Stack>
              )}
            </Box>

            <Box sx={{ border: '1px solid', borderColor: firstFailed ? 'error.light' : 'divider', borderRadius: 1, p: 1.25 }}>
              <Typography variant="subtitle2" gutterBottom>
                Latest completed phase
              </Typography>
              {lastCompleted ? (
                <Stack spacing={0.75}>
                  <DetailRow label="Step" value={`${lastCompleted.number}. ${lastCompleted.name}`} />
                  <DetailRow label="Result" value={liveStepLabel(lastCompleted.status)} valueColor={liveStepTextColor(lastCompleted.status)} />
                  {lastCompleted.measured !== undefined && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">Measured artifact</Typography>
                      <CompactJson value={lastCompleted.measured} />
                    </Box>
                  )}
                  {lastCompleted.expected !== undefined && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">Expected context</Typography>
                      <CompactJson value={lastCompleted.expected} />
                    </Box>
                  )}
                  {lastCompleted.error && (
                    <Alert severity="error" sx={{ py: 0.5 }}>
                      {lastCompleted.error}
                    </Alert>
                  )}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Results will appear as soon as each firmware phase completes.
                </Typography>
              )}
            </Box>

            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
              <Typography variant="subtitle2" gutterBottom>
                Latest metadata and artifacts
              </Typography>
              {liveRun.metadata.length || liveRun.artifacts.length ? (
                <Stack spacing={0.75}>
                  {liveRun.artifacts.slice(0, 6).map((line, index) => (
                    <Typography key={`artifact-${index}-${line}`} variant="caption" color="primary.main" sx={{ overflowWrap: 'anywhere' }}>
                      {line}
                    </Typography>
                  ))}
                  {liveRun.metadata.slice(0, 6).map((line, index) => (
                    <Typography key={`metadata-${index}-${line}`} variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                      {line}
                    </Typography>
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Metadata and artifacts will appear here as the firmware reports them.
                </Typography>
              )}
            </Box>
          </Stack>
        </Box>
      </Box>
    </Box>
  )
}

function LivePhaseCard({ title, step, active, fallback }: { title: string; step?: LiveLinearStageStep; active: boolean; fallback: string }) {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: step ? liveStepBorderColor(step.status) : 'divider',
        bgcolor: step?.status === 'running' ? 'rgba(19, 151, 241, 0.08)' : 'background.paper',
        borderRadius: 1,
        p: 1.25,
        minWidth: 0,
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      {step ? (
        <Stack spacing={0.75} sx={{ mt: 0.25 }}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <StepIcon status={liveStepIconStatus(step.status)} />
            <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {step.number}. {step.name}
            </Typography>
          </Stack>
          <Typography variant="caption" color={liveStepTextColor(step.status)}>
            {liveStepLabel(step.status, active)}
          </Typography>
          {(step.measured !== undefined || step.error) && (
            <Typography variant="caption" color={step.status === 'fail' ? 'error.main' : 'text.secondary'} sx={{ display: 'block', overflowWrap: 'anywhere' }}>
              {step.error ?? compactInlineValue(step.measured)}
            </Typography>
          )}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {fallback}
        </Typography>
      )}
    </Box>
  )
}

function AxisSummaryPanel({ summary }: { summary: LinearStageSummary | null }) {
  if (!summary?.axes.length) return null

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 1.25 }}>
      {summary.axes.map((axis) => (
        <Box key={axis.axis} sx={{ border: '1px solid', borderColor: axis.passed ? 'success.light' : axis.warned ? 'warning.light' : 'error.light', borderRadius: 1, p: 1.25 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle2">{axis.axis} axis</Typography>
            {axis.passed ? <CheckCircleIcon color="success" fontSize="small" /> : axis.warned ? <WarningAmberIcon color="warning" fontSize="small" /> : <ErrorOutlineIcon color="error" fontSize="small" />}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {axis.total} checks, {axis.failed} failed, {axis.warned} warning
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {axis.metrics.slice(0, 4).map((metric) => (
              <DetailRow key={metric.id} label={shortMetricLabel(metric.label)} value={`${formatNumber(metric.value, 3)}${metric.unit ? ` ${metric.unit}` : ''}`} />
            ))}
          </Stack>
        </Box>
      ))}
    </Box>
  )
}

function MetricHistogramPanel({ summary }: { summary: LinearStageSummary | null }) {
  if (!summary?.metrics.length) return null

  const groups = [
    { title: 'Travel position and span', metrics: summary.metrics.filter((metric) => /span|position/i.test(metric.label)) },
    { title: 'Repeatability and delta', metrics: summary.metrics.filter((metric) => /repeatability|delta/i.test(metric.label)) },
    { title: 'Optical response', metrics: summary.metrics.filter((metric) => /shift|response|focus|conflict|texture/i.test(metric.label)) },
    { title: 'Power and current', metrics: summary.metrics.filter((metric) => /voltage|current|derating/i.test(metric.label)) },
  ].filter((group) => group.metrics.length)

  return (
    <Accordion disableGutters defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2">Measurement histograms</Typography>
          <InlineInfoIcon title="Bars show numeric values from the firmware result. Green is used only when explicit firmware bounds are available and the value is inside those bounds. Target-only and direction-only markers are shown neutrally." />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
          {groups.map((group) => (
            <MetricHistogram key={group.title} title={group.title} metrics={group.metrics.slice(0, 12)} />
          ))}
        </Box>
      </AccordionDetails>
    </Accordion>
  )
}

function MetricHistogram({ title, metrics }: { title: string; metrics: NumericMetric[] }) {
  const values = metrics.map((metric) => metric.value)
  const thresholdValues = metrics.flatMap((metric) => [metric.threshold?.min, metric.threshold?.max, metric.threshold?.target].filter(isFiniteNumber))
  const min = Math.min(...values, ...thresholdValues)
  const max = Math.max(...values, ...thresholdValues)
  const spread = Math.max(max - min, 0.001)

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Stack spacing={0.75}>
        {metrics.map((metric) => {
          const pct = clamp(((metric.value - min) / spread) * 100, 0, 100)
          const threshold = metric.threshold
          return (
            <Box key={metric.id}>
              <Stack direction="row" justifyContent="space-between" spacing={1}>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {metric.axis ? `${metric.axis} ` : ''}{shortMetricLabel(metric.label)}
                </Typography>
                <Typography variant="caption">
                  {formatNumber(metric.value, 3)}{metric.unit ? ` ${metric.unit}` : ''}
                </Typography>
              </Stack>
              <Box sx={{ position: 'relative', height: 16, bgcolor: 'grey.100', borderRadius: 0.75, overflow: 'hidden' }}>
                <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, bgcolor: metricBarColor(metric) }} />
                {threshold?.min !== undefined && <ThresholdMarker value={threshold.min} min={min} spread={spread} color="warning.dark" />}
                {threshold?.max !== undefined && <ThresholdMarker value={threshold.max} min={min} spread={spread} color="warning.dark" />}
                {threshold?.target !== undefined && <ThresholdMarker value={threshold.target} min={min} spread={spread} color="primary.dark" />}
              </Box>
              {threshold && (
                <Typography variant="caption" color="text.secondary">
                  {threshold.label}
                </Typography>
              )}
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}

function ThresholdMarker({ value, min, spread, color }: { value: number; min: number; spread: number; color: string }) {
  const left = clamp(((value - min) / spread) * 100, 0, 100)
  return <Box sx={{ position: 'absolute', left: `${left}%`, top: 0, bottom: 0, width: 2, bgcolor: color }} />
}

function StepResultTable({ summary }: { summary: LinearStageSummary | null }) {
  if (!summary?.steps.length) return null
  return (
    <Accordion disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Full step results</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 960 }}>
            <TableHead>
              <TableRow>
                <TableCell>Step</TableCell>
                <TableCell>Result</TableCell>
                <TableCell>Measured</TableCell>
                <TableCell>Expected</TableCell>
                <TableCell>Error</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {summary.steps.map((step) => (
                <TableRow key={step.id}>
                  <TableCell>{step.name}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <StepIcon status={step.result === 'Pass' ? 'complete' : step.result === 'Warn' ? 'warning' : step.result === 'Fail' ? 'failed' : 'pending'} />
                      <Typography variant="body2">{step.result}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 330 }}>
                    <CompactJson value={step.measured} />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 300 }}>
                    <CompactJson value={step.expected} />
                  </TableCell>
                  <TableCell>{step.error ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </AccordionDetails>
    </Accordion>
  )
}

function CompactJson({ value }: { value: unknown }) {
  const text = value === undefined ? '-' : typeof value === 'string' ? value : JSON.stringify(value)
  return (
    <Typography variant="caption" component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {text}
    </Typography>
  )
}

function LinearHistoryPanel(props: {
  records: HistoricalRecords
  rawRecords: HistoricalRecords
  storageSummary: StorageSummary | null
  offset: number
  limit: number
  textFilter: string
  runFilter: string
  activeRunId: string
  onTextFilterChange: (value: string) => void
  onRunFilterChange: (value: string) => void
  onPage: (offset: number) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const sections = [
    { title: `Mirrored events (${props.records.events.length})`, empty: 'No mirrored linear-stage events stored yet.', records: props.records.events },
    { title: `Command responses (${props.records.responses.length})`, empty: 'No linear-stage command responses stored yet.', records: props.records.responses },
    { title: `Commands (${props.records.commands.length})`, empty: 'No linear-stage commands stored yet.', records: props.records.commands },
    { title: `Overrides (${props.records.overrides.length})`, empty: 'No overrides stored yet.', records: props.records.overrides },
  ]
  const hasNext =
    props.rawRecords.events.length >= props.limit ||
    props.rawRecords.responses.length >= props.limit ||
    props.rawRecords.commands.length >= props.limit ||
    props.rawRecords.overrides.length >= props.limit

  return (
    <Accordion disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">Historical records</Typography>
          <Chip size="small" label={`${props.records.events.length} events`} />
          <Chip size="small" label={`${props.records.responses.length} responses`} />
          <Chip size="small" label={`${props.records.commands.length} commands`} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
            <Button size="small" startIcon={<RefreshIcon />} onClick={props.onRefresh}>
              Refresh records
            </Button>
            <TextField
              size="small"
              label="Filter records"
              value={props.textFilter}
              onChange={(event) => props.onTextFilterChange(event.target.value)}
              sx={{ minWidth: { xs: 0, md: 260 }, width: { xs: '100%', md: 'auto' } }}
            />
            <TextField
              size="small"
              label="Run ID"
              value={props.runFilter}
              onChange={(event) => props.onRunFilterChange(event.target.value)}
              sx={{ minWidth: { xs: 0, md: 220 }, width: { xs: '100%', md: 'auto' } }}
            />
            {props.activeRunId && (
              <Button size="small" onClick={() => props.onRunFilterChange(props.activeRunId)}>
                Current run
              </Button>
            )}
            {props.runFilter && (
              <Button size="small" onClick={() => props.onRunFilterChange('')}>
                Clear run
              </Button>
            )}
            <Button size="small" disabled={props.offset === 0} onClick={() => props.onPage(props.offset - props.limit)}>
              Previous
            </Button>
            <Button size="small" disabled={!hasNext} onClick={() => props.onPage(props.offset + props.limit)}>
              Next
            </Button>
            <Typography variant="caption" color="text.secondary">
              Showing page {Math.floor(props.offset / props.limit) + 1}. Full local retention remains in SQLite and JSONL: {props.storageSummary?.jsonlPath ?? 'not loaded'}.
            </Typography>
          </Stack>

          {sections.map((section) => (
            <Accordion key={section.title} disableGutters>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="body2">{section.title}</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <LogBlock
                  lines={section.records.map((record) => JSON.stringify(record, null, 2))}
                  empty={section.empty}
                  maxHeight={360}
                />
              </AccordionDetails>
            </Accordion>
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
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
  summary: LinearStageSummary | null
  storageSummary: StorageSummary | null
  command: string
  onCommandChange: (value: string) => void
  commandValid: boolean
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
      <Box sx={{ width: { xs: '100vw', sm: 560 }, maxWidth: '100vw', p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h6">Engineering</Typography>
            <Typography color="text.secondary" variant="body2">
              Protected diagnostics within Linear Stage.
            </Typography>
          </Box>
          <IconButton aria-label="Close engineering" onClick={props.onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>

        <EngineeringSection title="Run command">
          <Stack spacing={1.5}>
            <TextField
              label="Firmware command"
              size="small"
              value={props.command}
              error={!props.commandValid}
              onChange={(event) => props.onCommandChange(event.target.value)}
              helperText={props.commandValid
                ? 'Operator flow uses suite-runner start commands so firmware publishes session, suite, test, and step payloads.'
                : 'Select one of the suite-runner linear-stage commands below.'}
            />
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {LINEAR_STAGE_MODE_ORDER.map((mode) => {
                const command = commandForLinearStageMode(mode)
                return (
                <Button key={mode} size="small" variant={props.command === command ? 'contained' : 'outlined'} onClick={() => props.onCommandChange(command)}>
                  {LINEAR_STAGE_MODE_CONFIGS[mode].shortLabel}
                </Button>
                )
              })}
            </Stack>
          </Stack>
        </EngineeringSection>

        <EngineeringSection title="Raw serial console">
          <LogBlock lines={props.rawLines} empty="No serial lines captured." />
        </EngineeringSection>

        <EngineeringSection title="Mirrored event stream">
          <LogBlock lines={props.events.map((event) => `${event.event_name} ${JSON.stringify(event.data)}`)} empty="No mirrored events captured." />
        </EngineeringSection>

        <EngineeringSection title="Last result payload">
          <LogBlock lines={props.summary ? [JSON.stringify(props.summary.raw, null, 2)] : []} empty="No linear-stage result captured." />
        </EngineeringSection>

        <EngineeringSection title="Local payload storage">
          <Stack spacing={1}>
            <DetailRow label="SQLite" value={props.storageSummary?.databasePath ?? 'Not loaded'} />
            <DetailRow label="JSONL" value={props.storageSummary?.jsonlPath ?? 'Not loaded'} />
            <DetailRow label="Events" value={String(props.storageSummary?.eventCount ?? 0)} />
            <DetailRow label="Commands" value={String(props.storageSummary?.commandCount ?? 0)} />
            <DetailRow label="Responses" value={String(props.storageSummary?.responseCount ?? 0)} />
            <DetailRow label="Overrides" value={String(props.storageSummary?.overrideCount ?? 0)} />
          </Stack>
        </EngineeringSection>

        <EngineeringSection title="Overrides">
          <Stack spacing={1.5}>
            <FormControl size="small" fullWidth>
              <InputLabel>Action</InputLabel>
              <Select label="Action" value={props.overrideAction} onChange={(event) => props.setOverrideAction(event.target.value)}>
                <MenuItem value="Repeat linear-stage test">Repeat linear-stage test</MenuItem>
                <MenuItem value="Accept engineering review">Accept engineering review</MenuItem>
                <MenuItem value="Record station hardware issue">Record station hardware issue</MenuItem>
                <MenuItem value="Cancel run">Cancel run</MenuItem>
              </Select>
            </FormControl>
            <TextField label="Reason" multiline minRows={3} value={props.overrideReason} onChange={(event) => props.setOverrideReason(event.target.value)} />
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
    <Accordion disableGutters defaultExpanded={title === 'Run command'}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  )
}

function LogBlock({ lines, empty, maxHeight = 260 }: { lines: string[]; empty: string; maxHeight?: number }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        minHeight: 160,
        maxHeight,
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

function buildProgressSteps(current: LinearWorkflowStep, status?: LinearRunStatus) {
  const currentIndex = LINEAR_FLOW_STEPS.findIndex((step) => step.id === current)
  return LINEAR_FLOW_STEPS.map((step, index) => {
    if (current === 'review' && step.id === 'run' && status === 'fail') {
      return { ...step, status: 'failed' as const }
    }
    if (current === 'review' && step.id === 'run' && status === 'warn') {
      return { ...step, status: 'warning' as const }
    }
    if (index < currentIndex) {
      return { ...step, status: 'complete' as const }
    }
    if (index === currentIndex) {
      return { ...step, status: 'active' as const }
    }
    return { ...step, status: 'pending' as const }
  })
}

function buildInitialLiveLinearStageRun(runId: string, command: string, mode: LinearStageMode): LiveLinearStageRun {
  return {
    runId,
    command,
    mode,
    startedAt: new Date().toISOString(),
    active: true,
    steps: plannedStepsForLinearStageMode(mode).map((name, index) => ({
      number: index + 1,
      name,
      status: 'pending',
      source: 'planned',
    })),
    metadata: [`Command: ${command}`, 'Waiting for first firmware phase.'],
    artifacts: [],
  }
}

function applyLiveLinearStageUpdate(current: LiveLinearStageRun | null, update: LiveLinearStageUpdate): LiveLinearStageRun | null {
  if (!current) return current
  if (update.mode && update.mode !== current.mode) return current
  if (update.runId && isLocalLinearStageRunId(update.runId) && update.runId !== current.runId) return current
  const firmwareRunId = update.runId && !isLocalLinearStageRunId(update.runId) ? update.runId : current.firmwareRunId
  const artifacts = mergeArtifactLines(current.artifacts, update.artifacts)

  const now = new Date().toISOString()
  if (update.kind === 'metadata') {
    return {
      ...current,
      firmwareRunId,
      lastLine: update.raw,
      artifacts,
      metadata: [update.message, ...current.metadata.filter((line) => line !== update.message)].slice(0, 30),
    }
  }

  if (update.kind === 'overall') {
    return {
      ...current,
      firmwareRunId,
      active: false,
      overallStatus: update.status,
      lastLine: update.raw,
      artifacts,
      metadata: [`Overall result: ${statusLabel(update.status)}`, ...current.metadata].slice(0, 30),
    }
  }

  const updateNumber = liveUpdateStepNumber(current, update)
  const steps = ensureLiveStep(current.steps, updateNumber, update.name ?? `Step ${updateNumber}`)
  const nextSteps = steps.map((step) => {
    if (step.number !== updateNumber) {
      if (update.kind === 'start' && step.status === 'running') {
        return { ...step, status: 'pending' as const }
      }
      return step
    }

    if (update.kind === 'start') {
      return {
        ...step,
        name: update.name,
        status: 'running' as const,
        expected: update.expected ?? step.expected,
        raw: update.raw,
        source: update.source,
        startedAt: step.startedAt ?? now,
      }
    }

    return {
      ...step,
      name: update.name ?? step.name,
      status: liveStatusFromStepResult(update.result),
      expected: update.expected ?? step.expected,
      measured: update.measured ?? step.measured,
      error: update.error,
      raw: update.raw,
      source: update.source,
      completedAt: now,
    }
  })

  const metadata = update.kind === 'result'
    ? [`${updateNumber}. ${update.name ?? nextSteps.find((step) => step.number === updateNumber)?.name ?? 'Step'}: ${update.result}${update.error ? ` - ${update.error}` : ''}`, ...current.metadata]
    : [`Started ${updateNumber}. ${update.name}`, ...current.metadata]

  return {
    ...current,
    firmwareRunId,
    steps: nextSteps,
    currentStepNumber: update.kind === 'start' ? updateNumber : current.currentStepNumber,
    lastLine: update.raw,
    artifacts,
    metadata: metadata.slice(0, 30),
  }
}

function liveUpdateStepNumber(current: LiveLinearStageRun, update: Extract<LiveLinearStageUpdate, { kind: 'start' } | { kind: 'result' }>): number {
  if (update.kind === 'start' || (update.kind === 'result' && update.name)) {
    return knownPlannedStepNumberForLinearStageMode(update.name, update.mode ?? current.mode) ?? update.number
  }

  if (update.kind === 'result' && current.currentStepNumber !== undefined) {
    const runningStep = current.steps.find((step) => step.number === current.currentStepNumber)
    if (runningStep?.status === 'running') {
      return current.currentStepNumber
    }
  }

  return update.number
}

function ensureLiveStep(steps: LiveLinearStageStep[], number: number, name: string): LiveLinearStageStep[] {
  if (steps.some((step) => step.number === number)) {
    return steps
  }
  const newStep: LiveLinearStageStep = {
    number,
    name,
    status: 'pending',
    source: 'serial',
  }
  return [
    ...steps,
    newStep,
  ].sort((left, right) => left.number - right.number)
}

function markLiveRunCommandError(current: LiveLinearStageRun | null, message?: string): LiveLinearStageRun | null {
  if (!current) return current
  const cleanMessage = message?.trim() || 'The firmware command ended before a final result was captured.'
  return {
    ...current,
    active: false,
    overallStatus: 'fail',
    metadata: [cleanMessage, ...current.metadata].slice(0, 30),
  }
}

function summarizeLiveLinearStageRun(current: LiveLinearStageRun | null, runId: string, command: string, mode: LinearStageMode): LinearStageSummary {
  const liveSteps = current?.steps.filter((step) => step.status !== 'pending' || step.expected !== undefined || step.measured !== undefined || step.error) ?? []
  const steps = liveSteps.map((step): LinearStageStep => ({
    id: `${runId}-live-${step.number}`,
    number: step.number,
    name: step.name,
    result: liveStepResultToFinal(step.status),
    expected: step.expected,
    measured: step.measured,
    error: step.error,
  }))
  const metrics = extractNumericMetrics(steps)
  const raw = {
    live_trace: true,
    metadata: current?.metadata ?? [],
    artifacts: current?.artifacts ?? [],
    last_line: current?.lastLine,
  }
  const evidence = extractLinearStageEvidence(raw, steps, current?.mode ?? mode)
  const status = evidence.issues.length ? 'fail' : current?.overallStatus ?? statusFromResult(undefined, steps)
  return {
    runId,
    command,
    mode: current?.mode ?? mode,
    testName: `LINEAR_STAGE_${(current?.mode ?? mode).toUpperCase()}_TEST`,
    status,
    steps,
    axes: buildAxisSummaries(steps, metrics),
    metrics,
    evidence,
    raw,
  }
}

function liveRunFromSummary(summary: LinearStageSummary, previous: LiveLinearStageRun | null): LiveLinearStageRun {
  const mode = summary.mode ?? previous?.mode ?? 'production_full'
  const completedAt = new Date().toISOString()
  return {
    runId: summary.runId,
    command: summary.command,
    mode,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    active: false,
    overallStatus: summary.status,
    metadata: [`Final result: ${statusLabel(summary.status)}`, ...(previous?.metadata ?? [])].slice(0, 30),
    artifacts: mergeArtifactLines(previous?.artifacts ?? [], extractArtifactLines(asRecord(summary.raw).artifacts)),
    steps: mergeSummaryStepsIntoLiveTrace(summary.steps, previous, mode, completedAt),
  }
}

function mergeSummaryStepsIntoLiveTrace(
  summarySteps: LinearStageStep[],
  previous: LiveLinearStageRun | null,
  mode: LinearStageMode,
  completedAt: string,
): LiveLinearStageStep[] {
  const baseSteps = previous?.steps.length
    ? previous.steps
    : plannedStepsForLinearStageMode(mode).map((name, index): LiveLinearStageStep => ({
        number: index + 1,
        name,
        status: 'pending',
        source: 'planned',
      }))
  const summaryByName = new Map<string, LinearStageStep>()
  for (const step of summarySteps) {
    summaryByName.set(normalizeStepNameKey(step.name), step)
  }
  const consumed = new Set<LinearStageStep>()
  const merged = baseSteps.map((baseStep): LiveLinearStageStep => {
    const summaryStep = summaryByName.get(normalizeStepNameKey(baseStep.name))
    if (!summaryStep) {
      return {
        ...baseStep,
        status: baseStep.status === 'running' ? 'pending' : baseStep.status,
      }
    }
    consumed.add(summaryStep)
    return {
      ...baseStep,
      status: liveStatusFromStepResult(summaryStep.result),
      expected: summaryStep.expected ?? baseStep.expected,
      measured: summaryStep.measured ?? baseStep.measured,
      error: summaryStep.error,
      source: 'serial',
      completedAt,
    }
  })

  for (const step of summarySteps) {
    if (consumed.has(step)) continue
    merged.push({
      number: step.number,
      name: step.name,
      status: liveStatusFromStepResult(step.result),
      expected: step.expected,
      measured: step.measured,
      error: step.error,
      source: 'serial',
      completedAt,
    })
  }

  return merged.sort((left, right) => left.number - right.number)
}

function normalizeStepNameKey(name: string): string {
  return stripStepNumber(name).trim().toLowerCase()
}

function summarizeLinearStageResult(result: unknown, runId: string, command: string, fallbackMode: LinearStageMode): LinearStageSummary {
  const root = asRecord(result)
  const mode = normalizeLinearStageMode(root.mode ?? root.Mode ?? root.linear_stage_mode ?? root.LinearStageMode) ?? modeForLinearStageCommand(command) ?? fallbackMode
  const detail = asRecord(root.Detail ?? root.detail)
  const steps = Object.entries(detail).map(([stepName, value], index): LinearStageStep => {
    const record = asRecord(value)
    return {
      id: `${runId}-${index}`,
      number: parseStepNumber(stepName, index + 1),
      name: stripStepNumber(stepName),
      result: parseStepResult(record.Result ?? record.result),
      expected: record.Expected ?? record.expected,
      measured: record.Measured ?? record.measured,
      error: asString(record.Error ?? record.error),
    }
  })

  const resultCode = asNumber(root.Result ?? root.result)
  const metrics = extractNumericMetrics(steps)
  const evidence = extractLinearStageEvidence(result, steps, mode)
  const status = evidence.issues.length ? 'fail' : statusFromResult(resultCode, steps)
  return {
    runId,
    command,
    mode,
    testName: asString(root.Name ?? root.name ?? root.test_name) ?? 'LINEAR_STAGE_COMPREHENSIVE',
    status,
    resultCode,
    profile: asString(root.Profile ?? root.profile),
    steps,
    axes: buildAxisSummaries(steps, metrics),
    metrics,
    evidence,
    raw: result,
  }
}

function summarizeOmittedLinearStageResult(response: { message?: string; result_json_bytes?: number }, runId: string, command: string, mode: LinearStageMode): LinearStageSummary {
  const size = response.result_json_bytes ? `${response.result_json_bytes} bytes` : 'unknown size'
  return summarizeLinearStageResult(
    {
      Name: 'LINEAR_STAGE_COMPREHENSIVE',
      Result: 3,
      Detail: {
        '1 | Full result payload capture': {
          Result: 'Fail',
          Expected: 'Full firmware result captured after compact GUI response',
          Measured: `Compact response reported ${size}`,
          Error: response.message ?? 'Full legacy result did not arrive before the GUI fallback timeout.',
        },
      },
    },
    runId,
    command,
    mode,
  )
}

interface EvidenceField {
  key: string
  value: unknown
}

function extractLinearStageEvidence(raw: unknown, steps: LinearStageStep[], mode: LinearStageMode): LinearStageEvidence {
  const fields = [
    ...flattenEvidenceFields(raw),
    ...steps.flatMap((step) => flattenEvidenceFields({
      step_name: step.name,
      step_result: step.result,
      expected: step.expected,
      measured: step.measured,
      error: step.error,
    }, `step.${step.number}.${step.name}`)),
  ]
  const scanMode = mode === 'production_full'
  const issues: string[] = []

  const failedSteps = steps.filter((step) => step.result === 'Fail')
  for (const step of failedSteps.slice(0, 5)) {
    issues.push(`Step ${step.number} failed: ${step.name}${step.error ? ` - ${step.error}` : ''}`)
  }
  if (failedSteps.length > 5) {
    issues.push(`${failedSteps.length - 5} additional failed step${failedSteps.length === 6 ? '' : 's'} reported.`)
  }

  if (evidenceBoolean(fields, /(^|\.)overall_passed$/i) === false) {
    issues.push('Firmware final verdict reported overall_passed=false.')
  }
  if (evidenceBoolean(fields, /last_step_state_uncertain/i) === true) {
    issues.push('Firmware reported the final linear-stage state as uncertain.')
  }
  if (evidenceBoolean(fields, /last_step_safe_to_continue/i) === false) {
    issues.push('Firmware reported the final linear-stage state is not safe to continue.')
  }

  const scanCapturePassed = evidenceBoolean(fields, /scan_capture_passed/i)
  const artifactGenerationPassed = evidenceBoolean(fields, /artifact_generation_passed/i)
  const uploadRequested = evidenceBoolean(fields, /scan_artifact_upload_requested/i)
  const uploadSupported = evidenceBoolean(fields, /scan_artifact_upload_supported/i)
  const uploadAttempted = evidenceBoolean(fields, /scan_artifact_upload_attempted/i)
  const uploadPassed = evidenceBoolean(fields, /scan_artifact_upload_passed|(^|\.)upload_passed$/i)
  const uploadCompleted = evidenceBoolean(fields, /scan_artifact_upload_completed/i)
  const uploadedSupportingFiles = evidenceBoolean(fields, /scan_artifact_uploaded_supporting_files/i)
  const imagesCaptured = evidenceNumber(fields, /scan_artifact_images_captured|scan_artifact_uploaded_images|images captured|frame count|tile count/i)
  const yPairCount = evidenceNumber(fields, /y pair count|y_adjacent|y adjacent/i)
  const zPairCount = evidenceNumber(fields, /z pair count|z_adjacent|z adjacent/i)
  const adjacentPairCount = evidenceNumber(fields, /adjacent[_\s-]*pair.*(?:count|overlays)|pair[_\s-]*overlay.*count/i)

  if (scanMode) {
    if (scanCapturePassed === false || (!hasPassingStep(steps, /scan capture/i) && imagesCaptured === undefined)) {
      issues.push('Scan capture evidence is missing or failed.')
    }
    if (imagesCaptured !== undefined && imagesCaptured < 9) {
      issues.push(`Scan capture recorded ${imagesCaptured} image${imagesCaptured === 1 ? '' : 's'}; expected 9 normal scan tiles.`)
    }
    if (artifactGenerationPassed === false || (!hasPassingStep(steps, /artifact generation/i) && artifactGenerationPassed !== true)) {
      issues.push('Artifact generation evidence is missing or failed.')
    }
    if (!evidenceValueIncludes(fields, /scan_overlap_all_tiles\.png/i)) {
      issues.push('Missing scan_overlap_all_tiles.png supporting artifact evidence.')
    }
    if (!evidenceValueIncludes(fields, /scan_overlap_adjacent_pairs\.png/i)) {
      issues.push('Missing scan_overlap_adjacent_pairs.png supporting artifact evidence.')
    }
    if (uploadedSupportingFiles === false) {
      issues.push('Supporting-file upload evidence reported false.')
    }
    if (uploadRequested !== true) {
      issues.push('Scan artifact upload was not explicitly requested.')
    }
    if (uploadSupported === false || uploadAttempted === false || uploadPassed === false || uploadCompleted === false || (!hasPassingStep(steps, /^upload$/i) && uploadPassed !== true)) {
      issues.push('Scan artifact upload evidence is missing or failed.')
    }
    if (imagesCaptured === undefined) {
      issues.push('Missing image-count evidence for the 9 normal scan tiles.')
    }
    if (!((yPairCount !== undefined && yPairCount >= 6 && zPairCount !== undefined && zPairCount >= 6) || (adjacentPairCount !== undefined && adjacentPairCount >= 12))) {
      issues.push('Missing adjacent-pair overlay evidence for 6 Y-adjacent and 6 Z-adjacent neighbors.')
    }
    if (!hasField(fields, /overlap_correlation|overlap_response|overlap_matched/i)) {
      issues.push('Missing optical overlap evidence from scan audit pair results.')
    }
  }

  for (const field of fields) {
    if (/scan_artifact_upload_error|audit error|scan audit error/i.test(field.key) && hasMeaningfulErrorValue(field.value)) {
      issues.push(`${evidenceLabel(field.key)}: ${compactInlineValue(field.value)}`)
    }
    if (/trackable.*passed|focus.*passed|y optical.*passed|z optical.*passed|structural.*passed|monotonic.*passed|overlap_matched/i.test(field.key) && evidenceBoolean([field], /.*/i) === false) {
      issues.push(`${evidenceLabel(field.key)} reported false.`)
    }
  }

  return {
    safety: collectEvidenceLines(fields, /overall_passed|last_step|safe_to_continue|state_uncertain|recovered_to_home|stop_reason|detection_source/i),
    scan: collectEvidenceLines(fields, /scan_capture|scan_audit|trackable|structural|monotonic|focus passed|optical passed|pair count|overlap|images captured|frame count|tile count/i),
    upload: collectEvidenceLines(fields, /scan_artifact_upload|uploaded|upload_passed|cloud_scan_id|supporting_files|images_captured/i),
    artifacts: collectArtifactEvidenceLines(raw, fields),
    errors: collectEvidenceLines(fields, /error/i).filter((line) => !/: $/.test(line)),
    issues: uniqueStrings(issues),
  }
}

function flattenEvidenceFields(value: unknown, prefix = 'root', depth = 0): EvidenceField[] {
  if (value === undefined || value === null || depth > 5) return []
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => flattenEvidenceFields(entry, `${prefix}.${index}`, depth + 1))
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => flattenEvidenceFields(entry, `${prefix}.${key}`, depth + 1))
  }
  return [{ key: prefix, value }]
}

function collectEvidenceLines(fields: EvidenceField[], keyPattern: RegExp, limit = 12): string[] {
  return uniqueStrings(
    fields
      .filter((field) => keyPattern.test(field.key))
      .map((field) => `${evidenceLabel(field.key)}: ${compactInlineValue(field.value)}`)
      .filter((line) => !/:\s*(undefined|null)?$/i.test(line)),
  ).slice(0, limit)
}

function collectArtifactEvidenceLines(raw: unknown, fields: EvidenceField[]): string[] {
  const rootArtifacts = extractArtifactLines(asRecord(raw).artifacts)
  const artifactFields = collectEvidenceLines(fields, /artifact|scan_path|scan_artifact_paths|supporting_files|cloud_scan_id|scan_overlap|uploaded_images/i, 16)
  const pathValues = fields
    .filter((field) => typeof field.value === 'string' && /scan_overlap|supporting_files|\.png|\.jpg|\.jpeg|scan/i.test(field.value))
    .map((field) => `${evidenceLabel(field.key)}: ${field.value}`)
  return uniqueStrings([...rootArtifacts, ...artifactFields, ...pathValues]).slice(0, 16)
}

function evidenceBoolean(fields: EvidenceField[], keyPattern: RegExp): boolean | undefined {
  for (const field of fields) {
    if (!keyPattern.test(field.key)) continue
    const parsed = parseEvidenceBoolean(field.value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function parseEvidenceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', 'pass', 'passed', 'ok', '1'].includes(normalized)) return true
  if (['false', 'fail', 'failed', 'error', '0'].includes(normalized)) return false
  return undefined
}

function evidenceNumber(fields: EvidenceField[], keyPattern: RegExp): number | undefined {
  for (const field of fields) {
    if (!keyPattern.test(field.key)) continue
    if (typeof field.value === 'number' && Number.isFinite(field.value)) return field.value
    if (typeof field.value === 'string') {
      const parsed = Number(field.value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function hasField(fields: EvidenceField[], keyPattern: RegExp): boolean {
  return fields.some((field) => keyPattern.test(field.key))
}

function evidenceValueIncludes(fields: EvidenceField[], valuePattern: RegExp): boolean {
  return fields.some((field) => typeof field.value === 'string' && valuePattern.test(field.value))
}

function hasPassingStep(steps: LinearStageStep[], stepPattern: RegExp): boolean {
  return steps.some((step) => stepPattern.test(step.name) && step.result === 'Pass')
}

function hasMeaningfulErrorValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value)
  if (!text) return false
  return !/^(none|null|undefined|ok|pass|passed|false)$/i.test(text)
}

function evidenceLabel(key: string): string {
  const parts = key.split('.').filter((part) => !/^(root|step|\d+|expected|measured|context|Detail|detail)$/i.test(part))
  return humanizeKey(parts.slice(-2).join(' ') || key)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function extractNumericMetrics(steps: LinearStageStep[]): NumericMetric[] {
  const metrics: NumericMetric[] = []
  steps.forEach((step) => {
    const measured = asRecord(step.measured)
    const expected = asRecord(step.expected)
    Object.entries(measured).forEach(([label, value]) => {
      const parsed = parseNumericValue(value)
      if (!parsed) return
      metrics.push({
        id: `${step.id}-${label}`,
        stepName: step.name,
        result: step.result,
        label,
        value: parsed.value,
        unit: parsed.unit,
        axis: axisFromStep(step.name),
        threshold: inferThreshold(label, expected),
      })
    })
  })
  return metrics
}

function buildAxisSummaries(steps: LinearStageStep[], metrics: NumericMetric[]): AxisSummary[] {
  return ['X', 'Y', 'Z'].map((axis) => {
    const axisSteps = steps.filter((step) => axisFromStep(step.name) === axis)
    const failed = axisSteps.filter((step) => step.result === 'Fail').length
    const warned = axisSteps.filter((step) => step.result === 'Warn').length
    return {
      axis,
      passed: axisSteps.length > 0 && failed === 0 && warned === 0,
      failed,
      warned,
      total: axisSteps.length,
      metrics: metrics.filter((metric) => metric.axis === axis),
    }
  }).filter((axis) => axis.total > 0)
}

function inferThreshold(label: string, expected: Record<string, unknown>): MetricThreshold | undefined {
  const expectedForLabel = expected[label]
  const parsedRange = typeof expectedForLabel === 'string' ? parseRange(expectedForLabel) : undefined
  if (parsedRange) return parsedRange

  if (/5V Aux Voltage/i.test(label)) return { min: 4.75, max: 5.25, kind: 'range', label: 'firmware range 4.75-5.25 V' }
  if (/24V Aux Voltage/i.test(label)) return { min: 23, max: 25, kind: 'range', label: 'firmware range 23-25 V' }
  if (/Measured span mm/i.test(label)) {
    const target = asNumber(expected['Expected span mm'])
    if (target !== undefined) return { target, kind: 'target', label: `expected ${formatNumber(target, 3)} mm` }
  }
  if (/Minimum response/i.test(label)) return { min: 0, kind: 'direction', label: 'higher is better' }
  if (/Delta mm/i.test(label)) return { target: 0, kind: 'target', label: 'target 0 mm delta' }
  if (/Repeatability mm/i.test(label)) return { min: 0, kind: 'direction', label: 'lower is better' }
  return undefined
}

function parseRange(value: string): MetricThreshold | undefined {
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/)
  if (!match) return undefined
  return {
    min: Number(match[1]),
    max: Number(match[2]),
    kind: 'range',
    label: `firmware range ${value}`,
  }
}

function readinessItemFromCheck(item: ReadinessItem, result: Record<string, unknown>, key: string, passDetail: string, failDetail: string): ReadinessItem {
  const check = result[`check_${key}`]
  if (check === 1 || check === true) {
    return { ...item, status: 'passed', detail: passDetail }
  }
  if (check === -1) {
    return { ...item, status: 'pending', detail: failDetail }
  }
  return { ...item, status: 'failed', detail: failDetail }
}

function normalizeLinearStageCommand(command: string): LinearStageCommand | undefined {
  const trimmed = command.trim()
  return modeForLinearStageCommand(trimmed) ? trimmed : undefined
}

function buildLinearStageSuiteSessionId(): number {
  return Math.trunc(Date.now() % 2_000_000_000) || 1
}

function isLinearStageEvent(event: GuiEventEnvelope): boolean {
  const text = `${event.event_name} ${JSON.stringify(event.data)}`.toLowerCase()
  return text.includes('linear_stage') || text.includes('linear stage') || text.includes('linear-stage')
}

function isLinearStageTerminalSuiteEvent(event: GuiEventEnvelope): boolean {
  const eventName = event.event_name.toLowerCase()
  if (!eventName.includes('suite_update') && !eventName.includes('session_update')) return false
  return parseEventStatus(event.data) !== undefined
}

function isLinearStageSuiteQueueAcknowledgement(result: unknown): boolean {
  const record = asRecord(result)
  return record.queued === true && typeof record.request === 'string'
}

function resultCodeFromStatus(status: LinearRunStatus): number {
  if (status === 'pass') return 1
  if (status === 'warn') return 2
  if (status === 'fail') return 3
  return 0
}

function parseLiveLinearStageSerialLine(line: string): LiveLinearStageUpdate | undefined {
  const startIndex = line.search(/\[>> ACTION: LINEAR_STAGE(?:_[A-Z]+)?_TEST/)
  if (startIndex !== -1) {
    const payload = line.slice(startIndex)
    const match = payload.match(/\[>> ACTION: LINEAR_STAGE(?:_[A-Z]+)?_TEST \| Step (\d+) \| Action: (.*?) \| Expected: (.*?)(?:\]$|$)/)
    if (match) {
      return {
        kind: 'start',
        number: Number(match[1]),
        name: match[2].trim(),
        expected: parseMaybeJsonDetail(match[3]),
        raw: line,
        source: 'serial',
      }
    }
  }

  const resultIndex = line.search(/\[<< RESULT: LINEAR_STAGE(?:_[A-Z]+)?_TEST/)
  if (resultIndex !== -1) {
    const payload = line.slice(resultIndex)
    const match = payload.match(/\[<< RESULT: LINEAR_STAGE(?:_[A-Z]+)?_TEST \| Step (\d+) \| (PASS|WARN|FAIL|ERROR) \| (.*?)(?:\]$|$)/)
    if (match) {
      const fields = parseLiveResultFields(match[3])
      return {
        kind: 'result',
        number: Number(match[1]),
        result: parseStepResult(match[2] === 'ERROR' ? 'Fail' : titleCase(match[2])),
        expected: fields.expected,
        measured: fields.measured,
        error: fields.error,
        raw: line,
        source: 'serial',
      }
    }
  }

  const overallMatch = line.match(/\[TEST: LINEAR_STAGE(?:_[A-Z]+)?_TEST\] \[OVERALL RESULT: (PASS|WARN|FAIL|ERROR)\]/)
  if (overallMatch) {
    return {
      kind: 'overall',
      status: overallMatch[1] === 'PASS' ? 'pass' : overallMatch[1] === 'WARN' ? 'warn' : 'fail',
      raw: line,
    }
  }

  if (/LINEAR_STAGE(?:_[A-Z]+)?_TEST|linear[-_ ]stage|CM4::SendQuery|Failed Steps/i.test(line)) {
    return {
      kind: 'metadata',
      message: cleanSerialMetadata(line),
      raw: line,
    }
  }

  return undefined
}

function parseLiveLinearStageEvent(event: GuiEventEnvelope, activeRun?: LiveLinearStageRun | null): LiveLinearStageUpdate | undefined {
  const data = event.data
  const eventName = event.event_name.toLowerCase()
  const context = asRecord(data.context)
  const stepName = asString(data.step_name) ?? asString(data.step) ?? asString(data.assert_name)
  const result = parseEventStepResult(data)
  const eventMode = normalizeLinearStageMode(data.linear_stage_mode ?? data.mode ?? data.session_type ?? context.linear_stage_mode ?? context.mode ?? context.session_type) ?? activeRun?.mode
  const eventRunId = asString(data.linear_stage_run_id) ?? asString(context.linear_stage_run_id) ?? asString(data.run_uid) ?? asString(context.run_uid)
  const artifacts = extractArtifactLines(data.artifacts ?? context.artifacts)
  if ((eventName.includes('step_result') || asString(data.evt_type) === 'STEP_RESULT') && stepName) {
    const number = plannedStepNumber(stepName, eventMode)
    return {
      kind: result === 'Unknown' ? 'start' : 'result',
      number,
      name: stepName,
      result,
      expected: data.expected ?? data.expected_value ?? data.exp_val ?? data.assertions,
      measured: data.measured ?? data.measured_value ?? data.meas_val ?? data.context,
      error: asString(data.error) ?? asString(data.error_message),
      raw: `${event.event_name}: ${JSON.stringify(data)}`,
      source: 'event',
      mode: eventMode,
      runId: eventRunId,
      artifacts,
    } as LiveLinearStageUpdate
  }

  if (eventName.includes('suite_update') || eventName.includes('session_update')) {
    const status = parseEventStatus(data)
    if (status) {
      return {
        kind: 'overall',
        status,
        raw: `${event.event_name}: ${JSON.stringify(data)}`,
        mode: eventMode,
        runId: eventRunId,
        artifacts,
      }
    }
  }

  return {
    kind: 'metadata',
    message: `${event.event_name}: ${stepName ?? asString(data.result) ?? asString(data.status) ?? 'linear-stage event'}`,
    raw: `${event.event_name}: ${JSON.stringify(data)}`,
    mode: eventMode,
    runId: eventRunId,
    artifacts,
  }
}

function parseLiveResultFields(body: string): { expected?: unknown; measured?: unknown; error?: string } {
  const expectedMarker = 'Expected: '
  const measuredMarker = ' | Measured: '
  const errorMarker = ' | Error: '
  const expectedStart = body.indexOf(expectedMarker)
  const measuredStart = body.indexOf(measuredMarker)
  const errorStart = body.indexOf(errorMarker)

  const expectedText = expectedStart !== -1 && measuredStart !== -1
    ? body.slice(expectedStart + expectedMarker.length, measuredStart)
    : undefined
  const measuredText = measuredStart !== -1
    ? body.slice(measuredStart + measuredMarker.length, errorStart === -1 ? undefined : errorStart)
    : undefined
  const errorText = errorStart !== -1 ? body.slice(errorStart + errorMarker.length).trim() : undefined

  return {
    expected: expectedText !== undefined ? parseMaybeJsonDetail(expectedText) : undefined,
    measured: measuredText !== undefined ? parseMaybeJsonDetail(measuredText) : undefined,
    error: errorText,
  }
}

function parseMaybeJsonDetail(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || trimmed.endsWith('~')) {
    return trimmed
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed
    }
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const numeric = Number(trimmed)
  return !Number.isNaN(numeric) && trimmed !== '' ? numeric : trimmed
}

function parseEventStepResult(data: Record<string, unknown>): LinearStepResult {
  const value = data.result ?? data.status ?? data.step_status ?? data.assert_result
  if (typeof value === 'boolean') return value ? 'Pass' : 'Fail'
  if (typeof value === 'number') return value === 1 ? 'Pass' : value === 2 ? 'Warn' : value === 3 ? 'Fail' : 'Unknown'
  if (typeof value !== 'string') return 'Unknown'
  const lower = value.toLowerCase()
  if (lower.includes('pass')) return 'Pass'
  if (lower.includes('warn')) return 'Warn'
  if (lower.includes('fail') || lower.includes('error')) return 'Fail'
  return 'Unknown'
}

function parseEventStatus(data: Record<string, unknown>): LinearRunStatus | undefined {
  const value = data.result ?? data.status ?? data.test_status ?? data.suite_status ?? data.suite_result ?? data.session_status
  if (typeof value === 'number') return value === 1 ? 'pass' : value === 2 ? 'warn' : value === 3 ? 'fail' : undefined
  if (typeof value !== 'string') return undefined
  const lower = value.toLowerCase()
  if (lower.includes('pass')) return 'pass'
  if (lower.includes('warn')) return 'warn'
  if (lower.includes('fail') || lower.includes('error')) return 'fail'
  return undefined
}

function liveActionText(update: LiveLinearStageUpdate): string {
  if (update.kind === 'start') return `Running step ${update.number}: ${update.name}.`
  if (update.kind === 'result') return `Step ${update.number} ${update.result}: ${update.name ?? 'linear-stage check'}.`
  if (update.kind === 'overall') return `Linear-stage overall result: ${statusLabel(update.status)}.`
  return update.message
}

function parseNumericValue(value: unknown): { value: number; unit?: string } | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return { value }
  if (typeof value !== 'string') return undefined
  const match = value.match(/-?\d+(?:\.\d+)?/)
  if (!match) return undefined
  const unitMatch = value.slice(match.index! + match[0].length).trim().match(/^[a-zA-Z/%]+/)
  return { value: Number(match[0]), unit: unitMatch?.[0] }
}

function parseStepResult(value: unknown): LinearStepResult {
  if (value === 'Pass') return 'Pass'
  if (value === 'Warn') return 'Warn'
  if (value === 'Fail') return 'Fail'
  return 'Unknown'
}

function statusFromResult(resultCode: number | undefined, steps: LinearStageStep[]): LinearRunStatus {
  if (resultCode === 1) return 'pass'
  if (resultCode === 2) return 'warn'
  if (resultCode === 3) return 'fail'
  if (steps.some((step) => step.result === 'Fail')) return 'fail'
  if (steps.some((step) => step.result === 'Warn')) return 'warn'
  if (steps.some((step) => step.result === 'Pass')) return 'pass'
  return 'waiting'
}

function parseStepNumber(name: string, fallback: number): number {
  const match = name.match(/^(\d+)\s*\|/)
  return match ? Number(match[1]) : fallback
}

function stripStepNumber(name: string): string {
  return name.replace(/^\d+\s*\|\s*/, '')
}

function axisFromStep(name: string): string | undefined {
  const match = name.match(/^([XYZ])\s/i)
  return match?.[1].toUpperCase()
}

function metricInThreshold(metric: NumericMetric): boolean {
  const threshold = metric.threshold
  if (!threshold || threshold.kind !== 'range') return false
  if (threshold.min !== undefined && metric.value < threshold.min) return false
  if (threshold.max !== undefined && metric.value > threshold.max) return false
  return true
}

function metricBarColor(metric: NumericMetric): string {
  if (metric.result === 'Fail') return 'error.light'
  if (metric.result === 'Warn') return 'warning.light'
  if (metric.threshold?.kind === 'range') {
    return metricInThreshold(metric) ? 'success.light' : 'warning.light'
  }
  return 'grey.300'
}

function readinessStatusText(item: ReadinessItem): string {
  if (item.status === 'running') return 'Checking now'
  if (item.status === 'passed') return item.detail ?? 'Ready'
  if (item.status === 'failed') return item.detail ?? 'Needs attention'
  return item.detail ?? 'Waiting'
}

function canonicalizeStationValue(key: keyof StationSettings, value: string): string {
  const trimmed = value.trim()
  if (key === 'defaultTesterDeviceSerial' || key === 'testerDeviceSerials') {
    return canonicalHardwareId(trimmed)
  }
  return trimmed
}

function statusLabel(status: LinearRunStatus): string {
  if (status === 'pass') return 'PASS'
  if (status === 'warn') return 'REVIEW'
  if (status === 'fail') return 'FAIL'
  if (status === 'running') return 'RUNNING'
  return 'Waiting'
}

function statusColor(status: LinearRunStatus): string {
  if (status === 'pass') return 'success.main'
  if (status === 'warn') return 'warning.main'
  if (status === 'fail') return 'error.main'
  if (status === 'running') return 'primary.main'
  return 'text.secondary'
}

function liveStatusFromStepResult(result: LinearStepResult): LiveLinearStageStepStatus {
  if (result === 'Pass') return 'pass'
  if (result === 'Warn') return 'warn'
  if (result === 'Fail') return 'fail'
  return 'pending'
}

function liveStepResultToFinal(status: LiveLinearStageStepStatus): LinearStepResult {
  if (status === 'pass') return 'Pass'
  if (status === 'warn') return 'Warn'
  if (status === 'fail') return 'Fail'
  return 'Unknown'
}

function liveStepIconStatus(status: LiveLinearStageStepStatus): 'pending' | 'active' | 'complete' | 'failed' | 'warning' {
  if (status === 'pass') return 'complete'
  if (status === 'warn') return 'warning'
  if (status === 'fail') return 'failed'
  if (status === 'running') return 'active'
  return 'pending'
}

function isLiveStepComplete(status: LiveLinearStageStepStatus): boolean {
  return status === 'pass' || status === 'warn' || status === 'fail'
}

function liveStepLabel(status: LiveLinearStageStepStatus, active = true): string {
  if (status === 'pass') return 'Pass'
  if (status === 'warn') return 'Warning'
  if (status === 'fail') return 'Fail'
  if (status === 'running') return 'Running now'
  return active ? 'Upcoming' : 'Not reported'
}

function liveStepTextColor(status: LiveLinearStageStepStatus): string {
  if (status === 'pass') return 'success.main'
  if (status === 'warn') return 'warning.main'
  if (status === 'fail') return 'error.main'
  if (status === 'running') return 'primary.main'
  return 'text.secondary'
}

function liveStepBorderColor(status: LiveLinearStageStepStatus): string {
  if (status === 'pass') return 'success.light'
  if (status === 'warn') return 'warning.light'
  if (status === 'fail') return 'error.light'
  if (status === 'running') return 'primary.light'
  return 'divider'
}

function liveStatusBorderColor(status: LinearRunStatus): string {
  if (status === 'pass') return 'success.light'
  if (status === 'warn') return 'warning.light'
  if (status === 'fail') return 'error.light'
  if (status === 'running') return 'primary.light'
  return 'divider'
}

function compactInlineValue(value: unknown): string {
  if (value === undefined) return '-'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 180 ? `${text.slice(0, 177)}...` : text
}

function isLocalLinearStageRunId(value: string): boolean {
  return value.startsWith('linear-')
}

function mergeArtifactLines(current: string[], next?: string[]): string[] {
  if (!next?.length) return current
  return Array.from(new Set([...next, ...current])).slice(0, 20)
}

function extractArtifactLines(value: unknown): string[] {
  const artifacts = asRecord(value)
  return Object.entries(artifacts)
    .flatMap(([key, entry]) => {
      if (entry === undefined || entry === null || entry === '') return []
      if (Array.isArray(entry)) {
        return entry.map((item) => `${humanizeKey(key)}: ${compactInlineValue(item)}`)
      }
      return [`${humanizeKey(key)}: ${compactInlineValue(entry)}`]
    })
    .filter(Boolean)
}

function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function plannedStepNumber(stepName: string, mode?: LinearStageMode): number {
  return plannedStepNumberForLinearStageMode(stepName, mode)
}

function cleanSerialMetadata(line: string): string {
  return line
    .replace(/^\d+\s+\[[^\]]+\]\s+\w+:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleCase(value: string): string {
  const lower = value.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function shortMetricLabel(label: string): string {
  return label
    .replace('Measured ', '')
    .replace('Expected ', '')
    .replace('Repeatability ', 'Repeat ')
    .replace('Stop position ', 'Stop pos. ')
    .replace('Minimum ', 'Min ')
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
