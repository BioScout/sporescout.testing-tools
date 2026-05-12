import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CloseIcon from '@mui/icons-material/Close'
import DownloadDoneIcon from '@mui/icons-material/DownloadDone'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyIcon from '@mui/icons-material/Key'
import LockIcon from '@mui/icons-material/Lock'
import LockOpenIcon from '@mui/icons-material/LockOpen'
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
  CARTRIDGE_READINESS_COMMAND,
  canonicalHardwareId,
  isEnclosureBaseId,
  isKnownOption,
  isNozzleId,
  isSealFixtureId,
  isTesterDeviceSerial,
  type ConnectionMode,
  type GuiEventEnvelope,
  type HistoricalRecords,
  type LocalRunContext,
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
import { appVersionStatusColor, appVersionStatusLabel, formatDisplayVersion } from '../../shared/appVersion'
import { parseSerialLine } from '../../shared/serialParser'
import {
  FLOW_STEPS,
  applyCartridgeReadinessResult,
  buildCartridgeOpenCommand,
  buildCartridgePhaseCommand,
  buildReadinessItems,
  deriveGuidanceFromMeasurements,
  extractGuidance,
  extractMeasurement,
  extractRunUid,
  isReadinessAutoRetryable,
  markAllReadinessItems,
  markReadinessItem,
  markReadinessCommandItemsRunning,
  progressLabel,
  type WorkflowStepId,
} from '../../shared/workflow'
import { getDefaultConnectionMode, getTestingToolsApi } from '../../services/testingToolsApi'
import {
  buildCartridgeHistoryRuns,
  cartridgeHistoryResult,
  filterCartridgeHistoryRuns,
  summarizeCartridgeHistory,
  type CartridgeHistoryResult,
  type CartridgeHistoryRun,
} from './cartridgeHistory'

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

type TestStage = 'idle' | 'running_open' | 'fit_nozzle' | 'running_nozzle' | 'fit_seal' | 'running_sealed' | 'complete'

type RunSnapshot = Required<Pick<
  LocalRunContext,
  'operator' | 'batch' | 'station_id' | 'tester_device_serial' | 'enclosure_base_id' | 'nozzle_id' | 'seal_fixture_id' | 'cartridge_serial'
>> & {
  run_uid?: string
  workflow: 'cartridge_subassembly'
  cartridge_phase: 'open' | 'nozzle' | 'sealed' | 'complete'
}

const api = getTestingToolsApi()
const HISTORY_PAGE_LIMIT = 10000

