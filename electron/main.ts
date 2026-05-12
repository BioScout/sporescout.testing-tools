import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import log from 'electron-log'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type {
  CommandDispatchResult,
  ConnectionStatusEvent,
  ConnectRequest,
  GuiEventEnvelope,
  GuiResponseEnvelope,
  HistoricalRecordsQuery,
  LinearStageMode,
  LocalRunContext,
  OverrideRecord,
  UpdateCheckResult,
} from '../src/shared/contracts'
import {
  ENGINEERING_PASSWORD,
  LINEAR_STAGE_MOTION_COMMANDS,
  canonicalHardwareId,
  isEnclosureBaseId,
  isKnownOption,
  isNozzleId,
  isSealFixtureId,
  isTesterDeviceSerial,
  validateGuiCommand,
} from '../src/shared/contracts'
import { mirroredEventRecordFromEnvelope, parseSerialLine } from '../src/shared/serialParser'
import { MockSerialDevice } from './mockDevice'
import { LocalStorageStore } from './storage'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { autoUpdater } = electronUpdater

let mainWindow: BrowserWindow | null = null
let serialPort: SerialPort | null = null
let connectionMode: 'mock' | 'serial' | undefined
let mockDevice: MockSerialDevice | null = null
let store: LocalStorageStore
let activeRunContext: LocalRunContext | undefined
let solenoidRelockTimer: NodeJS.Timeout | undefined
let serialCommandQueue: Promise<unknown> = Promise.resolve()
let connectionGeneration = 0
let engineeringUnlocked = false
let linearStageRunInFlight: { command: string; startedAt: string } | undefined

interface PendingResponse {
  command: string
  generation: number
  resolve: (response: GuiResponseEnvelope) => void
  timeout: NodeJS.Timeout
  compactFallback?: GuiResponseEnvelope
  compactFallbackTimeout?: NodeJS.Timeout
}