export function CartridgeSubassemblyPage() {
  const [settings, setSettings] = useState<StationSettings>(DEFAULT_STATION_SETTINGS)
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [portsLoading, setPortsLoading] = useState(false)
  const [portsError, setPortsError] = useState('')
  const [mode, setMode] = useState<ConnectionMode>(getDefaultConnectionMode())
  const [selectedPort, setSelectedPort] = useState('')
  const [connected, setConnected] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState('Disconnected')
  const [operator, setOperator] = useState('')
  const [batch, setBatch] = useState('')
  const [testerDeviceSerial, setTesterDeviceSerial] = useState(DEFAULT_STATION_SETTINGS.defaultTesterDeviceSerial)
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
  const [historicalRecords, setHistoricalRecords] = useState<HistoricalRecords>({
    commands: [],
    responses: [],
    events: [],
    overrides: [],
  })
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyRunUidFilter, setHistoryRunUidFilter] = useState('')
  const [historyCartridgeFilter, setHistoryCartridgeFilter] = useState('')
  const [solenoidLocked, setSolenoidLocked] = useState(false)
  const [testStage, setTestStage] = useState<TestStage>('idle')
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>({
    checked_at: '',
    status: 'idle',
    message: 'Update check has not run.',
  })
  const [appVersion, setAppVersion] = useState('')
  const progressTimer = useRef<number | undefined>()
  const unlockTimer = useRef<number | undefined>()
  const operationToken = useRef(0)
  const activeRunSnapshot = useRef<RunSnapshot | null>(null)
  const connectionAttemptInFlight = useRef(false)

  const cartridgeError = explainCartridgeSerial(cartridgeInput)
  const operatorValid = isKnownOption(operator, settings.operators)
  const batchValid = isKnownOption(batch, settings.batches)
  const testerSerialValid = isTesterDeviceSerial(testerDeviceSerial)
  const enclosureBaseValid = isEnclosureBaseId(settings.defaultEnclosureBaseId)
  const nozzleValid = isNozzleId(settings.defaultNozzleId)
  const sealValid = isSealFixtureId(settings.defaultSealFixtureId)
  const canStartTest =
    connected &&
    operatorValid &&
    batchValid &&
    testerSerialValid &&
    enclosureBaseValid &&
    nozzleValid &&
    sealValid &&
    solenoidLocked &&
    cartridgeSerial.length > 0 &&
    isValidCartridgeSerial(cartridgeSerial)

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

    void refreshSerialPorts({ preserveSelection: false, mounted: () => mounted })

    api.checkForUpdates().then((result) => {
      if (!mounted) return
      setUpdateResult(result)
    })

    api.getStorageSummary().then((summary) => {
      if (!mounted) return
      setStorageSummary(summary)
    })

    api.getHistoricalRecords({ limit: HISTORY_PAGE_LIMIT, offset: 0, workflow: 'cartridge_subassembly' }).then((records) => {
      if (!mounted) return
      setHistoricalRecords(records)
    })

    api.getActiveRunContext().then((context) => {
      if (!mounted || !context) return
      if (context.run_uid) setRunUid(context.run_uid)
      if (context.cartridge_serial) {
        setCartridgeSerial(context.cartridge_serial)
        setCartridgeInput(context.cartridge_serial)
      }
      if (context.operator) setOperator(context.operator)
      if (context.batch) setBatch(context.batch)
      if (context.tester_device_serial) setTesterDeviceSerial(context.tester_device_serial)
      if (context.run_uid) {
        activeRunSnapshot.current = context as RunSnapshot
        void api.setActiveRunContext(context)
        restoreRecoveredRun(context)
      }
    })

    const removeLineListener = api.onSerialLine((line) => {
      setRawLines((current) => [line, ...current].slice(0, 120))
      const parsed = parseSerialLine(line)
      if (parsed.kind === 'gui-response' && parsed.envelope?.type === 'response') {
        void refreshLocalRecords()
        setLatestAction(`${parsed.envelope.command}: ${parsed.envelope.ok ? 'ok' : 'failed'}`)
      }
    })

    const removeEventListener = api.onDeviceEvent((event) => {
      void refreshLocalRecords()
      setEvents((current) => [event, ...current].slice(0, 120))
      const measurement = extractMeasurement(event)
      if (measurement) {
        setMeasurements((current) => ({ ...current, [measurement.phase]: measurement }))
      }

      mergeGuidance(extractGuidance(event))
    })

    const removeConnectionListener = api.onConnectionStatus((status) => {
      setConnected(status.connected)
      if (!status.connected) {
        if (connectionAttemptInFlight.current) {
          setDeviceStatus('Connecting')
          return
        }
        invalidateOperation()
        setDeviceStatus('Disconnected')
        setSolenoidLocked(false)
        setTestStage('idle')
        const activeRunUid = activeRunSnapshot.current?.run_uid
        if (!activeRunUid) {
          activeRunSnapshot.current = null
          void api.setActiveRunContext(undefined)
          if (status.message) {
            setLatestAction(status.message)
          }
        } else {
          setLatestAction(`Connection lost with active run_uid ${activeRunUid}. Reconnect before continuing.`)
        }
      }
    })

    return () => {
      mounted = false
      removeLineListener()
      removeEventListener()
      removeConnectionListener()
      stopProgressTimer()
      stopUnlockTimer()
    }
    // Initial subscriptions must be registered once; handlers intentionally read current state through setters/refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const derived = deriveGuidanceFromMeasurements(measurements)
    if (!hasGuidanceData(derived)) return

    setGuidance((current) => ({
      guidance: current.guidance ?? derived.guidance,
      sealedOpenRatio: current.sealedOpenRatio ?? derived.sealedOpenRatio,
      sampleQuality: current.sampleQuality ?? derived.sampleQuality,
    }))
  }, [measurements])

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

  async function refreshLocalRecords(
    nextOffset = historyOffset,
    nextRunUidFilter = historyRunUidFilter,
    nextCartridgeFilter = historyCartridgeFilter,
  ) {
    const query = {
      limit: HISTORY_PAGE_LIMIT,
      offset: Math.max(0, nextOffset),
      workflow: 'cartridge_subassembly',
      runUid: nextRunUidFilter.trim() || undefined,
      cartridgeSerial: nextCartridgeFilter.trim() || undefined,
    }
    const [summary, records] = await Promise.all([api.getStorageSummary(), api.getHistoricalRecords(query)])
    setStorageSummary(summary)
    setHistoricalRecords(records)
    setHistoryOffset(query.offset)
  }

  async function loadHistoryPage(nextOffset: number) {
    await refreshLocalRecords(Math.max(0, nextOffset), historyRunUidFilter, historyCartridgeFilter)
  }

  function beginOperation(): number {
    operationToken.current += 1
    return operationToken.current
  }

  function invalidateOperation(): void {
    operationToken.current += 1
    stopProgressTimer()
  }

  function isCurrentOperation(token: number): boolean {
    return operationToken.current === token
  }

  async function refreshSerialPorts(options: { preserveSelection?: boolean; mounted?: () => boolean } = {}) {
    setPortsLoading(true)
    setPortsError('')
    try {
      const availablePorts = await api.listSerialPorts()
      if (options.mounted && !options.mounted()) return availablePorts
      setPorts(availablePorts)
      setSelectedPort((current) => {
        if (options.preserveSelection !== false && current.trim()) return current
        return availablePorts[0]?.path ?? current
      })
      if (availablePorts.length === 0) {
        setPortsError('No COM ports were reported. Type the COM name from Device Manager, for example COM8.')
      }
      return availablePorts
    } catch (error) {
      if (!options.mounted || options.mounted()) {
        setPorts([])
        setPortsError(error instanceof Error ? error.message : 'Could not list COM ports.')
      }
      return []
    } finally {
      if (!options.mounted || options.mounted()) {
        setPortsLoading(false)
      }
    }
  }

  async function connectTester() {
    const token = beginOperation()
    setFaultText('')
    setSolenoidLocked(false)
    setDeviceStatus('Connecting')
    setCurrentStep('connect')
    let portPath = selectedPort.trim()
    if (mode === 'serial' && !portPath) {
      const availablePorts = await refreshSerialPorts({ preserveSelection: false })
      if (!isCurrentOperation(token)) return
      portPath = availablePorts[0]?.path?.trim() ?? ''
      if (portPath) {
        setSelectedPort(portPath)
      }
    }
    if (mode === 'serial' && !portPath) {
      setDeviceStatus('Fault')
      setFaultText('Select or type the COM port shown in Device Manager, then connect again.')
      setLatestAction('No COM port is selected.')
      return
    }
    connectionAttemptInFlight.current = true
    const result = await api.connect({ mode, path: mode === 'serial' ? portPath : undefined })
    connectionAttemptInFlight.current = false
    if (!isCurrentOperation(token)) return

    if (!result.ok) {
      setDeviceStatus('Fault')
      setFaultText(result.error ?? 'Could not connect to tester.')
      return
    }

    setConnected(true)
    setDeviceStatus(mode === 'mock' ? 'Mock ready' : `Connected ${result.path}`)
    setCurrentStep('ready')
    await runReadiness(token)
  }

  async function runReadiness(token = beginOperation()) {
    const items = buildReadinessItems()
    setReadiness(items)
    setLatestAction('Running tester readiness checks.')
    setFaultText('')

    let result = await sendReadinessAttempt(items)
    if (!isCurrentOperation(token)) return
    const response = result.response
    if (!result.accepted || !response?.ok) {
      const failedItems = markAllReadinessItems(items, 'failed').map((item) => ({
        ...item,
        detail: response?.error ?? result.error ?? 'No response',
      }))
      setReadiness(failedItems)
      setFaultText('Tester readiness failed.')
      setDeviceStatus('Fault')
      return
    }

    const readinessResult = applyCartridgeReadinessResult(items, response.result)
    setReadiness(readinessResult.items)
    if (!readinessResult.ready) {
      if (isReadinessAutoRetryable(response.result)) {
        setDeviceStatus('Starting')
        setFaultText('')
        setLatestAction('Tester computer is starting. Readiness will retry automatically.')

        for (let attempt = 1; attempt <= 8; attempt += 1) {
          await delay(5000)
          if (!isCurrentOperation(token)) return
          setLatestAction(`Tester computer is starting. Rechecking readiness (${attempt}/8).`)
          result = await sendReadinessAttempt(readinessResult.items)
          if (!isCurrentOperation(token)) return
          if (!result.accepted || !result.response?.ok) {
            break
          }

          const retryReadiness = applyCartridgeReadinessResult(items, result.response.result)
          setReadiness(retryReadiness.items)
          if (retryReadiness.ready) {
            const solenoidAlreadyPassed = retryReadiness.items.find((item) => item.id === 'solenoid_locked')?.status === 'passed'
            setSolenoidLocked(solenoidAlreadyPassed)
            if (!solenoidAlreadyPassed) {
              const solenoidLocked = await runSolenoidLockCheck(retryReadiness.items)
              if (!isCurrentOperation(token)) return
              if (!solenoidLocked) return
            }
      setDeviceStatus('Ready')
      setCurrentStep('insert')
      setLatestAction('Tester ready. Insert cartridge and scan serial.')
      setFaultText('')
      return
          }
        }
      }

      setFaultText(readinessResult.operatorAction ?? 'Tester is not ready.')
      setDeviceStatus('Fault')
      return
    }

    const solenoidAlreadyPassed = readinessResult.items.find((item) => item.id === 'solenoid_locked')?.status === 'passed'
    setSolenoidLocked(solenoidAlreadyPassed)
    if (!solenoidAlreadyPassed) {
      const solenoidLocked = await runSolenoidLockCheck(readinessResult.items)
      if (!isCurrentOperation(token)) return
      if (!solenoidLocked) {
        return
      }
    }

    setDeviceStatus('Ready')
    setCurrentStep('insert')
    setLatestAction('Tester ready. Insert cartridge and scan serial.')
    setFaultText('')
  }

  async function sendReadinessAttempt(items: ReadinessItem[]) {
    setReadiness(markReadinessCommandItemsRunning(items))
    return await api.sendCommand(CARTRIDGE_READINESS_COMMAND)
  }

  async function runSolenoidLockCheck(items: ReadinessItem[]) {
    const runningItems = markReadinessItem(items, 'solenoid_locked', 'running', 'Checking lock state')
    setReadiness(runningItems)
    setLatestAction('Checking solenoid lock state.')

    const result = await api.sendCommand('solenoid IsUnlocked')
    const response = result.response
    const locked = result.accepted && !result.timedOut && response?.ok === true && response.result === false
    const failedDetail = response?.error ?? result.error ?? (response?.result === true ? 'Solenoid is unlocked' : 'No lock-state response')
    setSolenoidLocked(locked)

    setReadiness(
      markReadinessItem(
        runningItems,
        'solenoid_locked',
        locked ? 'passed' : 'failed',
        locked ? 'Locked' : failedDetail,
      ),
    )

    if (!locked) {
      setFaultText('Solenoid lock check failed. Lock the solenoid, then re-run readiness.')
      setDeviceStatus('Fault')
      setLatestAction('Solenoid lock state needs attention.')
      return false
    }

    return true
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

  function startValidationErrors(): string[] {
    const errors: string[] = []
    if (!connected) errors.push('tester is not connected')
    if (!operatorValid) errors.push(operator.trim() ? 'operator must be selected from the saved list' : 'operator is required')
    if (!batchValid) errors.push(batch.trim() ? 'batch must be selected from the saved list' : 'batch is required')
    if (!testerSerialValid) errors.push('tester serial must match SS-A-001-XXX-YYYY')
    if (!enclosureBaseValid) errors.push('enclosure base ID must match SS-P-001-XXX-YYYY')
    if (!nozzleValid) errors.push('nozzle ID must match NOZL-0001 format')
    if (!sealValid) errors.push('seal ID must match SEAL-0001 format')
    if (!solenoidLocked) errors.push('solenoid must be locked before inserting/testing')
    if (!cartridgeSerial || !isValidCartridgeSerial(cartridgeSerial)) errors.push('valid cartridge scan is required')
    return errors
  }

  function buildRunSnapshot(nextRunUid = runUid): RunSnapshot {
    return {
      operator: operator.trim(),
      batch: batch.trim(),
      station_id: settings.stationId,
      tester_device_serial: canonicalHardwareId(testerDeviceSerial),
      enclosure_base_id: canonicalHardwareId(settings.defaultEnclosureBaseId),
      nozzle_id: canonicalHardwareId(settings.defaultNozzleId),
      seal_fixture_id: canonicalHardwareId(settings.defaultSealFixtureId),
      cartridge_serial: cartridgeSerial.trim(),
      run_uid: nextRunUid.trim() || undefined,
      workflow: 'cartridge_subassembly',
      cartridge_phase: 'open',
    }
  }

  async function startTest() {
    if (!canStartTest) {
      setFaultText(`Cannot start: ${startValidationErrors().join(', ')}.`)
      return
    }

    const token = beginOperation()
    const snapshot = buildRunSnapshot()
    activeRunSnapshot.current = snapshot
    setFaultText('')
    setGuidance({})
    setMeasurements({})
    setCurrentStep('test')
    setTestStage('running_open')
    setDeviceStatus('Testing')
    await api.setActiveRunContext(snapshot)

    const openCommand = buildCartridgeOpenCommand(snapshot.cartridge_serial, snapshot.enclosure_base_id)
    const openResult = await runMeasurementPhase('open', openCommand, token)
    if (!isCurrentOperation(token)) return
    const firmwareRunUid = openResult.response ? extractRunUid(openResult.response) : undefined
    if (!firmwareRunUid) {
      activeRunSnapshot.current = null
      await api.setActiveRunContext(undefined)
      setFaultText('Open step did not return a firmware run_uid.')
      setDeviceStatus('Fault')
      return
    }
    setRunUid(firmwareRunUid)
    const runSnapshot = { ...snapshot, run_uid: firmwareRunUid, cartridge_phase: 'nozzle' as const }
    activeRunSnapshot.current = runSnapshot
    await api.setActiveRunContext(runSnapshot)

    setTestStage('fit_nozzle')
    setDeviceStatus('Fit nozzle')
    setLatestAction('Open measurement complete. Fit the nozzle, then continue.')
  }

  async function continueNozzleMeasurement() {
    const snapshot = activeRunSnapshot.current
    const firmwareRunUid = snapshot?.run_uid ?? runUid
    if (!snapshot || !firmwareRunUid) {
      setFaultText('No active run_uid is available. Restart from open after rerunning readiness.')
      setDeviceStatus('Fault')
      return
    }

    const token = beginOperation()
    setFaultText('')
    setCurrentStep('test')
    setDeviceStatus('Testing')
    setTestStage('running_nozzle')
    await api.setActiveRunContext({ ...snapshot, cartridge_phase: 'nozzle' })

    const nozzleCommand = buildCartridgePhaseCommand('nozzle', firmwareRunUid, snapshot.nozzle_id)
    const nozzleResult = await runMeasurementPhase('nozzle', nozzleCommand, token)
    if (!isCurrentOperation(token)) return
    if (!nozzleResult.response?.ok || nozzleResult.timedOut) {
      return
    }

    const sealedSnapshot = { ...snapshot, cartridge_phase: 'sealed' as const }
    activeRunSnapshot.current = sealedSnapshot
    await api.setActiveRunContext(sealedSnapshot)
    setTestStage('fit_seal')
    setDeviceStatus('Fit seal')
    setLatestAction('Nozzle measurement complete. Remove nozzle, seal the inlet, then continue.')
  }

  async function continueSealedMeasurement() {
    const snapshot = activeRunSnapshot.current
    const firmwareRunUid = snapshot?.run_uid ?? runUid
    if (!snapshot || !firmwareRunUid) {
      setFaultText('No active run_uid is available. Restart from open after rerunning readiness.')
      setDeviceStatus('Fault')
      return
    }

    const token = beginOperation()
    setFaultText('')
    setCurrentStep('test')
    setDeviceStatus('Testing')
    setTestStage('running_sealed')
    await api.setActiveRunContext({ ...snapshot, cartridge_phase: 'sealed' })

    const sealedCommand = buildCartridgePhaseCommand('sealed', firmwareRunUid, snapshot.seal_fixture_id)
    const sealedResult = await runMeasurementPhase('sealed', sealedCommand, token)
    if (!isCurrentOperation(token)) return
    if (!sealedResult.response?.ok || sealedResult.timedOut) {
      return
    }

    setLatestAction('Collecting final result summary.')
    const synced = await syncCurrentRunFromStorage(firmwareRunUid, token)
    if (!isCurrentOperation(token)) return
    if (!synced && !responseContainsSealedCompletion(sealedResult.response?.result)) {
      setFaultText('Final result payload was not recovered. Keep the cartridge installed and retry sync before removing.')
      setDeviceStatus('Fault')
      return
    }
    if (!synced) {
      setLatestAction('Final event mirror was not found yet; using the sealed command response for this local result.')
    }

    const responseGuidance = extractGuidance({ type: 'event', event_name: 'sealed_command_response', data: asRecord(sealedResult.response?.result) })
    const finalGuidance = responseGuidance.guidance ?? guidance.guidance
    activeRunSnapshot.current = { ...snapshot, cartridge_phase: 'complete' }
    await api.setActiveRunContext(activeRunSnapshot.current)
    setDeviceStatus('Remove cartridge')
    setCurrentStep('remove')
    setTestStage('complete')
    setLatestAction(requiresCartridgeRepeat(finalGuidance)
      ? cartridgeRepeatActionText(finalGuidance)
      : 'Testing complete. Remove cartridge and leave solenoid locked.')
  }

  async function runMeasurementPhase(phase: TestPhase, command: string, token: number) {
    startProgressTimer(phase)
    setLatestAction(`${phase} measurement running.`)
    const result = await api.sendCommand(command)
    if (!isCurrentOperation(token)) return result
    if (mode === 'mock') {
      await delay(500)
    }
    if (!isCurrentOperation(token)) return result
    stopProgressTimer()

    if (!result.accepted || result.timedOut || !result.response?.ok) {
      setFaultText(result.response?.error ?? result.error ?? `${phase} command failed.`)
      setDeviceStatus('Fault')
      if (phase === 'open') {
        activeRunSnapshot.current = null
        await api.setActiveRunContext(undefined)
        setCurrentStep('scan')
        setTestStage('idle')
        setLatestAction('Open measurement failed. Remove or reseat the cartridge, then scan it again to restart.')
      } else if (phase === 'nozzle') {
        setTestStage('fit_nozzle')
        setLatestAction('Nozzle measurement failed. Check the nozzle setup, then repeat the nozzle step or use engineering override.')
      } else if (phase === 'sealed') {
        setTestStage('fit_seal')
        setLatestAction('Sealed measurement failed. Reseat the seal, then repeat the sealed step or use engineering override.')
      }
    }

    if (result.response?.ok) {
      applyResponseMeasurement(phase, result.response.result)
      if (phase === 'sealed') {
        mergeGuidance(extractGuidance({ type: 'event', event_name: 'sealed_command_response', data: asRecord(result.response.result) }))
      }
    }

    return result
  }

  function applyResponseMeasurement(phase: TestPhase, responseResult: unknown) {
    const resultRecord = asRecord(responseResult)
    const phaseRecord = asRecord(resultRecord[phase])
    if (!Object.keys(phaseRecord).length) return

    const measurement = extractMeasurement({
      type: 'event',
      event_name: 'command_response_measurement',
      data: { phase, ...phaseRecord },
    })
    if (measurement) {
      setMeasurements((current) => ({ ...current, [measurement.phase]: measurement }))
    }
  }

  function mergeGuidance(next: GuidanceState) {
    if (!hasGuidanceData(next)) return
    setGuidance((current) => ({ ...current, ...next }))
  }

  async function syncCurrentRunFromStorage(targetRunUid: string, token?: number): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (token !== undefined && !isCurrentOperation(token)) return false
      const records = await api.getHistoricalRecords({ limit: HISTORY_PAGE_LIMIT, runUid: targetRunUid })
      if (token !== undefined && !isCurrentOperation(token)) return false
      setHistoricalRecords(records)
      const applied = applyStoredEventsForRun(records, targetRunUid)
      if (applied.hasSealedMeasurement && applied.hasGuidance && applied.hasSummaryEvent) {
        return true
      }

      await delay(500)
    }
    return false
  }

  function applyStoredEventsForRun(records: HistoricalRecords, targetRunUid: string) {
    const runEvents = records.events
      .filter((event) => storedEventBelongsToRun(event, targetRunUid))
      .slice()
      .reverse()

    const nextMeasurements: Record<string, MeasurementSummary> = {}
    let nextGuidance: GuidanceState = {}
    let hasSummaryEvent = false

    for (const event of runEvents) {
      const envelope: GuiEventEnvelope = {
        type: 'event',
        event_name: event.event_name,
        data: event.record.data,
      }

      const measurement = extractMeasurement(envelope)
      if (measurement) {
        nextMeasurements[measurement.phase] = measurement
      }

      const eventGuidance = extractGuidance(envelope)
      if (hasGuidanceData(eventGuidance)) {
        nextGuidance = { ...nextGuidance, ...eventGuidance }
      }

      if (event.event_name === 'dd_cartridge_air_leak_summary') {
        hasSummaryEvent = true
      }
    }

    if (Object.keys(nextMeasurements).length > 0) {
      setMeasurements((current) => ({ ...current, ...nextMeasurements }))
    }

    if (!hasGuidanceData(nextGuidance)) {
      nextGuidance = deriveGuidanceFromMeasurements(nextMeasurements)
    }

    if (hasGuidanceData(nextGuidance)) {
      mergeGuidance(nextGuidance)
    }

    return {
      hasSealedMeasurement: Boolean(nextMeasurements.sealed),
      hasGuidance: hasGuidanceData(nextGuidance),
      hasSummaryEvent,
    }
  }

  function restoreRecoveredRun(context: LocalRunContext) {
    if (context.workflow !== 'cartridge_subassembly' || !context.run_uid) {
      return
    }

    if (context.cartridge_phase === 'nozzle') {
      setCurrentStep('test')
      setTestStage('fit_nozzle')
      setDeviceStatus('Fit nozzle')
      setLatestAction(`Recovered active run_uid ${context.run_uid}. Fit the nozzle, then continue.`)
      return
    }

    if (context.cartridge_phase === 'sealed') {
      setCurrentStep('test')
      setTestStage('fit_seal')
      setDeviceStatus('Fit seal')
      setLatestAction(`Recovered active run_uid ${context.run_uid}. Fit the seal, then continue.`)
      return
    }

    if (context.cartridge_phase === 'complete') {
      setCurrentStep('remove')
      setTestStage('complete')
      setDeviceStatus('Remove cartridge')
      setLatestAction(`Recovered completed run_uid ${context.run_uid}. Remove the cartridge and lock the bay.`)
    }
  }

  async function unlockForRemoval() {
    setLatestAction('Unlock requested by operator.')
    const result = await api.unlockSolenoidForRemoval(45000)
    if (!result.accepted || result.timedOut || result.response?.ok !== true) {
      setFaultText(result.response?.error ?? result.error ?? 'Solenoid unlock failed.')
      setDeviceStatus('Fault')
      return
    }
    setSolenoidLocked(false)
    setLatestAction('Solenoid unlocked. The app will lock it again within 45 seconds.')
  }

  async function lockSolenoid(): Promise<boolean> {
    stopUnlockTimer()
    const lockResult = await api.sendCommand('solenoid Lock')
    if (!lockResult.accepted || lockResult.timedOut || lockResult.response?.ok !== true) {
      setSolenoidLocked(false)
      setFaultText(lockResult.response?.error ?? lockResult.error ?? 'Solenoid lock command failed.')
      setDeviceStatus('Fault')
      return false
    }

    const checkResult = await api.sendCommand('solenoid IsUnlocked')
    const locked = checkResult.accepted && !checkResult.timedOut && checkResult.response?.ok === true && checkResult.response.result === false
    setSolenoidLocked(locked)
    if (!locked) {
      setFaultText(checkResult.response?.error ?? checkResult.error ?? 'Solenoid did not report locked.')
      setDeviceStatus('Fault')
      setLatestAction('Solenoid lock verification failed.')
      return false
    }

    setLatestAction('Solenoid locked and verified.')
    return true
  }

  async function confirmRemoved() {
    const locked = await lockSolenoid()
    if (!locked) return
    await api.setActiveRunContext(undefined)
    activeRunSnapshot.current = null
    setTestStage('idle')
    setDeviceStatus('Ready')
    setCurrentStep('next')
    setLatestAction(requiresCartridgeRepeat(guidance.guidance)
      ? 'Cartridge removed. Reseat and repeat this cartridge before classifying it.'
      : 'Cartridge removed. Bay empty for next cartridge.')
  }

  function nextCartridge() {
    invalidateOperation()
    setCartridgeInput('')
    setCartridgeSerial('')
    setRunUid('')
    setGuidance({})
    setMeasurements({})
    setFaultText('')
    setTestStage('idle')
    void api.setActiveRunContext(undefined)
    activeRunSnapshot.current = null
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
    if (overrideAction !== 'Record station hardware issue' && !runUid && !cartridgeSerial) {
      setFaultText('Override requires an active run or scanned cartridge unless it is a station hardware issue.')
      return
    }
    if (overrideAction === 'Cancel run') {
      const cancelled = await cancelActiveRun()
      if (!cancelled) return
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

    try {
      await api.saveOverride(override)
      setOverrideReason('')
      setLatestAction(`Engineering override recorded: ${overrideAction}.`)
      await refreshLocalRecords()
    } catch (error) {
      setFaultText(error instanceof Error ? error.message : 'Engineering override could not be saved.')
    }
  }

  async function cancelActiveRun(): Promise<boolean> {
    if (!runUid) {
      setFaultText('No firmware run_uid is available to cancel.')
      return false
    }

    invalidateOperation()
    const result = await api.sendCommand(`test cartridge_leak cancel ${runUid}`)
    if (!result.accepted || result.timedOut || result.response?.ok !== true) {
      setFaultText(result.response?.error ?? result.error ?? 'Cancel command failed.')
      setDeviceStatus('Fault')
      return false
    }

    await api.setActiveRunContext(undefined)
    activeRunSnapshot.current = null
    setTestStage('idle')
    setDeviceStatus('Ready')
    setCurrentStep('insert')
    setLatestAction(`Cancelled run_uid ${runUid}.`)
    setRunUid('')
    return true
  }

  async function saveStationSettings(nextSettings: StationSettings) {
    const savedSettings = await api.saveSettings(nextSettings)
    setSettings(savedSettings)
  }

  async function commitSettingSelection(
    key: keyof StationSettings,
    listKey: keyof StationSettings,
    value: string,
  ) {
    const trimmed = canonicalizeStationValue(key, value)
    if (!trimmed) return
    const validationError = validateStationSettingValue(key, trimmed)
    if (validationError) {
      setFaultText(validationError)
      return
    }

    const currentList = settings[listKey]
    const nextList = Array.isArray(currentList) ? Array.from(new Set([...currentList, trimmed])) : [trimmed]
    const nextSettings = { ...settings, [key]: trimmed, [listKey]: nextList }
    await saveStationSettings(nextSettings)
  }

  async function addSettingOption(listKey: keyof StationSettings, value: string) {
    const trimmed = canonicalizeStationValue(listKey, value)
    if (!trimmed) return
    const validationError = validateStationOptionValue(listKey, trimmed)
    if (validationError) {
      setFaultText(validationError)
      return
    }

    const currentList = settings[listKey]
    const nextList = Array.isArray(currentList) ? Array.from(new Set([...currentList, trimmed])) : [trimmed]
    await saveStationSettings({ ...settings, [listKey]: nextList })
  }

  function updateTesterSerial(value: string) {
    setTesterDeviceSerial(value)
    void commitSettingSelection('defaultTesterDeviceSerial', 'testerDeviceSerials', value)
  }

  function updateBatch(value: string) {
    setBatch(value)
    void commitSettingSelection('latestBatch', 'batches', value)
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
        <Stack spacing={2}>
          <Box>
            <Typography variant="h5">SporeScout Cartridge Subassembly Tester</Typography>
            <Typography color="text.secondary" variant="body2">
              Operator-guided cartridge leak characterization.
            </Typography>
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                md: 'minmax(180px, 1fr) minmax(180px, 1fr)',
                xl: 'minmax(220px, 1fr) minmax(220px, 1fr) 150px minmax(260px, 1.25fr) auto auto',
              },
              gap: 1.5,
              alignItems: 'center',
            }}
          >
            <EditableConfigField
              label="Operator"
              value={operator}
              options={settings.operators}
              required
              error={!operatorValid}
              errorMessage={operator.trim() ? 'Press Enter to save this operator before testing.' : 'Operator is required.'}
              info="Required for every run. Select your name, or type a new name and press Enter."
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
              info="Batch is stored with every local payload. Type a new batch and press Enter to save it as the default."
              onValueChange={setBatch}
              onCommit={updateBatch}
            />

            <Tooltip title="Use Serial for a real tester over USB. Mock runs the UI workflow without hardware.">
              <FormControl size="small" fullWidth>
                <InputLabel>Mode</InputLabel>
                <Select label="Mode" value={mode} onChange={(event) => setMode(event.target.value as ConnectionMode)}>
                  <MenuItem value="mock">Mock</MenuItem>
                  <MenuItem value="serial">Serial</MenuItem>
                </Select>
              </FormControl>
            </Tooltip>

            <Stack direction="row" spacing={1} alignItems="flex-start">
              <Tooltip title="Select the USB serial connection for the tester, or type the COM port shown in Device Manager.">
                <TextField
                  size="small"
                  fullWidth
                  disabled={mode === 'mock'}
                  label="COM port"
                  value={selectedPort}
                  placeholder="COM8"
                  helperText={portsError || (ports.length ? `Detected: ${ports.map((port) => port.friendlyName ?? port.path).join(', ')}` : 'Type COM port if the list is blank.')}
                  error={Boolean(portsError) && mode === 'serial'}
                  onChange={(event) => setSelectedPort(event.target.value.toUpperCase())}
                  inputProps={{
                    list: 'cartridge-com-port-options',
                  }}
                />
              </Tooltip>
              <datalist id="cartridge-com-port-options">
                {ports.map((port) => (
                  <option key={port.path} value={port.path}>
                    {port.friendlyName ?? port.path}
                  </option>
                ))}
              </datalist>
              <Tooltip title="Refresh COM ports">
                <span>
                  <IconButton
                    aria-label="Refresh COM ports"
                    disabled={mode === 'mock' || portsLoading}
                    onClick={() => void refreshSerialPorts({ preserveSelection: true })}
                  >
                    <RefreshIcon />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>

            <Tooltip title="Connect tester and run readiness">
              <span>
                <Button variant="contained" startIcon={<UsbIcon />} onClick={connectTester} sx={{ width: '100%' }}>
                  Connect
                </Button>
              </span>
            </Tooltip>

            <Tooltip title="Engineering">
              <IconButton onClick={openEngineering} color={engineeringUnlocked ? 'primary' : 'default'}>
                <ScienceIcon />
              </IconButton>
            </Tooltip>
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(220px, 1fr))', xl: 'repeat(4, minmax(220px, 1fr))' },
              gap: 1.5,
            }}
          >
            <EditableConfigField
              label="Tester serial"
              value={testerDeviceSerial}
              options={settings.testerDeviceSerials}
              required
              error={!testerSerialValid}
              errorMessage="Expected format: SS-A-001-XXX-YYYY."
              info="Serial on the complete tester/electronics assembly. Type a replacement tester serial and press Enter to save it."
              onValueChange={setTesterDeviceSerial}
              onCommit={updateTesterSerial}
            />

            <EditableConfigField
              label="Enclosure base ID"
              value={settings.defaultEnclosureBaseId}
              options={settings.enclosureBaseIds}
              error={!enclosureBaseValid}
              errorMessage="Expected format: SS-P-001-XXX-YYYY."
              info="Mechanical mating feature used during the open measurement. Expected format: SS-P-001-XXX-YYYY. Press Enter to save a new ID."
              onValueChange={(value) => setSettings((current) => ({ ...current, defaultEnclosureBaseId: value }))}
              onCommit={(value) => commitSettingSelection('defaultEnclosureBaseId', 'enclosureBaseIds', value)}
            />

            <EditableConfigField
              label="Nozzle ID"
              value={settings.defaultNozzleId}
              options={settings.nozzleIds}
              error={!nozzleValid}
              errorMessage="Expected format: NOZL-0001."
              info="Nozzle installed at this station. Type a new nozzle ID and press Enter only when the nozzle changes."
              onValueChange={(value) => setSettings((current) => ({ ...current, defaultNozzleId: value }))}
              onCommit={(value) => commitSettingSelection('defaultNozzleId', 'nozzleIds', value)}
            />

            <EditableConfigField
              label="Seal ID"
              value={settings.defaultSealFixtureId}
              options={settings.sealFixtureIds}
              error={!sealValid}
              errorMessage="Expected format: SEAL-0001."
              info="Seal installed at this station. Type a new seal ID and press Enter only when the seal changes."
              onValueChange={(value) => setSettings((current) => ({ ...current, defaultSealFixtureId: value }))}
              onCommit={(value) => commitSettingSelection('defaultSealFixtureId', 'sealFixtureIds', value)}
            />
          </Box>
        </Stack>
      </Paper>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 34, flexWrap: 'wrap' }}>
        <StatusChip label={deviceStatus} connected={connected} />
        <Chip size="small" label={appVersionStatusLabel(appVersion, updateResult)} color={appVersionStatusColor(updateResult)} />
        {updateResult.status === 'available' && <Chip size="small" label={`Update: v${formatDisplayVersion(updateResult.version)}`} color="warning" />}
        {runUid && <Chip size="small" label={`run_uid ${runUid}`} />}
        {faultText && <Alert severity="error" sx={{ py: 0, flex: '1 1 360px' }}>{faultText}</Alert>}
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

        <Paper variant="outlined" sx={{ minHeight: 470, minWidth: 0, p: 3 }}>
          {renderMainStep()}
        </Paper>

        <Paper variant="outlined" sx={{ p: 2, height: 'fit-content', minWidth: 0, gridColumn: { lg: '1 / -1', xl: 'auto' } }}>
          <Typography variant="subtitle2" gutterBottom>
            Current Run
          </Typography>
          <Stack spacing={1.25}>
            <DetailRow label="Cartridge" value={cartridgeSerial || 'Not scanned'} />
            <DetailRow label="Operator" value={operator || 'Required'} />
            <DetailRow label="Batch" value={batch || 'Required'} />
            <DetailRow label="Tester" value={testerDeviceSerial || 'Required'} />
            <DetailRow label="Enclosure base" value={settings.defaultEnclosureBaseId} />
            <DetailRow label="Nozzle" value={settings.defaultNozzleId} />
            <DetailRow label="Seal" value={settings.defaultSealFixtureId} />
            <Divider />
            <ResultStatusLine guidance={guidance} />
            <DetailRow
              label="Sealed/open"
              value={typeof guidance.sealedOpenRatio === 'number' ? guidance.sealedOpenRatio.toFixed(3) : '-'}
              valueColor={ratioColor(guidance.sealedOpenRatio)}
            />
            <DetailRow label="Open" value={measurementValue(measurements.open)} />
            <DetailRow label="Nozzle" value={measurementValue(measurements.nozzle)} />
            <DetailRow label="Sealed" value={measurementValue(measurements.sealed)} />
            <DetailRow
              label="Guidance"
              value={guidanceOperatorLabel(guidance.guidance)}
              valueColor={guidanceColor(guidance.guidance)}
            />
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

      <HistoricalRecordsPanel
        records={historicalRecords}
        storageSummary={storageSummary}
        offset={historyOffset}
        limit={HISTORY_PAGE_LIMIT}
        runUidFilter={historyRunUidFilter}
        onRunUidFilterChange={(value) => {
          setHistoryRunUidFilter(value)
          void refreshLocalRecords(0, value, historyCartridgeFilter)
        }}
        cartridgeFilter={historyCartridgeFilter}
        onCartridgeFilterChange={(value) => {
          setHistoryCartridgeFilter(value)
          void refreshLocalRecords(0, historyRunUidFilter, value)
        }}
        onPage={loadHistoryPage}
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
            <Button startIcon={<RefreshIcon />} onClick={() => runReadiness()} disabled={!connected}>
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
          <Button variant="contained" onClick={() => setCurrentStep('scan')} disabled={!solenoidLocked} sx={{ alignSelf: 'flex-start' }}>
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
              Follow each fixture prompt before continuing. The firmware-generated run_uid is used for every phase.
            </Typography>
          </Box>
          {testStage === 'fit_nozzle' && (
            <Alert
              severity="info"
              action={(
                <Button color="inherit" size="small" onClick={continueNozzleMeasurement}>
                  Nozzle fitted
                </Button>
              )}
            >
              Fit nozzle ID {activeRunSnapshot.current?.nozzle_id ?? settings.defaultNozzleId}, then continue to the nozzle measurement.
            </Alert>
          )}
          {testStage === 'fit_seal' && (
            <Alert
              severity="info"
              action={(
                <Button color="inherit" size="small" onClick={continueSealedMeasurement}>
                  Inlet sealed
                </Button>
              )}
            >
              Remove the nozzle, fit seal ID {activeRunSnapshot.current?.seal_fixture_id ?? settings.defaultSealFixtureId}, then continue to the sealed measurement.
            </Alert>
          )}
          {progress ? (
            <Box>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {progressLabel(progress.phase, progress.elapsedMs)}
              </Typography>
              <LinearProgress variant="determinate" value={progressValue} sx={{ height: 8, borderRadius: 1 }} />
            </Box>
          ) : (
            testStage === 'running_open' || testStage === 'running_nozzle' || testStage === 'running_sealed'
              ? <LinearProgress />
              : null
          )}
          <ResultSummary guidance={guidance} measurements={measurements} />
          <CartridgeDispositionAlert guidance={guidance} />
          <MeasurementTable measurements={measurements} />
          <MeasurementHistograms measurements={measurements} guidance={guidance} />
          <MeasurementDetails measurements={measurements} />
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
          <ResultSummary guidance={guidance} measurements={measurements} />
          <MeasurementTable measurements={measurements} />
          <MeasurementHistograms measurements={measurements} guidance={guidance} />
          <MeasurementDetails measurements={measurements} />
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
            {requiresCartridgeRepeat(guidance.guidance)
              ? 'The cartridge needs to be reseated and repeated before it is classified. The bay should now be empty and locked.'
              : 'The previous cartridge cycle ended with the bay empty and solenoid locked.'}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={nextCartridge}>
            {requiresCartridgeRepeat(guidance.guidance) ? 'Repeat cartridge' : 'Next cartridge'}
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

function validateStationSettingValue(key: keyof StationSettings, value: string): string | undefined {
  if (key === 'defaultTesterDeviceSerial' && !isTesterDeviceSerial(value)) return 'Tester serial must match SS-A-001-XXX-YYYY.'
  if (key === 'defaultEnclosureBaseId' && !isEnclosureBaseId(value)) return 'Enclosure base ID must match SS-P-001-XXX-YYYY.'
  if (key === 'defaultNozzleId' && !isNozzleId(value)) return 'Nozzle ID must match NOZL-0001 format.'
  if (key === 'defaultSealFixtureId' && !isSealFixtureId(value)) return 'Seal ID must match SEAL-0001 format.'
  if ((key === 'latestBatch' || key === 'stationId') && !value.trim()) return `${String(key)} is required.`
  return undefined
}

function validateStationOptionValue(key: keyof StationSettings, value: string): string | undefined {
  if (key === 'testerDeviceSerials' && !isTesterDeviceSerial(value)) return 'Tester serial must match SS-A-001-XXX-YYYY.'
  if (key === 'enclosureBaseIds' && !isEnclosureBaseId(value)) return 'Enclosure base ID must match SS-P-001-XXX-YYYY.'
  if (key === 'nozzleIds' && !isNozzleId(value)) return 'Nozzle ID must match NOZL-0001 format.'
  if (key === 'sealFixtureIds' && !isSealFixtureId(value)) return 'Seal ID must match SEAL-0001 format.'
  if ((key === 'operators' || key === 'batches') && !value.trim()) return `${String(key)} entry is required.`
  return undefined
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
}) {
  const trimmedValue = props.value.trim()

  const commit = () => {
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
            if (event.key === 'Enter') {
              commit()
            }
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
      <Box
        component="span"
        aria-label="Help"
        sx={{
          alignItems: 'center',
          color: 'text.secondary',
          cursor: 'help',
          display: 'inline-flex',
          flexShrink: 0,
          lineHeight: 0,
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 18 }} />
      </Box>
    </Tooltip>
  )
}