const pendingResponses: PendingResponse[] = []
const LONG_SERIAL_RESPONSE_TIMEOUT_MS = 35 * 60 * 1000
const QUICK_SERIAL_RESPONSE_TIMEOUT_MS = 90 * 1000
const OVERSIZED_RESPONSE_LEGACY_GRACE_MS = 120 * 1000
const SOLENOID_RELOCK_MS = 45000

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 720,
    title: 'SporeScout Testing Tools',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  log.initialize()
  autoUpdater.logger = log
  autoUpdater.autoDownload = false
  store = new LocalStorageStore(app.getPath('userData'))
  activeRunContext = store.getActiveRunContext()
  if (validateRunContextAgainstSettings(activeRunContext)) {
    activeRunContext = undefined
    store.saveActiveRunContext(undefined)
  }
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  disconnectSerial()
  store?.close()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function registerIpcHandlers(): void {
  ipcMain.handle('runtime:getConfig', async () => ({
    serialBackend: 'electron' as const,
    exactSerialPort: process.env.SPORESCOUT_TESTING_TOOLS_EXACT_PORT?.trim() || undefined,
    appVersion: app.getVersion(),
  }))

  ipcMain.handle('serial:listPorts', async () => {
    const exactPort = process.env.SPORESCOUT_TESTING_TOOLS_EXACT_PORT?.trim()
    if (exactPort) {
      return [{
        path: exactPort,
        friendlyName: `${exactPort} (exact validation target)`,
      }]
    }

    const ports = await SerialPort.list()
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      friendlyName: [port.manufacturer, port.serialNumber].filter(Boolean).join(' ') || port.path,
    }))
  })

  ipcMain.handle('serial:connect', async (_event, value: unknown) => {
    const request = normalizeConnectRequest(value)
    if (!request) {
      return { ok: false, mode: 'serial' as const, error: 'Invalid serial connection request.' }
    }
    if (linearStageRunInFlight) {
      return {
        ok: false,
        mode: request.mode,
        path: request.path,
        error: `Cannot change tester connection while ${linearStageRunInFlight.command} is running.`,
      }
    }

    disconnectSerial()

    const exactPort = process.env.SPORESCOUT_TESTING_TOOLS_EXACT_PORT?.trim()
    if (request.mode === 'mock') {
      if (exactPort) {
        return {
          ok: false,
          mode: 'mock' as const,
          error: `Mock mode is disabled while this validation session is restricted to ${exactPort}.`,
        }
      }
      connectionMode = 'mock'
      mockDevice = new MockSerialDevice(emitSerialLine)
      connectionGeneration += 1
      emitConnectionStatus({ connected: true, mode: 'mock', message: 'Mock tester connected' })
      return { ok: true, mode: 'mock' as const }
    }

    if (!request.path) {
      return { ok: false, mode: 'serial' as const, error: 'No serial port selected.' }
    }

    if (exactPort && request.path.trim().toLowerCase() !== exactPort.toLowerCase()) {
      return {
        ok: false,
        mode: 'serial' as const,
        path: request.path,
        error: `This validation session is restricted to ${exactPort}.`,
      }
    }

    try {
      serialPort = new SerialPort({
        path: request.path,
        baudRate: request.baudRate ?? 115200,
        autoOpen: false,
      })

      await new Promise<void>((resolve, reject) => {
        serialPort?.open((error) => (error ? reject(error) : resolve()))
      })

      connectionGeneration += 1
      const openedPort = serialPort
      const generation = connectionGeneration
      const parser = openedPort.pipe(new ReadlineParser({ delimiter: '\n' }))
      parser.on('data', (line: string) => emitSerialLine(line, generation))
      openedPort.on('error', (error) => {
        emitSerialLine(`Serial error: ${error.message}`, generation)
        if (serialPort === openedPort && generation === connectionGeneration) {
          handleSerialConnectionLost(`Serial error: ${error.message}`)
        }
      })
      openedPort.on('close', () => {
        if (serialPort === openedPort && generation === connectionGeneration) {
          emitSerialLine('Serial connection closed', generation)
          handleSerialConnectionLost('Serial connection closed')
        }
      })
      connectionMode = 'serial'
      emitConnectionStatus({ connected: true, mode: 'serial', path: request.path, message: 'Serial tester connected' })

      return { ok: true, mode: 'serial' as const, path: request.path }
    } catch (error) {
      disconnectSerial()
      return {
        ok: false,
        mode: 'serial' as const,
        path: request.path,
        error: error instanceof Error ? error.message : 'Serial connection failed.',
      }
    }
  })

  ipcMain.handle('serial:disconnect', async () => {
    if (linearStageRunInFlight) {
      return { ok: false, error: `Cannot disconnect while ${linearStageRunInFlight.command} is running.` }
    }
    disconnectSerial()
    return { ok: true }
  })

  ipcMain.handle('serial:sendCommand', async (_event, command: unknown) => {
    if (typeof command !== 'string') {
      return { accepted: false, command: '', error: 'Invalid command.' } satisfies CommandDispatchResult
    }
    if (command.trim() === 'solenoid Lock') {
      clearSolenoidRelockTimer()
    }

    return await dispatchCommand(command)
  })

  ipcMain.handle('linearStage:arm', async (_event, context: unknown) => {
    if (linearStageRunInFlight) {
      return { ok: false, error: `Cannot arm another linear-stage run while ${linearStageRunInFlight.command} is running.` }
    }
    if (!isPlainRecord(context)) {
      return { ok: false, error: 'Linear-stage run context is required.' }
    }
    const normalizedContext = normalizeRunContext(context)
    if (normalizedContext?.workflow !== 'linear_stage') {
      return { ok: false, error: 'Linear-stage run context is required.' }
    }

    const armId = randomUUID()
    const armedAt = new Date().toISOString()
    const armedContext: LocalRunContext = {
      ...normalizedContext,
      stage_clear_confirmed: true,
      stage_clear_arm_id: armId,
      stage_clear_armed_at: armedAt,
    }
    const contextError = validateRunContextAgainstSettings(armedContext)
    if (contextError) {
      return { ok: false, error: contextError }
    }

    activeRunContext = armedContext
    try {
      store.saveActiveRunContext(activeRunContext)
    } catch (error) {
      emitSerialLine(`Local storage active context write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    return { ok: true, armId, armedAt }
  })

  ipcMain.handle('linearStage:run', async (_event, armId: unknown, command: unknown) => {
    if (typeof command !== 'string') {
      return { accepted: false, command: '', error: 'Invalid linear-stage command.' } satisfies CommandDispatchResult
    }
    if (linearStageRunInFlight) {
      return { accepted: false, command, error: `Cannot start another linear-stage run while ${linearStageRunInFlight.command} is running.` }
    }
    const expectedArmId = typeof armId === 'string' ? armId.trim() : ''
    if (
      !expectedArmId ||
      activeRunContext?.workflow !== 'linear_stage' ||
      activeRunContext.stage_clear_arm_id !== expectedArmId
    ) {
      return { accepted: false, command, error: 'Linear-stage run must consume a current stage-clear arm token.' }
    }

    const contextError = validateRunContextAgainstSettings(activeRunContext)
    if (contextError) {
      return { accepted: false, command, error: contextError }
    }

    const result = await dispatchCommand(command, { allowLinearStageMotion: true })
    if (!result.accepted) {
      activeRunContext = undefined
      try {
        store.saveActiveRunContext(undefined)
      } catch (error) {
        emitSerialLine(`Local storage active context write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    return result
  })

  ipcMain.handle('serial:unlockSolenoidForRemoval', async (_event, lockAfterMs?: number) => {
    if (!canUseTimedSolenoidUnlock()) {
      return {
        accepted: false,
        command: 'solenoid Unlock',
        error: 'Solenoid unlock requires engineering access or a completed cartridge test ready for removal.',
      } satisfies CommandDispatchResult
    }
    const result = await dispatchCommand('solenoid Unlock', { allowSolenoidUnlock: true })
    if (result.accepted && !result.timedOut && result.response?.ok === true) {
      scheduleSolenoidRelock(lockAfterMs)
    }
    return result
  })

  ipcMain.handle('storage:getSettings', async () => store.getSettings())
  ipcMain.handle('storage:saveSettings', async (_event, settings) => store.saveSettings(settings))
  ipcMain.handle('engineering:unlock', async (_event, password: string) => {
    engineeringUnlocked = password === ENGINEERING_PASSWORD
    return engineeringUnlocked ? { ok: true } : { ok: false, error: 'Engineering password did not match.' }
  })
  ipcMain.handle('storage:saveOverride', async (_event, override) => {
    if (!engineeringUnlocked) {
      throw new Error('Engineering access is required before saving overrides.')
    }
    store.saveOverride(normalizeOverrideRecord(override))
  })
  ipcMain.handle('storage:setActiveRunContext', async (_event, context?: unknown) => {
    if (context !== undefined && !isPlainRecord(context)) {
      throw new Error('Invalid active run context.')
    }
    if (context?.stage_clear_confirmed || context?.stage_clear_arm_id || context?.stage_clear_armed_at) {
      throw new Error('Stage-clear arming must use the dedicated linear-stage run control.')
    }
    const nextContext = normalizeRunContext(context)
    const contextError = validateRunContextAgainstSettings(nextContext)
    if (contextError) {
      throw new Error(contextError)
    }
    activeRunContext = nextContext
    try {
      store.saveActiveRunContext(activeRunContext)
    } catch (error) {
      emitSerialLine(`Local storage active context write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  })
  ipcMain.handle('storage:getActiveRunContext', async () => store.getActiveRunContext())
  ipcMain.handle('storage:getSummary', async () => store.getStorageSummary())
  ipcMain.handle('storage:getHistoricalRecords', async (_event, query?: HistoricalRecordsQuery) => store.getHistoricalRecords(query))
  ipcMain.handle('updates:check', async () => checkForUpdates())
}

async function dispatchCommand(
  command: string,
  options: { allowSolenoidUnlock?: boolean; allowLinearStageMotion?: boolean; allowEngineeringLinearStageMotion?: boolean } = {},
): Promise<CommandDispatchResult> {
  const policy = validateGuiCommand(command, activeRunContext, options)
  if (policy.ok === false) {
    return { accepted: false, command: policy.command, error: policy.error }
  }

  command = policy.command
  const auditContext = activeRunContext
  const linearStageMotionContext = policy.consumesLinearStageArm ? activeRunContext : undefined
  if (policy.consumesLinearStageArm) {
    consumeLinearStageMotionArm()
  }

  try {
    store.saveCommand(command, connectionMode ?? 'none', auditContext)
  } catch (error) {
    emitSerialLine(`Local storage command write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }

  const execute = async (): Promise<CommandDispatchResult> => {
    if (connectionMode === 'mock' && mockDevice) {
      const response = await mockDevice.send(command)
      return { accepted: true, command, response }
    }

    if (connectionMode !== 'serial' || !serialPort?.isOpen) {
      return { accepted: false, command, error: 'Serial device is not connected.' }
    }

    return enqueueSerialCommand(command, linearStageMotionContext)
  }

  return linearStageMotionContext ? runLinearStageCommandInFlight(command, execute) : execute()
}

async function runLinearStageCommandInFlight(command: string, execute: () => Promise<CommandDispatchResult>): Promise<CommandDispatchResult> {
  linearStageRunInFlight = { command, startedAt: new Date().toISOString() }
  try {
    return await execute()
  } finally {
    linearStageRunInFlight = undefined
  }
}

function enqueueSerialCommand(command: string, linearStageMotionContext?: LocalRunContext): Promise<CommandDispatchResult> {
  const generation = connectionGeneration
  const run = serialCommandQueue.then(
    () => sendSerialCommand(command, generation, linearStageMotionContext),
    () => sendSerialCommand(command, generation, linearStageMotionContext),
  )
  serialCommandQueue = run.catch(() => undefined)
  return run
}

function sendSerialCommand(command: string, generation: number, linearStageMotionContext?: LocalRunContext): Promise<CommandDispatchResult> {
  return new Promise((resolve) => {
    if (generation !== connectionGeneration || connectionMode !== 'serial' || !serialPort?.isOpen) {
      resolve({ accepted: false, command, error: 'Serial connection changed before command could be sent.' })
      return
    }

    if (linearStageMotionContext) {
      const writePolicy = validateGuiCommand(command, linearStageMotionContext, { allowLinearStageMotion: true })
      if (writePolicy.ok === false) {
        resolve({ accepted: false, command: writePolicy.command, error: writePolicy.error })
        return
      }
    }

    const timeout = setTimeout(() => {
      removePending(command, generation)
      resolve({ accepted: true, command, timedOut: true })
      disconnectSerial()
    }, serialResponseTimeoutMs(command))

    pendingResponses.push({
      command,
      generation,
      timeout,
      resolve: (response) => resolve({ accepted: true, command, response }),
    })

    serialPort?.write(`${command}\n`, (error) => {
      if (error) {
        removePending(command, generation)
        clearTimeout(timeout)
        resolve({ accepted: false, command, error: error.message })
      }
    })
  })
}

function emitSerialLine(line: string, generation?: number): void {
  if (generation !== undefined && generation !== connectionGeneration) {
    return
  }

  const trimmed = line.trim()
  mainWindow?.webContents.send('serial:line', trimmed)

  const parsed = parseSerialLine(trimmed)
  if (parsed.kind === 'gui-event' && parsed.envelope?.type === 'event') {
    const event = parsed.envelope as GuiEventEnvelope
    try {
      store.saveMirroredEvent(mirroredEventRecordFromEnvelope(event, trimmed, activeRunContext))
    } catch (error) {
      emitSerialLine(`Local storage event write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    mainWindow?.webContents.send('serial:event', event)
    return
  }

  if (parsed.kind === 'gui-response' && parsed.envelope?.type === 'response') {
    const response = parsed.envelope as GuiResponseEnvelope
    try {
      store.saveResponse(response, trimmed, activeRunContext)
    } catch (error) {
      emitSerialLine(`Local storage response write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    resolvePendingResponse(response, generation, 'gui')
    return
  }

  if (parsed.kind === 'legacy-response' && parsed.legacy) {
    try {
      store.saveResponse(parsed.legacy, trimmed, activeRunContext)
    } catch (error) {
      emitSerialLine(`Local storage response write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    resolvePendingResponse(parsed.legacy, generation, 'legacy')
  }
}

function resolvePendingResponse(response: GuiResponseEnvelope, generation?: number, source: 'gui' | 'legacy' = 'gui'): void {
  const index = pendingResponses.findIndex(
    (pending) => pending.command === response.command && (generation === undefined || pending.generation === generation),
  )
  if (index === -1) {
    return
  }

  const pending = pendingResponses[index]
  if (source === 'legacy' && isLinearStageMotionCommandText(response.command) && !pending.compactFallback) {
    return
  }

  if (shouldWaitForLegacyResponse(response)) {
    pending.compactFallback = response
    if (pending.compactFallbackTimeout) {
      clearTimeout(pending.compactFallbackTimeout)
    }
    pending.compactFallbackTimeout = setTimeout(() => {
      const fallbackIndex = pendingResponses.indexOf(pending)
      if (fallbackIndex === -1) return
      pendingResponses.splice(fallbackIndex, 1)
      clearPendingTimers(pending)
      pending.resolve(response)
    }, OVERSIZED_RESPONSE_LEGACY_GRACE_MS)
    return
  }

  const completedPending = pendingResponses.splice(index, 1)[0]
  clearPendingTimers(completedPending)
  completedPending.resolve(mergeCompactFallbackMetadata(response, completedPending.compactFallback))
}

function removePending(command: string, generation?: number): void {
  const index = pendingResponses.findIndex((pending) => pending.command === command && (generation === undefined || pending.generation === generation))
  if (index !== -1) {
    const [pending] = pendingResponses.splice(index, 1)
    clearPendingTimers(pending)
  }
}

function shouldWaitForLegacyResponse(response: GuiResponseEnvelope): boolean {
  return response.ok === true && response.result_omitted === true && response.result === undefined
}

function mergeCompactFallbackMetadata(response: GuiResponseEnvelope, compactFallback?: GuiResponseEnvelope): GuiResponseEnvelope {
  if (!compactFallback || response.result === undefined) {
    return response
  }

  return {
    ...response,
    firmware_version: response.firmware_version ?? compactFallback.firmware_version,
    device_id: response.device_id ?? compactFallback.device_id,
    product_id: response.product_id ?? compactFallback.product_id,
    timestamp_ms: response.timestamp_ms ?? compactFallback.timestamp_ms,
    result_json_bytes: response.result_json_bytes ?? compactFallback.result_json_bytes,
  }
}

function clearPendingTimers(pending: PendingResponse): void {
  clearTimeout(pending.timeout)
  if (pending.compactFallbackTimeout) {
    clearTimeout(pending.compactFallbackTimeout)
    pending.compactFallbackTimeout = undefined
  }
}

function disconnectSerial(): void {
  linearStageRunInFlight = undefined
  if (solenoidRelockTimer && serialPort?.isOpen) {
    serialPort.write('solenoid Lock\n')
  }
  clearSolenoidRelockTimer()
  connectionGeneration += 1
  for (const pending of pendingResponses.splice(0)) {
    clearPendingTimers(pending)
    pending.resolve({
      type: 'response',
      ok: false,
      command: pending.command,
      error: 'Serial device disconnected.',
    })
  }

  mockDevice = null
  connectionMode = undefined

  if (serialPort?.isOpen) {
    serialPort.close()
  }
  serialPort = null
  emitConnectionStatus({ connected: false, message: 'Serial device disconnected.' })
}

function handleSerialConnectionLost(message: string): void {
  if (connectionMode === undefined && serialPort === null) {
    return
  }

  linearStageRunInFlight = undefined
  clearSolenoidRelockTimer()
  connectionGeneration += 1
  for (const pending of pendingResponses.splice(0)) {
    clearPendingTimers(pending)
    pending.resolve({
      type: 'response',
      ok: false,
      command: pending.command,
      error: message,
    })
  }
  serialPort = null
  mockDevice = null
  connectionMode = undefined
  emitConnectionStatus({ connected: false, message })
}

function emitConnectionStatus(status: ConnectionStatusEvent): void {
  mainWindow?.webContents.send('serial:connectionStatus', status)
}

function scheduleSolenoidRelock(lockAfterMs?: number): void {
  clearSolenoidRelockTimer()
  const delayMs = typeof lockAfterMs === 'number' && Number.isFinite(lockAfterMs)
    ? Math.min(SOLENOID_RELOCK_MS, Math.max(1000, Math.trunc(lockAfterMs)))
    : SOLENOID_RELOCK_MS

  solenoidRelockTimer = setTimeout(() => {
    solenoidRelockTimer = undefined
    void dispatchCommand('solenoid Lock')
  }, delayMs)
}

function clearSolenoidRelockTimer(): void {
  if (solenoidRelockTimer) {
    clearTimeout(solenoidRelockTimer)
    solenoidRelockTimer = undefined
  }
}

function canUseTimedSolenoidUnlock(): boolean {
  if (engineeringUnlocked) {
    return true
  }
  if (!activeRunContext) {
    return true
  }
  return activeRunContext?.workflow === 'cartridge_subassembly' && activeRunContext.cartridge_phase === 'complete'
}

function serialResponseTimeoutMs(command: string): number {
  const normalized = command.trim().toLowerCase()
  if (
    isLinearStageMotionCommandText(command) ||
    normalized.startsWith('test cartridge_leak open ') ||
    normalized.startsWith('test cartridge_leak nozzle ') ||
    normalized.startsWith('test cartridge_leak sealed ')
  ) {
    return LONG_SERIAL_RESPONSE_TIMEOUT_MS
  }
  return QUICK_SERIAL_RESPONSE_TIMEOUT_MS
}

function isLinearStageMotionCommandText(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  return LINEAR_STAGE_MOTION_COMMANDS.some((candidate) => candidate === normalized)
}

function consumeLinearStageMotionArm(): void {
  if (!activeRunContext?.stage_clear_confirmed) {
    return
  }

  activeRunContext = { ...activeRunContext, stage_clear_confirmed: false }
  try {
    store?.saveActiveRunContext(activeRunContext)
  } catch (error) {
    emitSerialLine(`Local storage active context write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function normalizeConnectRequest(value: unknown): ConnectRequest | undefined {
  if (!isPlainRecord(value)) return undefined
  const mode = value.mode === 'mock' || value.mode === 'serial' ? value.mode : undefined
  if (!mode) return undefined
  const path = cleanContextValue(value.path)
  const baudRate = typeof value.baudRate === 'number' && Number.isFinite(value.baudRate) && value.baudRate > 0
    ? Math.trunc(value.baudRate)
    : undefined
  return { mode, path, baudRate }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeRunContext(context?: Record<string, unknown> | LocalRunContext): LocalRunContext | undefined {
  if (!context) return undefined
  const normalized: LocalRunContext = {
    operator: cleanContextValue(context.operator),
    batch: cleanContextValue(context.batch),
    station_id: cleanContextValue(context.station_id),
    tester_device_serial: cleanContextValue(context.tester_device_serial),
    enclosure_base_id: cleanContextValue(context.enclosure_base_id),
    nozzle_id: cleanContextValue(context.nozzle_id),
    seal_fixture_id: cleanContextValue(context.seal_fixture_id),
    cartridge_serial: cleanContextValue(context.cartridge_serial),
    run_uid: cleanContextValue(context.run_uid),
    workflow: cleanContextValue(context.workflow),
    cartridge_phase: normalizeCartridgePhase(context.cartridge_phase),
    linear_stage_run_id: cleanContextValue(context.linear_stage_run_id),
    linear_stage_mode: normalizeLinearStageMode(context.linear_stage_mode),
    stage_clear_confirmed: context.stage_clear_confirmed === true ? true : undefined,
    stage_clear_arm_id: cleanContextValue(context.stage_clear_arm_id),
    stage_clear_armed_at: cleanContextValue(context.stage_clear_armed_at),
  }
  const pruned = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value)) as LocalRunContext
  return Object.keys(pruned).length ? pruned : undefined
}

function validateRunContextAgainstSettings(context?: LocalRunContext): string | undefined {
  if (!context) return undefined
  const settings = store.getSettings()

  if (context.workflow && context.workflow !== 'cartridge_subassembly' && context.workflow !== 'linear_stage') {
    return 'Unknown workflow context.'
  }
  if (context.operator && !isKnownOption(context.operator, settings.operators)) {
    return 'Operator must be saved before a run can be armed.'
  }
  if (context.batch && !isKnownOption(context.batch, settings.batches)) {
    return 'Batch must be saved before a run can be armed.'
  }
  if (context.tester_device_serial && !settings.testerDeviceSerials.some((value) => canonicalHardwareId(value) === canonicalHardwareId(context.tester_device_serial ?? ''))) {
    return 'Tester serial must be saved before a run can be armed.'
  }
  if (context.enclosure_base_id && !settings.enclosureBaseIds.some((value) => canonicalHardwareId(value) === canonicalHardwareId(context.enclosure_base_id ?? ''))) {
    return 'Enclosure base ID must be saved before a cartridge run can be armed.'
  }
  if (context.nozzle_id && !settings.nozzleIds.some((value) => canonicalHardwareId(value) === canonicalHardwareId(context.nozzle_id ?? ''))) {
    return 'Nozzle ID must be saved before a cartridge run can be armed.'
  }
  if (context.seal_fixture_id && !settings.sealFixtureIds.some((value) => canonicalHardwareId(value) === canonicalHardwareId(context.seal_fixture_id ?? ''))) {
    return 'Seal ID must be saved before a cartridge run can be armed.'
  }

  if (context.workflow === 'cartridge_subassembly') {
    if (!context.operator || !context.batch || !isTesterDeviceSerial(context.tester_device_serial ?? '') || !isEnclosureBaseId(context.enclosure_base_id ?? '') || !isNozzleId(context.nozzle_id ?? '') || !isSealFixtureId(context.seal_fixture_id ?? '')) {
      return 'Cartridge workflow context is incomplete.'
    }
    if (context.cartridge_phase !== 'open' && (!context.run_uid || !context.cartridge_serial)) {
      return 'Cartridge continuation context requires a run_uid and cartridge serial.'
    }
  }

  if (context.workflow === 'linear_stage') {
    if (!context.operator || !context.batch || !isTesterDeviceSerial(context.tester_device_serial ?? '') || !context.linear_stage_run_id || !context.linear_stage_mode) {
      return 'Linear-stage workflow context is incomplete.'
    }
  }

  return undefined
}

function normalizeOverrideRecord(value: OverrideRecord): OverrideRecord {
  const id = cleanContextValue(value.id)
  const operator = cleanContextValue(value.operator)
  const action = cleanContextValue(value.action)
  const reason = value.reason?.trim()
  const createdAt = cleanContextValue(value.created_at)
  const settings = store.getSettings()

  if (!id || !operator || !action || !reason || reason.length < 4 || reason.length > 1000 || !createdAt) {
    throw new Error('Engineering override is incomplete.')
  }
  if (!isKnownOption(operator, settings.operators) && operator !== 'Engineering') {
    throw new Error('Engineering override operator must be saved first.')
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error('Engineering override timestamp is invalid.')
  }

  return {
    id,
    operator,
    action,
    reason,
    created_at: createdAt,
    run_uid: cleanContextValue(value.run_uid),
    cartridge_serial: cleanContextValue(value.cartridge_serial),
  }
}

function normalizeCartridgePhase(value?: unknown): LocalRunContext['cartridge_phase'] | undefined {
  return value === 'open' || value === 'nozzle' || value === 'sealed' || value === 'complete'
    ? value
    : undefined
}

function normalizeLinearStageMode(value?: unknown): LinearStageMode | undefined {
  return value === 'full' || value === 'mechanics' || value === 'optics' ? value : undefined
}

function cleanContextValue(value?: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 120 || hasControlCharacter(trimmed)) {
    return undefined
  }
  return trimmed
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127
  })
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const checked_at = new Date().toISOString()

  try {
    const update = await autoUpdater.checkForUpdates()
    const result: UpdateCheckResult = update?.updateInfo
      ? {
          checked_at,
          status: 'available',
          version: update.updateInfo.version,
          message: 'Update metadata was found. Install remains non-blocking.',
        }
      : {
          checked_at,
          status: 'current',
          version: app.getVersion(),
          message: 'No update metadata was returned.',
        }

    store.saveUpdateCheck(result)
    return result
  } catch (error) {
    const result: UpdateCheckResult = {
      checked_at,
      status: 'failed',
      version: app.getVersion(),
      message: error instanceof Error ? error.message : 'Update check failed.',
    }
    store.saveUpdateCheck(result)
    return result
  }
}