function readinessStatusText(item: ReadinessItem): string {
  if (item.status === 'running') return 'Checking now'
  if (item.status === 'passed') return item.detail ?? 'Ready'
  if (item.status === 'failed') return item.detail ?? 'Needs attention'
  return 'Waiting'
}

function canonicalizeStationValue(key: keyof StationSettings, value: string): string {
  const trimmed = value.trim()
  if (
    key === 'defaultTesterDeviceSerial' ||
    key === 'testerDeviceSerials' ||
    key === 'defaultEnclosureBaseId' ||
    key === 'enclosureBaseIds' ||
    key === 'defaultNozzleId' ||
    key === 'nozzleIds' ||
    key === 'defaultSealFixtureId' ||
    key === 'sealFixtureIds'
  ) {
    return canonicalHardwareId(trimmed)
  }
  return trimmed
}

function HistoricalRecordsPanel(props: {
  records: HistoricalRecords
  storageSummary: StorageSummary | null
  offset: number
  limit: number
  runUidFilter: string
  onRunUidFilterChange: (value: string) => void
  cartridgeFilter: string
  onCartridgeFilterChange: (value: string) => void
  onPage: (offset: number) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const [attemptView, setAttemptView] = useState<'all' | 'latest'>('all')
  const [operatorFilter, setOperatorFilter] = useState('all')
  const [productionBatchFilter, setProductionBatchFilter] = useState('all')
  const [appVersionFilter, setAppVersionFilter] = useState('all')
  const [resultFilter, setResultFilter] = useState<'all' | CartridgeHistoryResult>('all')
  const allRuns = useMemo(() => buildCartridgeHistoryRuns(props.records.events), [props.records.events])
  const operatorOptions = useMemo(() => uniqueStrings(allRuns.map((run) => run.operator)), [allRuns])
  const productionBatchOptions = useMemo(() => uniqueStrings(allRuns.map((run) => run.productionBatch)), [allRuns])
  const appVersionOptions = useMemo(() => uniqueStrings(allRuns.map((run) => run.appVersion ?? 'unknown')), [allRuns])
  const filteredRuns = useMemo(() => {
    return filterCartridgeHistoryRuns(allRuns, {
      attemptView,
      operator: operatorFilter,
      productionBatch: productionBatchFilter,
      appVersion: appVersionFilter,
      result: resultFilter,
    })
  }, [allRuns, appVersionFilter, attemptView, operatorFilter, productionBatchFilter, resultFilter])
  const summary = useMemo(() => summarizeCartridgeHistory(filteredRuns), [filteredRuns])
  const sections = [
    {
      title: `Mirrored events (${props.records.events.length})`,
      empty: 'No mirrored events stored yet.',
      records: props.records.events,
    },
    {
      title: `Command responses (${props.records.responses.length})`,
      empty: 'No command responses stored yet.',
      records: props.records.responses,
    },
    {
      title: `Commands (${props.records.commands.length})`,
      empty: 'No commands stored yet.',
      records: props.records.commands,
    },
    {
      title: `Overrides (${props.records.overrides.length})`,
      empty: 'No overrides stored yet.',
      records: props.records.overrides,
    },
  ]
  const hasNext = sections.some((section) => section.records.length >= props.limit)

  return (
    <Accordion disableGutters defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">Cartridge history</Typography>
          <Chip size="small" label={`${summary.runCount} runs`} />
          <Chip size="small" label={`${summary.uniqueCartridgeCount} cartridges`} />
          <Chip size="small" label={`${summary.resultCounts.accept} accept`} color="success" />
          <Chip size="small" label={`${summary.resultCounts.borderline} borderline`} color="warning" />
          <Chip size="small" label={`${summary.resultCounts.suspect} suspect`} color="error" />
          <Chip size="small" label={`${summary.resultCounts.repeat} repeat`} color="error" />
          {summary.resultCounts.unknown > 0 && <Chip size="small" label={`${summary.resultCounts.unknown} unknown`} />}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1}
            useFlexGap
            alignItems={{ xs: 'stretch', md: 'center' }}
            sx={{ flexWrap: 'wrap' }}
          >
            <Button size="small" startIcon={<RefreshIcon />} onClick={props.onRefresh}>
              Refresh records
            </Button>
            <TextField
              size="small"
              label="Filter run_uid"
              value={props.runUidFilter}
              onChange={(event) => props.onRunUidFilterChange(event.target.value)}
              sx={{ minWidth: 260 }}
            />
            <TextField
              size="small"
              label="Filter cartridge"
              value={props.cartridgeFilter}
              onChange={(event) => props.onCartridgeFilterChange(normalizeCartridgeSerial(event.target.value))}
              sx={{ minWidth: 240 }}
            />
            <HistorySelect label="Operator" value={operatorFilter} options={operatorOptions} onChange={setOperatorFilter} />
            <HistorySelect label="Production batch" value={productionBatchFilter} options={productionBatchOptions} onChange={setProductionBatchFilter} />
            <HistorySelect label="App version" value={appVersionFilter} options={appVersionOptions} onChange={setAppVersionFilter} />
            <HistorySelect
              label="Result"
              value={resultFilter}
              options={['accept', 'borderline', 'suspect', 'repeat', 'unknown']}
              onChange={(value) => setResultFilter(value as 'all' | CartridgeHistoryResult)}
            />
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel>Attempts</InputLabel>
              <Select label="Attempts" value={attemptView} onChange={(event) => setAttemptView(event.target.value as 'all' | 'latest')}>
                <MenuItem value="all">All attempts</MenuItem>
                <MenuItem value="latest">Latest per cartridge</MenuItem>
              </Select>
            </FormControl>
            <Button size="small" disabled={props.offset === 0} onClick={() => props.onPage(props.offset - props.limit)}>
              Previous
            </Button>
            <Button size="small" disabled={!hasNext} onClick={() => props.onPage(props.offset + props.limit)}>
              Next
            </Button>
          </Stack>

          <HistorySummaryStrip summary={summary} />

          <Typography variant="caption" color="text.secondary">
            Showing records {props.offset + 1}-{props.offset + props.limit} from the loaded local history window. Production batch is the manufacturing batch field. Full retention remains in SQLite and JSONL: {props.storageSummary?.jsonlPath ?? 'not loaded'}.
          </Typography>

          <Stack spacing={1}>
            {filteredRuns.length > 0 ? (
              filteredRuns.map((run) => <CartridgeHistoryRunRow key={run.id} run={run} />)
            ) : (
              <Alert severity="info">No cartridge history matches the current filters.</Alert>
            )}
          </Stack>

          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography variant="body2">Engineering raw records</Typography>
                <Chip size="small" label={`${props.records.events.length} events`} />
                <Chip size="small" label={`${props.records.responses.length} responses`} />
                <Chip size="small" label={`${props.records.commands.length} commands`} />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1}>
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
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

function HistorySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  return (
    <FormControl size="small" sx={{ minWidth: 170 }}>
      <InputLabel>{label}</InputLabel>
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <MenuItem value="all">All</MenuItem>
        {options.map((option) => (
          <MenuItem key={option} value={option}>{option}</MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}

function HistorySummaryStrip({ summary }: { summary: ReturnType<typeof summarizeCartridgeHistory> }) {
  const ratioRange = typeof summary.ratioMin === 'number' && typeof summary.ratioMax === 'number'
    ? `${summary.ratioMin.toFixed(3)}-${summary.ratioMax.toFixed(3)}`
    : '-'
  const metrics = [
    ['Runs', String(summary.runCount)],
    ['Cartridges', String(summary.uniqueCartridgeCount)],
    ['Accept', String(summary.resultCounts.accept)],
    ['Borderline', String(summary.resultCounts.borderline)],
    ['Suspect', String(summary.resultCounts.suspect)],
    ['Repeat results', String(summary.resultCounts.repeat)],
    ['Unknown', String(summary.resultCounts.unknown)],
    ['Median ratio', formatNumber(summary.ratioMedian)],
    ['Ratio range', ratioRange],
    ['Multi-attempt rows', String(summary.repeatAttemptCount)],
    ['App versions', summary.appVersions.join(', ') || 'unknown'],
  ]

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(5, minmax(0, 1fr))' }, gap: 1 }}>
      {metrics.map(([label, value]) => (
        <Box key={label} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">{label}</Typography>
          <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</Typography>
        </Box>
      ))}
    </Box>
  )
}

function CartridgeHistoryRunRow({ run }: { run: CartridgeHistoryRun }) {
  const result = cartridgeHistoryResult(run)
  const resultLabel = historyResultLabel(result)
  const appVersion = run.appVersion ? `App v${formatDisplayVersion(run.appVersion)}` : 'App unknown'
  return (
    <Accordion disableGutters sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ alignItems: 'flex-start', '& .MuiAccordionSummary-content': { minWidth: 0 } }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(240px, 0.9fr) minmax(260px, 1.1fr) minmax(520px, 1.5fr)' },
            gap: 1.5,
            width: '100%',
            minWidth: 0,
            alignItems: 'start',
          }}
        >
          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap' }}>
              {historyResultIcon(result)}
              <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                {run.cartridgeSerial ?? 'Unknown cartridge'}
              </Typography>
              <Chip size="small" label={resultLabel} color={historyResultChipColor(result)} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {formatTimestamp(run.completedAt)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {run.operator ?? 'Unknown operator'} | {run.productionBatch ?? 'No production batch'} | {appVersion}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Attempt {run.attemptIndex}/{run.attemptCount} | {run.eventCount} events
            </Typography>
          </Stack>

          <Stack spacing={0.5} sx={{ minWidth: 0 }}>
            <Stack direction="row" justifyContent="space-between" spacing={1}>
              <Typography variant="caption" color="text.secondary">Sealed/open ratio</Typography>
              <Typography variant="body2" color={ratioColor(run.sealedOpenRatio)}>
                {formatNumber(run.sealedOpenRatio)}
              </Typography>
            </Stack>
            <RatioThresholdBar ratio={run.sealedOpenRatio} dense />
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              Tester {run.testerDeviceSerial ?? '-'} | Nozzle {run.nozzleId ?? '-'} | Seal {run.sealFixtureId ?? '-'}
            </Typography>
          </Stack>

          <HistoryMeasurementTable run={run} />
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.25}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
            <DetailRow label="Run UID" value={run.runUid ?? '-'} />
            <DetailRow label="Firmware" value={run.firmwareVersion ? String(run.firmwareVersion) : '-'} />
            <DetailRow label="Device ID" value={run.deviceId ?? '-'} />
            <DetailRow label="Enclosure base" value={run.enclosureBaseId ?? '-'} />
            <DetailRow label="Profile" value={run.profileVersion ?? '-'} />
            <DetailRow label="Status" value={run.status ?? resultLabel} valueColor={historyResultColor(result)} />
          </Box>
          <MeasurementTable measurements={run.measurements as Record<string, MeasurementSummary>} dense />
          <MeasurementHistograms measurements={run.measurements as Record<string, MeasurementSummary>} guidance={{ guidance: run.guidance, sealedOpenRatio: run.sealedOpenRatio, sampleQuality: run.sampleQuality }} defaultExpanded={false} />
          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2">Raw events for this run</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <LogBlock lines={run.rawEvents.map((event) => JSON.stringify(event.record, null, 2))} empty="No raw events for this run." maxHeight={320} />
            </AccordionDetails>
          </Accordion>
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

function HistoryMeasurementTable({ run }: { run: CartridgeHistoryRun }) {
  const rows: TestPhase[] = ['open', 'nozzle', 'sealed']
  return (
    <Box sx={{ minWidth: 0, overflowX: 'auto' }}>
      <Table size="small" sx={{ minWidth: 520 }}>
        <TableHead>
          <TableRow>
            <TableCell>State</TableCell>
            <TableCell align="right">Trimmed</TableCell>
            <TableCell align="right">Min</TableCell>
            <TableCell align="right">Max</TableCell>
            <TableCell align="right">CV</TableCell>
            <TableCell align="center">Quality</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((phase) => {
            const measurement = run.measurements[phase]
            return (
              <TableRow key={phase}>
                <TableCell sx={{ textTransform: 'capitalize' }}>{phase}</TableCell>
                <TableCell align="right">{formatNumber(measurement?.slpm)}</TableCell>
                <TableCell align="right">{formatNumber(measurement?.min_slpm)}</TableCell>
                <TableCell align="right">{formatNumber(measurement?.max_slpm)}</TableCell>
                <TableCell align="right">{measurement ? `${(measurement.coefficient_of_variation * 100).toFixed(1)}%` : '-'}</TableCell>
                <TableCell align="center">
                  {measurement ? (
                    <Tooltip title={`Sample quality: ${measurement.sample_quality}`}>
                      <Box component="span" sx={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                        <QualityIcon measurement={measurement} />
                      </Box>
                    </Tooltip>
                  ) : '-'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Box>
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
            <DetailRow label="Responses" value={String(props.storageSummary?.responseCount ?? 0)} />
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
                <MenuItem value="Record station hardware issue">Record station hardware issue</MenuItem>
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
    const trimmed = canonicalizeStationValue(key, value)
    if (validateStationSettingValue(key, trimmed)) return
    const currentList = props.settings[listKey]
    const nextList = Array.isArray(currentList) ? Array.from(new Set([...currentList, trimmed].filter(Boolean))) : []
    void props.saveSettings({ ...props.settings, [key]: trimmed, [listKey]: nextList })
  }

  return (
    <Stack spacing={1.5}>
      <EditableDefault
        label="Tester serial"
        value={props.settings.defaultTesterDeviceSerial}
        options={props.settings.testerDeviceSerials}
        validator={(value) => validateStationSettingValue('defaultTesterDeviceSerial', value)}
        onChange={(value) => updateDefault('defaultTesterDeviceSerial', 'testerDeviceSerials', value)}
      />
      <EditableDefault
        label="Enclosure base ID"
        value={props.settings.defaultEnclosureBaseId}
        options={props.settings.enclosureBaseIds}
        validator={(value) => validateStationSettingValue('defaultEnclosureBaseId', value)}
        onChange={(value) => updateDefault('defaultEnclosureBaseId', 'enclosureBaseIds', value)}
      />
      <EditableDefault
        label="Nozzle"
        value={props.settings.defaultNozzleId}
        options={props.settings.nozzleIds}
        validator={(value) => validateStationSettingValue('defaultNozzleId', value)}
        onChange={(value) => updateDefault('defaultNozzleId', 'nozzleIds', value)}
      />
      <EditableDefault
        label="Seal ID"
        value={props.settings.defaultSealFixtureId}
        options={props.settings.sealFixtureIds}
        validator={(value) => validateStationSettingValue('defaultSealFixtureId', value)}
        onChange={(value) => updateDefault('defaultSealFixtureId', 'sealFixtureIds', value)}
      />
      <EditableDefault
        label="Latest batch"
        value={props.settings.latestBatch}
        options={props.settings.batches}
        validator={(value) => validateStationSettingValue('latestBatch', value)}
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
  validator?: (value: string) => string | undefined
}) {
  const [draft, setDraft] = useState(props.value)
  const error = props.validator?.(draft.trim())

  useEffect(() => {
    setDraft(props.value)
  }, [props.value])

  const commit = (value = draft) => {
    const trimmed = value.trim()
    if (!trimmed || props.validator?.(trimmed)) return
    props.onChange(trimmed)
  }

  return (
    <Autocomplete
      freeSolo
      options={props.options}
      value={draft}
      inputValue={draft}
      onChange={(_event, value) => {
        const nextValue = value ?? ''
        setDraft(nextValue)
        commit(nextValue)
      }}
      onInputChange={(_event, value) => setDraft(value)}
      renderInput={(params) => (
        <TextField
          {...params}
          label={props.label}
          size="small"
          error={Boolean(error)}
          helperText={error}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
        />
      )}
    />
  )
}

function ResultStatusLine({ guidance }: { guidance: GuidanceState }) {
  const severity = guidanceSeverity(guidance.guidance, guidance.sampleQuality)
  const label = guidanceOperatorLabel(guidance.guidance)
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2} alignItems="center">
      <Typography variant="body2" color="text.secondary">
        Result
      </Typography>
      <Stack direction="row" spacing={0.75} alignItems="center">
        {severity === 'success' ? (
          <CheckCircleIcon color="success" fontSize="small" />
        ) : severity === 'error' ? (
          <ErrorOutlineIcon color="error" fontSize="small" />
        ) : severity === 'warning' ? (
          <WarningAmberIcon color="warning" fontSize="small" />
        ) : null}
        <Typography variant="body2" textAlign="right" color={guidanceColor(guidance.guidance)} sx={{ overflowWrap: 'anywhere' }}>
          {label}
        </Typography>
      </Stack>
    </Stack>
  )
}

function hasGuidanceData(guidance: GuidanceState): boolean {
  return Boolean(
    guidance.guidance ||
      typeof guidance.sealedOpenRatio === 'number' ||
      guidance.sampleQuality,
  )
}

function storedEventBelongsToRun(event: HistoricalRecords['events'][number], targetRunUid: string): boolean {
  const data = event.record.data
  const context = asRecord(data.context)
  const candidates = [
    event.run_uid,
    event.record.run_uid,
    data.run_uid,
    data.run,
    context.run_uid,
    context.run,
  ]

  return candidates.some((value) => value === targetRunUid)
}

function responseContainsSealedCompletion(result: unknown): boolean {
  const root = asRecord(result)
  const sealed = asRecord(root.sealed)
  return Object.keys(sealed).length > 0 && (typeof root.phase1_guidance === 'string' || Object.keys(asRecord(root.ratios)).length > 0)
}

function ResultSummary({
  guidance,
  measurements,
}: {
  guidance: GuidanceState
  measurements: Record<string, MeasurementSummary>
}) {
  const severity = guidanceSeverity(guidance.guidance, guidance.sampleQuality)
  const ratio = guidance.sealedOpenRatio
  const sealed = measurements.sealed
  const title = guidanceOperatorLabel(guidance.guidance)
  const isAccepted = guidance.guidance === 'ACCEPT_SINGLE_PASS'

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
      <Stack spacing={1.5}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(280px, 0.65fr)' },
            gap: 1.5,
            alignItems: 'start',
            minWidth: 0,
          }}
        >
          <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ minWidth: 0 }}>
            {severity === 'success' ? (
              <CheckCircleIcon color="success" sx={{ mt: 0.25 }} />
            ) : severity === 'error' ? (
              <ErrorOutlineIcon color="error" sx={{ mt: 0.25 }} />
            ) : severity === 'warning' ? (
              <WarningAmberIcon color="warning" sx={{ mt: 0.25 }} />
            ) : (
              <InfoOutlinedIcon color="disabled" sx={{ mt: 0.25 }} />
            )}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1">{title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
                {isAccepted
                  ? 'No repeat action is required. The ratio gauge and histograms are diagnostic references only.'
                  : 'Use the action label first. The ratio gauge and histograms help engineers spot abnormal patterns.'}
              </Typography>
            </Box>
          </Stack>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(130px, 1fr))' },
              gap: 1.25,
              minWidth: 0,
            }}
          >
            <Metric label="Sealed/open" value={typeof ratio === 'number' ? ratio.toFixed(3) : '-'} color={ratioColor(ratio)} />
            <Metric label="Sealed flow" value={sealed ? `${sealed.slpm.toFixed(3)} slpm` : '-'} />
          </Box>
        </Box>
        <RatioThresholdBar ratio={ratio} />
      </Stack>
    </Box>
  )
}

function CartridgeDispositionAlert({ guidance }: { guidance: GuidanceState }) {
  if (!guidance.guidance || guidance.guidance === 'ACCEPT_SINGLE_PASS') {
    return null
  }

  const severity = guidanceSeverity(guidance.guidance, guidance.sampleQuality)
  return (
    <Alert severity={severity === 'success' ? 'info' : severity}>
      {cartridgeRepeatActionText(guidance.guidance)}
    </Alert>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography
        variant="h6"
        color={color ?? 'text.primary'}
        sx={{ lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {value}
      </Typography>
    </Box>
  )
}

const RATIO_AXIS_MIN = 0.10
const RATIO_AXIS_MAX = 0.40
const RATIO_ACCEPT_MAX = 0.25
const RATIO_SUSPECT_MIN = 0.28

function RatioThresholdBar({ ratio, dense = false }: { ratio?: number; dense?: boolean }) {
  const range = RATIO_AXIS_MAX - RATIO_AXIS_MIN
  const valuePct = typeof ratio === 'number' ? clamp(((ratio - RATIO_AXIS_MIN) / range) * 100, 0, 100) : undefined
  const offScaleLow = typeof ratio === 'number' && ratio < RATIO_AXIS_MIN
  const offScaleHigh = typeof ratio === 'number' && ratio > RATIO_AXIS_MAX
  const borderlinePct = clamp(((RATIO_ACCEPT_MAX - RATIO_AXIS_MIN) / range) * 100, 0, 100)
  const suspectPct = clamp(((RATIO_SUSPECT_MIN - RATIO_AXIS_MIN) / range) * 100, 0, 100)
  const markerColor = ratioColor(ratio) ?? 'text.secondary'

  return (
    <Box>
      <Box sx={{ position: 'relative', height: dense ? 22 : 30 }}>
        <Box sx={{ position: 'absolute', left: 0, right: 0, top: 11, height: 8, bgcolor: 'success.light', borderRadius: 1 }} />
        <Box sx={{ position: 'absolute', left: `${borderlinePct}%`, right: `${100 - suspectPct}%`, top: 11, height: 8, bgcolor: 'warning.light' }} />
        <Box sx={{ position: 'absolute', left: `${suspectPct}%`, right: 0, top: 11, height: 8, bgcolor: 'error.light', borderTopRightRadius: 4, borderBottomRightRadius: 4 }} />
        {!dense && <ThresholdMark percent={borderlinePct} label="0.25" />}
        {!dense && <ThresholdMark percent={suspectPct} label="0.28" />}
        {valuePct !== undefined && !offScaleLow && !offScaleHigh && (
          <Box
            sx={{
              position: 'absolute',
              left: `${valuePct}%`,
              top: dense ? 5 : 3,
              width: 2,
              height: dense ? 18 : 24,
              bgcolor: markerColor,
              transform: 'translateX(-1px)',
            }}
          />
        )}
        {offScaleLow && <OffScaleRatioArrow side="left" color={markerColor} />}
        {offScaleHigh && <OffScaleRatioArrow side="right" color={markerColor} />}
      </Box>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography variant="caption" color="text.secondary">{RATIO_AXIS_MIN.toFixed(2)}</Typography>
        {!dense && <Typography variant="caption" color="success.main">Accept range</Typography>}
        <Typography variant="caption" color="warning.main">{dense ? '0.25 / 0.28' : 'Borderline band'}</Typography>
        {!dense && <Typography variant="caption" color="error.main">Suspect band</Typography>}
        <Typography variant="caption" color="text.secondary">{RATIO_AXIS_MAX.toFixed(2)}</Typography>
      </Stack>
    </Box>
  )
}

function OffScaleRatioArrow({ side, color }: { side: 'left' | 'right'; color: string }) {
  return (
    <Box
      aria-label={side === 'left' ? 'Ratio is below fixed axis minimum' : 'Ratio is above fixed axis maximum'}
      sx={{
        position: 'absolute',
        left: side === 'left' ? 0 : '100%',
        top: 5,
        width: 0,
        height: 0,
        transform: side === 'left' ? 'translateX(-1px)' : 'translateX(-9px)',
        borderTop: '7px solid transparent',
        borderBottom: '7px solid transparent',
        borderRight: side === 'left' ? '10px solid' : undefined,
        borderLeft: side === 'right' ? '10px solid' : undefined,
        borderRightColor: side === 'left' ? color : undefined,
        borderLeftColor: side === 'right' ? color : undefined,
      }}
    />
  )
}

function ThresholdMark({ percent, label }: { percent: number; label: string }) {
  return (
    <Box sx={{ position: 'absolute', left: `${percent}%`, top: 0, transform: 'translateX(-50%)' }}>
      <Box sx={{ width: 1, height: 26, bgcolor: 'text.secondary', opacity: 0.55, mx: 'auto' }} />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
        {label}
      </Typography>
    </Box>
  )
}

function MeasurementHistograms({
  measurements,
  guidance,
  defaultExpanded = true,
}: {
  measurements: Record<string, MeasurementSummary>
  guidance: GuidanceState
  defaultExpanded?: boolean
}) {
  const rows: TestPhase[] = ['open', 'nozzle', 'sealed']
  const hasSamples = rows.some((phase) => (measurements[phase]?.flow_slpm_samples?.length ?? 0) > 0)
  if (!hasSamples && typeof guidance.sealedOpenRatio !== 'number') return null

  return (
    <Accordion disableGutters defaultExpanded={defaultExpanded}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2">Measurement distribution</Typography>
          <InlineInfoIcon title="Histograms show the 30 raw flow samples. Vertical markers show trimmed mean and raw mean; the ratio bar shows Phase 1 thresholds." />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
            {rows.map((phase) => (
              <MeasurementHistogram key={phase} measurement={measurements[phase]} phase={phase} />
            ))}
          </Box>
          <RatioThresholdBar ratio={guidance.sealedOpenRatio} />
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

function MeasurementHistogram({ measurement, phase }: { measurement?: MeasurementSummary; phase: TestPhase }) {
  if (!measurement?.flow_slpm_samples?.length) {
    return (
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25, minHeight: 148 }}>
        <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>{phase}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>No samples yet</Typography>
      </Box>
    )
  }

  const samples = measurement.flow_slpm_samples
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  const spread = Math.max(max - min, 0.001)
  const bins = Array.from({ length: 10 }, () => 0)
  for (const sample of samples) {
    const index = Math.min(bins.length - 1, Math.floor(((sample - min) / spread) * bins.length))
    bins[index] += 1
  }
  const maxBin = Math.max(...bins, 1)
  const trimmedPct = clamp(((measurement.slpm - min) / spread) * 100, 0, 100)
  const rawPct = clamp(((measurement.raw_mean_slpm - min) / spread) * 100, 0, 100)

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>{phase}</Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <QualityIcon measurement={measurement} />
          <Typography variant="caption" color={measurement.sample_quality === 'acceptable' ? 'success.main' : 'warning.main'}>
            {measurement.sample_quality}
          </Typography>
        </Stack>
      </Stack>
      <Box sx={{ position: 'relative', height: 78, display: 'flex', alignItems: 'end', gap: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        {bins.map((count, index) => (
          <Box
            key={index}
            sx={{
              flex: 1,
              height: `${Math.max(6, (count / maxBin) * 68)}px`,
              bgcolor: 'primary.light',
              borderTopLeftRadius: 2,
              borderTopRightRadius: 2,
              opacity: 0.8,
            }}
          />
        ))}
        <Box sx={{ position: 'absolute', left: `${trimmedPct}%`, bottom: 0, width: 2, height: 76, bgcolor: 'primary.dark' }} />
        <Box sx={{ position: 'absolute', left: `${rawPct}%`, bottom: 0, width: 2, height: 58, bgcolor: 'warning.dark', opacity: 0.8 }} />
      </Box>
      <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.75 }}>
        <Typography variant="caption" color="text.secondary">{min.toFixed(3)}</Typography>
        <Typography variant="caption" color="text.secondary">{measurement.slpm.toFixed(3)} trimmed</Typography>
        <Typography variant="caption" color="text.secondary">{max.toFixed(3)}</Typography>
      </Stack>
      <Stack direction="row" spacing={1.25} sx={{ mt: 0.5 }} alignItems="center">
        <LegendMarker color="primary.dark" label="Trimmed mean" />
        <LegendMarker color="warning.dark" label="Raw mean" />
      </Stack>
    </Box>
  )
}

function LegendMarker({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Box sx={{ width: 10, height: 2, bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">{label}</Typography>
    </Stack>
  )
}

function MeasurementDetails({ measurements }: { measurements: Record<string, MeasurementSummary> }) {
  const rows: TestPhase[] = ['open', 'nozzle', 'sealed']
  if (!rows.some((phase) => measurements[phase])) return null

  return (
    <Accordion disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2">Full measurement data and raw flow samples</Typography>
          <InlineInfoIcon title="Detailed engineering data from the firmware payload: all summary statistics, timing, fan command, environment readings, and the 30 raw flow samples for each measured state." />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 1120 }}>
              <TableHead>
                <TableRow>
                  <TableCell>State</TableCell>
                  <TableCell align="right">Samples</TableCell>
                  <TableCell align="right">Trimmed count</TableCell>
                  <TableCell align="right">Raw mean</TableCell>
                  <TableCell align="right">Median</TableCell>
                  <TableCell align="right">Std dev</TableCell>
                  <TableCell align="right">Min</TableCell>
                  <TableCell align="right">Max</TableCell>
                  <TableCell align="right">CV</TableCell>
                  <TableCell align="right">Outliers</TableCell>
                  <TableCell align="right">PWM</TableCell>
                  <TableCell align="right">RPM</TableCell>
                  <TableCell align="right">Settle</TableCell>
                  <TableCell align="right">dt</TableCell>
                  <TableCell align="right">Pressure</TableCell>
                  <TableCell align="right">Temp</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((phase) => {
                  const measurement = measurements[phase]
                  return (
                    <TableRow key={phase}>
                      <TableCell sx={{ textTransform: 'capitalize' }}>{phase}</TableCell>
                      <TableCell align="right">{measurement?.sample_count ?? measurement?.flow_slpm_samples?.length ?? '-'}</TableCell>
                      <TableCell align="right">{measurement?.trimmed_count ?? '-'}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.raw_mean_slpm)}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.median_slpm)}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.stddev_slpm)}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.min_slpm)}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.max_slpm)}</TableCell>
                      <TableCell align="right">{measurement ? `${(measurement.coefficient_of_variation * 100).toFixed(2)}%` : '-'}</TableCell>
                      <TableCell align="right">{measurement?.outlier_count ?? '-'}</TableCell>
                      <TableCell align="right">{measurement?.fan_pwm_pct !== undefined ? `${measurement.fan_pwm_pct}%` : '-'}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.rpm, 0)}</TableCell>
                      <TableCell align="right">{measurement?.settle_ms ? `${(measurement.settle_ms / 1000).toFixed(0)}s` : '-'}</TableCell>
                      <TableCell align="right">{measurement?.dt_ms ? `${measurement.dt_ms} ms` : '-'}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.pressure_hpa, 1)}</TableCell>
                      <TableCell align="right">{formatNumber(measurement?.temperature_c, 1)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Box>

          {rows.map((phase) => {
            const measurement = measurements[phase]
            if (!measurement) return null
            return (
              <Box key={phase} sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} justifyContent="space-between" sx={{ mb: 0.75 }}>
                  <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>
                    {phase} raw flow samples
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Source: {measurement.environment_source ?? '-'}; stability limit {formatNumber(measurement.stability_limit_slpm)} slpm
                  </Typography>
                </Stack>
                <Typography variant="caption" component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', color: 'text.secondary' }}>
                  {measurement.flow_slpm_samples?.map((sample) => sample.toFixed(3)).join(', ') ?? 'No raw sample list in payload.'}
                </Typography>
              </Box>
            )
          })}
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}

function MeasurementTable({ measurements, dense = false }: { measurements: Record<string, MeasurementSummary>; dense?: boolean }) {
  const rows: TestPhase[] = ['open', 'nozzle', 'sealed']
  return (
    <Box sx={{ minWidth: 0, overflowX: 'auto' }}>
      <Table size="small" sx={{ minWidth: dense ? 580 : 620 }}>
      <TableHead>
        <TableRow>
          <TableCell>State</TableCell>
          <TableCell align="right">Trimmed slpm</TableCell>
          <TableCell align="right">Raw mean</TableCell>
          <TableCell align="right">Min</TableCell>
          <TableCell align="right">Max</TableCell>
          <TableCell align="right">CV</TableCell>
          <TableCell align="center">Quality</TableCell>
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
              <TableCell align="right">{measurement ? measurement.min_slpm.toFixed(3) : '-'}</TableCell>
              <TableCell align="right">{measurement ? measurement.max_slpm.toFixed(3) : '-'}</TableCell>
              <TableCell align="right">
                {measurement ? `${(measurement.coefficient_of_variation * 100).toFixed(1)}%` : '-'}
              </TableCell>
              <TableCell align="center">
                {measurement ? (
                  <Tooltip title={`Sample quality: ${measurement.sample_quality}`}>
                    <Box component="span" sx={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                      <QualityIcon measurement={measurement} />
                    </Box>
                  </Tooltip>
                ) : '-'}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
      </Table>
    </Box>
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

function QualityIcon({ measurement }: { measurement: MeasurementSummary }) {
  if (measurement.valid === false) {
    return <ErrorOutlineIcon color="error" fontSize="small" />
  }
  if (measurement.sample_quality === 'repeat') {
    return <WarningAmberIcon color="warning" fontSize="small" />
  }
  return <CheckCircleIcon color="success" fontSize="small" />
}

function guidanceOperatorLabel(guidance?: string): string {
  switch (guidance) {
    case 'ACCEPT_SINGLE_PASS':
      return 'Accept single pass'
    case 'RESEAT_AND_REPEAT_BORDERLINE':
      return 'Reseat and repeat'
    case 'RESEAT_AND_REPEAT_SUSPECT_FAIL':
      return 'Suspect fail - reseat and repeat'
    case 'REPEAT_MEASUREMENT_QUALITY':
      return 'Repeat measurement'
    case 'REPEAT_INVALID_RATIO':
      return 'Repeat measurement'
    case undefined:
    case '':
      return 'Waiting'
    default:
      return guidance.replaceAll('_', ' ')
  }
}

function requiresCartridgeRepeat(guidance?: string): boolean {
  return Boolean(guidance && guidance !== 'ACCEPT_SINGLE_PASS')
}

function cartridgeRepeatActionText(guidance?: string): string {
  switch (guidance) {
    case 'RESEAT_AND_REPEAT_BORDERLINE':
      return 'Borderline result. Remove the cartridge, reseat it, and repeat before classifying.'
    case 'RESEAT_AND_REPEAT_SUSPECT_FAIL':
      return 'Suspect fail. Remove the cartridge, reseat it, and repeat before classifying as a cartridge failure.'
    case 'REPEAT_MEASUREMENT_QUALITY':
      return 'Measurement quality was not acceptable. Remove and repeat before classifying.'
    case 'REPEAT_INVALID_RATIO':
      return 'The normalized ratio could not be computed. Remove and repeat before classifying.'
    default:
      return 'Repeat this cartridge before classifying.'
  }
}

function guidanceSeverity(guidance?: string, sampleQuality?: string): 'success' | 'warning' | 'error' | 'info' {
  if (sampleQuality === 'repeat') return 'warning'
  if (!guidance) return 'info'
  if (guidance === 'ACCEPT_SINGLE_PASS') return 'success'
  if (guidance === 'REPEAT_INVALID_RATIO' || guidance === 'REPEAT_MEASUREMENT_QUALITY' || guidance === 'RESEAT_AND_REPEAT_SUSPECT_FAIL') return 'error'
  return 'warning'
}

function guidanceColor(guidance?: string): string {
  if (guidance === 'ACCEPT_SINGLE_PASS') return 'success.main'
  if (!guidance) return 'text.primary'
  if (guidance === 'REPEAT_INVALID_RATIO' || guidance === 'REPEAT_MEASUREMENT_QUALITY' || guidance === 'RESEAT_AND_REPEAT_SUSPECT_FAIL') return 'error.main'
  return 'warning.main'
}

function ratioColor(ratio?: number): string | undefined {
  if (typeof ratio !== 'number') return undefined
  if (ratio < 0.25) return 'success.main'
  if (ratio < 0.28) return 'warning.main'
  return 'error.main'
}

function historyResultLabel(result: CartridgeHistoryResult): string {
  switch (result) {
    case 'accept':
      return 'Accept'
    case 'borderline':
      return 'Borderline'
    case 'suspect':
      return 'Suspect'
    case 'repeat':
      return 'Repeat'
    default:
      return 'Unknown'
  }
}

function historyResultIcon(result: CartridgeHistoryResult) {
  if (result === 'accept') return <CheckCircleIcon color="success" fontSize="small" />
  if (result === 'suspect' || result === 'repeat') return <ErrorOutlineIcon color="error" fontSize="small" />
  if (result === 'borderline') return <WarningAmberIcon color="warning" fontSize="small" />
  return <InfoOutlinedIcon color="disabled" fontSize="small" />
}

function historyResultChipColor(result: CartridgeHistoryResult): 'default' | 'success' | 'warning' | 'error' {
  if (result === 'accept') return 'success'
  if (result === 'borderline') return 'warning'
  if (result === 'suspect' || result === 'repeat') return 'error'
  return 'default'
}

function historyResultColor(result: CartridgeHistoryResult): string {
  if (result === 'accept') return 'success.main'
  if (result === 'borderline') return 'warning.main'
  if (result === 'suspect' || result === 'repeat') return 'error.main'
  return 'text.primary'
}

function formatNumber(value?: number, digits = 3): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-'
}

function formatTimestamp(value?: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
