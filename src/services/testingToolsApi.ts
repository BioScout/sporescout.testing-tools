import {
  CARTRIDGE_READINESS_COMMAND,
  CARTRIDGE_PROFILE_VERSION,
  DEFAULT_STATION_SETTINGS,
  ENGINEERING_PASSWORD,
  LINEAR_STAGE_MODE_COMMANDS,
  LINEAR_STAGE_MOTION_COMMANDS,
  LINEAR_STAGE_READINESS_COMMAND,
  linearStageModeForCommand,
  normalizeStationSettings,
  validateGuiCommand,
  type CommandDispatchResult,
  type ConnectionStatusEvent,
  type ConnectRequest,
  type ConnectionMode,
  type GuiEventEnvelope,
  type GuiResponseEnvelope,
  type HistoricalRecords,
  type HistoricalRecordsQuery,
  type LinearStageMode,
  type LocalRunContext,
  type MirroredEventRecord,
  type OverrideRecord,
  type SerialPortInfo,
  type StationSettings,
  type StoredCommandRecord,
  type StoredCommandResponseRecord,
  type StoredMirroredEventRecord,
  type TestingToolsApi,
} from '../shared/contracts'
import { formatGuiEvent, formatGuiResponse, mirroredEventRecordFromEnvelope, parseSerialLine } from '../shared/serialParser'

declare const __SPORESCOUT_APP_VERSION__: string

const BROWSER_SERIAL_CHOOSE_PATH = 'WEB_SERIAL_REQUEST'
const BROWSER_SERIAL_GRANTED_PREFIX = 'WEB_SERIAL_GRANTED_'
const DEFAULT_BAUD_RATE = 115200
const LONG_SERIAL_RESPONSE_TIMEOUT_MS = 35 * 60 * 1000
const QUICK_SERIAL_RESPONSE_TIMEOUT_MS = 90 * 1000
const OVERSIZED_RESPONSE_LEGACY_GRACE_MS = 120_000
const BROWSER_SETTINGS_KEY = 'sporescout.testing-tools.stationSettings'
const BROWSER_HISTORY_KEY = 'sporescout.testing-tools.history'
const BROWSER_ACTIVE_CONTEXT_KEY = 'sporescout.testing-tools.activeRunContext'
const BROWSER_APP_VERSION = __SPORESCOUT_APP_VERSION__

type BrowserSerialPortInfo = {
  usbVendorId?: number
  usbProductId?: number
}

type BrowserSerialPort = {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open: (options: { baudRate: number }) => Promise<void>
  close: () => Promise<void>
  getInfo?: () => BrowserSerialPortInfo
}

type BrowserSerial = {
  getPorts: () => Promise<BrowserSerialPort[]>
  requestPort: () => Promise<BrowserSerialPort>
}

type NavigatorWithSerial = Navigator & {
  serial?: BrowserSerial
}

type BrowserPendingResponse = {
  command: string
  generation: number
  resolve: (response: GuiResponseEnvelope) => void
  timeout: number
  compactFallback?: GuiResponseEnvelope
  compactFallbackTimeout?: number
}

export function getTestingToolsApi(): TestingToolsApi {
  return window.testingTools ?? browserApi
}

export function getDefaultConnectionMode(): ConnectionMode {
  return window.testingTools ? 'serial' : 'mock'
}

let settings: StationSettings = loadBrowserSettings()
let activeRunUid = ''
let activeCartridge = ''
let activeRunContext: LocalRunContext | undefined = loadBrowserActiveRunContext()
let runCounter = 0
let browserHistory: HistoricalRecords = loadBrowserHistory()
let browserEngineeringUnlocked = false
let browserConnectionMode: ConnectionMode | undefined
let browserSerialPort: BrowserSerialPort | null = null
let browserSerialReader: ReadableStreamDefaultReader<Uint8Array> | null = null
let browserSerialReadLoopActive = false
let browserSerialBuffer = ''
let grantedBrowserPorts: BrowserSerialPort[] = []
const lineListeners = new Set<(line: string) => void>()
const eventListeners = new Set<(event: GuiEventEnvelope) => void>()
const connectionStatusListeners = new Set<(status: ConnectionStatusEvent) => void>()
const browserPendingResponses: BrowserPendingResponse[] = []
let browserSolenoidRelockTimer: number | undefined
let browserSerialCommandQueue: Promise<unknown> = Promise.resolve()
let browserConnectionGeneration = 0

const browserApi: TestingToolsApi = {
  async listSerialPorts() {
    if (browserWebSerialEnabled()) {
      const serial = getBrowserSerial()
      if (serial) {
        grantedBrowserPorts = await serial.getPorts()
        return [
          ...grantedBrowserPorts.map((port, index) => browserPortInfo(port, index)),
          {
            path: BROWSER_SERIAL_CHOOSE_PATH,
            friendlyName: 'Choose serial port',
          },
        ]
      }
    }

    return [{ path: 'MOCK', friendlyName: 'Mock tester' }]
  },
  async connect(request: ConnectRequest) {
    await disconnectBrowserSerial()

    if (request.mode === 'serial') {
      if (browserWebSerialEnabled()) {
        return connectBrowserSerial(request)
      }
      return {
        ok: false,
        mode: 'serial',
        error: 'Browser preview is mock-only. Use the packaged Electron app for real serial hardware.',
      }
    }

    browserConnectionMode = 'mock'
    emitLine('Mock tester connected')
    emitConnectionStatus({ connected: true, mode: 'mock', message: 'Mock tester connected' })
    return { ok: true, mode: 'mock' }
  },
  async disconnect() {
    if (browserConnectionMode === 'serial') {
      await disconnectBrowserSerial()
      emitLine('Browser serial disconnected')
    } else {
      browserConnectionMode = undefined
      emitLine('Mock tester disconnected')
      emitConnectionStatus({ connected: false, message: 'Mock tester disconnected' })
    }

    return { ok: true }
  },
  async getRuntimeConfig() {
    return { serialBackend: 'browser', appVersion: BROWSER_APP_VERSION }
  },
  async sendCommand(command: string) {
    if (command.trim() === 'solenoid Lock') {
      clearBrowserSolenoidRelockTimer()
    }

    const policy = validateGuiCommand(command, activeRunContext)
    if (policy.ok === false) {
      return { accepted: false, command: policy.command, error: policy.error }
    }
    command = policy.command
    if (policy.consumesLinearStageArm) {
      consumeBrowserLinearStageMotionArm()
    }

    recordBrowserCommand(command, browserConnectionMode ?? 'none')

    if (browserConnectionMode === 'serial') {
      return sendBrowserSerialCommand(command)
    }

    if (browserConnectionMode !== 'mock') {
      return { accepted: false, command, error: 'Tester is not connected.' }
    }

    return sendBrowserMockCommand(command)
  },
  async armLinearStageTest(context: LocalRunContext) {
    const armId = crypto.randomUUID()
    const armedAt = new Date().toISOString()
    const nextContext = normalizeRunContext({
      ...context,
      stage_clear_confirmed: true,
      stage_clear_arm_id: armId,
      stage_clear_armed_at: armedAt,
    })
    const contextError = validateBrowserRunContextAgainstSettings(nextContext)
    if (contextError) {
      return { ok: false, error: contextError }
    }

    activeRunContext = nextContext
    saveBrowserActiveRunContext(activeRunContext)
    return { ok: true, armId, armedAt }
  },
  async runLinearStageTest(armId: string, command: string) {
    if (browserConnectionMode !== 'mock') {
      return { accepted: false, command, error: 'Browser preview can only run linear-stage tests in mock mode.' }
    }

    const expectedArmId = typeof armId === 'string' ? armId.trim() : ''
    if (
      !expectedArmId ||
      activeRunContext?.workflow !== 'linear_stage' ||
      activeRunContext.stage_clear_arm_id !== expectedArmId
    ) {
      return { accepted: false, command, error: 'Linear-stage run must consume a current stage-clear arm token.' }
    }

    const contextError = validateBrowserRunContextAgainstSettings(activeRunContext)
    if (contextError) {
      return { accepted: false, command, error: contextError }
    }

    const policy = validateGuiCommand(command, activeRunContext, { allowLinearStageMotion: true })
    if (policy.ok === false) {
      activeRunContext = undefined
      saveBrowserActiveRunContext(activeRunContext)
      return { accepted: false, command: policy.command, error: policy.error }
    }

    command = policy.command
    const auditContext = activeRunContext
    if (policy.consumesLinearStageArm) {
      consumeBrowserLinearStageMotionArm()
    }
    recordBrowserCommand(command, browserConnectionMode ?? 'none', auditContext)
    return sendBrowserMockCommand(command)
  },
  async getSettings() {
    return settings
  },
  async saveSettings(nextSettings: StationSettings) {
    settings = normalizeStationSettings(nextSettings)
    window.localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(settings))
    return settings
  },
  async unlockEngineering(password: string) {
    browserEngineeringUnlocked = password === ENGINEERING_PASSWORD
    return browserEngineeringUnlocked ? { ok: true } : { ok: false, error: 'Engineering password did not match.' }
  },
  async saveOverride(override: OverrideRecord) {
    if (!browserEngineeringUnlocked) {
      throw new Error('Engineering access is required before saving overrides.')
    }
    browserHistory = {
      ...browserHistory,
      overrides: [override, ...browserHistory.overrides],
    }
    saveBrowserHistory()
    return undefined
  },
  async setActiveRunContext(context?: LocalRunContext) {
    if (context?.stage_clear_confirmed || context?.stage_clear_arm_id || context?.stage_clear_armed_at) {
      throw new Error('Stage-clear arming must use the dedicated linear-stage run control.')
    }
    const nextContext = normalizeRunContext(context)
    const contextError = validateBrowserRunContextAgainstSettings(nextContext)
    if (contextError) {
      throw new Error(contextError)
    }
    activeRunContext = nextContext
    saveBrowserActiveRunContext(activeRunContext)
  },
  async getActiveRunContext() {
    return activeRunContext
  },
  async unlockSolenoidForRemoval(lockAfterMs?: number) {
    if (!canUseBrowserTimedSolenoidUnlock()) {
      return {
        accepted: false,
        command: 'solenoid Unlock',
        error: 'Solenoid unlock requires engineering access or a completed cartridge test ready for removal.',
      }
    }
    const policy = validateGuiCommand('solenoid Unlock', activeRunContext, { allowSolenoidUnlock: true })
    if (policy.ok === false) {
      return { accepted: false, command: policy.command, error: policy.error }
    }
    recordBrowserCommand(policy.command, browserConnectionMode ?? 'none')
    let result: CommandDispatchResult
    if (browserConnectionMode === 'serial') {
      result = await sendBrowserSerialCommand(policy.command)
    } else if (browserConnectionMode === 'mock') {
      result = await sendBrowserMockCommand(policy.command)
    } else {
      result = { accepted: false, command: policy.command, error: 'Tester is not connected.' }
    }
    if (result.accepted && !result.timedOut && result.response?.ok === true) {
      scheduleBrowserSolenoidRelock(lockAfterMs)
    }
    return result
  },
  async getStorageSummary() {
    return {
      databasePath: 'Browser preview only',
      jsonlPath: 'Browser preview only',
      eventCount: browserHistory.events.length,
      commandCount: browserHistory.commands.length,
      responseCount: browserHistory.responses.length,
      overrideCount: browserHistory.overrides.length,
    }
  },
  async getHistoricalRecords(query?: HistoricalRecordsQuery) {
    return filterBrowserHistory(query)
  },
  async checkForUpdates() {
    return {
      checked_at: new Date().toISOString(),
      status: 'failed',
      version: '0.1.0',
      message: 'Update checks run only in the packaged desktop app.',
    }
  },
  onSerialLine(callback: (line: string) => void) {
    lineListeners.add(callback)
    return () => lineListeners.delete(callback)
  },
  onDeviceEvent(callback: (event: GuiEventEnvelope) => void) {
    eventListeners.add(callback)
    return () => eventListeners.delete(callback)
  },
  onConnectionStatus(callback: (status: ConnectionStatusEvent) => void) {
    connectionStatusListeners.add(callback)
    return () => connectionStatusListeners.delete(callback)
  },
}

async function sendBrowserMockCommand(command: string): Promise<CommandDispatchResult> {
  const response = buildMockResponse(command)
  emitLine(formatGuiResponse(response))
  buildMockEvents(command).forEach((event) => emitLine(formatGuiEvent(event)))
  return { accepted: true, command, response }
}

async function connectBrowserSerial(request: ConnectRequest): Promise<{ ok: boolean; mode: ConnectionMode; path?: string; error?: string }> {
  const serial = getBrowserSerial()
  if (!serial) {
    return {
      ok: false,
      mode: 'serial',
      error: 'Browser Web Serial is not available. Use Microsoft Edge/Chrome or run the Electron app.',
    }
  }

  try {
    const port = resolveGrantedBrowserPort(request.path) ?? (await serial.requestPort())
    await port.open({ baudRate: request.baudRate ?? DEFAULT_BAUD_RATE })

    browserSerialPort = port
    browserConnectionMode = 'serial'
    browserConnectionGeneration += 1
    startBrowserSerialReadLoop(port, browserConnectionGeneration)
    emitLine('Browser serial connected')
    emitConnectionStatus({ connected: true, mode: 'serial', path: describeBrowserPort(port, request.path), message: 'Browser serial connected' })

    return {
      ok: true,
      mode: 'serial',
      path: describeBrowserPort(port, request.path),
    }
  } catch (error) {
    await disconnectBrowserSerial()
    return {
      ok: false,
      mode: 'serial',
      path: request.path,
      error: error instanceof Error ? error.message : 'Browser serial connection failed.',
    }
  }
}

async function sendBrowserSerialCommand(command: string): Promise<CommandDispatchResult> {
  const generation = browserConnectionGeneration
  const run = browserSerialCommandQueue.then(
    () => writeBrowserSerialCommand(command, generation),
    () => writeBrowserSerialCommand(command, generation),
  )
  browserSerialCommandQueue = run.catch(() => undefined)
  return run
}

async function writeBrowserSerialCommand(command: string, generation: number): Promise<CommandDispatchResult> {
  if (generation !== browserConnectionGeneration || !browserSerialPort?.writable) {
    return { accepted: false, command, error: 'Browser serial port is not connected.' }
  }

  const responsePromise = waitForBrowserSerialResponse(command, generation)
  const writer = browserSerialPort.writable.getWriter()

  try {
    if (generation !== browserConnectionGeneration) {
      removeBrowserPending(command, generation)
      return { accepted: false, command, error: 'Browser serial connection changed before write.' }
    }
    await writer.write(new TextEncoder().encode(`${command}\n`))
  } catch (error) {
    removeBrowserPending(command, generation)
    return {
      accepted: false,
      command,
      error: error instanceof Error ? error.message : 'Could not write to browser serial port.',
    }
  } finally {
    writer.releaseLock()
  }

  return responsePromise
}

function waitForBrowserSerialResponse(command: string, generation: number): Promise<CommandDispatchResult> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      removeBrowserPending(command, generation)
      resolve({ accepted: true, command, timedOut: true })
      void disconnectBrowserSerial()
    }, serialResponseTimeoutMs(command))

    browserPendingResponses.push({
      command,
      generation,
      timeout,
      resolve: (response) => {
        resolve({ accepted: true, command, response })
      },
    })
  })
}

function startBrowserSerialReadLoop(port: BrowserSerialPort, generation: number): void {
  if (browserSerialReadLoopActive || !port.readable) {
    return
  }

  browserSerialReadLoopActive = true
  void readBrowserSerial(port, generation)
}

async function readBrowserSerial(port: BrowserSerialPort, generation: number): Promise<void> {
  const decoder = new TextDecoder()

  try {
    while (browserSerialReadLoopActive && port.readable) {
      browserSerialReader = port.readable.getReader()
      try {
        for (;;) {
          const { value, done } = await browserSerialReader.read()
          if (done) {
            break
          }
          if (value) {
            appendBrowserSerialChunk(decoder.decode(value, { stream: true }), generation)
          }
        }
      } finally {
        browserSerialReader.releaseLock()
        browserSerialReader = null
      }
    }
  } catch (error) {
    if (browserSerialReadLoopActive) {
      emitLine(`Browser serial read error: ${error instanceof Error ? error.message : 'unknown error'}`, generation)
      if (generation === browserConnectionGeneration) {
        handleBrowserSerialConnectionLost(error instanceof Error ? error.message : 'Browser serial read error')
      }
    }
  } finally {
    if (browserConnectionMode === 'serial' && browserSerialReadLoopActive && generation === browserConnectionGeneration) {
      handleBrowserSerialConnectionLost('Browser serial connection closed.')
    }
    if (generation === browserConnectionGeneration) {
      browserSerialReadLoopActive = false
    }
  }
}

function handleBrowserSerialConnectionLost(message: string): void {
  browserConnectionMode = undefined
  browserConnectionGeneration += 1
  clearBrowserSolenoidRelockTimer()
  for (const pending of browserPendingResponses.splice(0)) {
    clearBrowserPendingTimers(pending)
    pending.resolve({
      type: 'response',
      ok: false,
      command: pending.command,
      error: message,
    })
  }
  browserSerialPort = null
  browserSerialReader = null
  browserSerialReadLoopActive = false
  emitConnectionStatus({ connected: false, mode: 'serial', message })
}

function appendBrowserSerialChunk(chunk: string, generation: number): void {
  if (generation !== browserConnectionGeneration) {
    return
  }
  browserSerialBuffer += chunk
  for (;;) {
    const newlineIndex = browserSerialBuffer.search(/\r?\n/)
    if (newlineIndex === -1) {
      return
    }

    const line = browserSerialBuffer.slice(0, newlineIndex)
    browserSerialBuffer = browserSerialBuffer.slice(browserSerialBuffer[newlineIndex] === '\r' ? newlineIndex + 2 : newlineIndex + 1)
    if (line.trim()) {
      emitLine(line, generation)
    }
  }
}

async function disconnectBrowserSerial(): Promise<void> {
  browserConnectionMode = undefined
  browserConnectionGeneration += 1
  clearBrowserSolenoidRelockTimer()
  for (const pending of browserPendingResponses.splice(0)) {
    clearBrowserPendingTimers(pending)
    pending.resolve({
      type: 'response',
      ok: false,
      command: pending.command,
      error: 'Browser serial port disconnected.',
    })
  }

  browserSerialReadLoopActive = false
  browserSerialBuffer = ''

  try {
    await browserSerialReader?.cancel()
  } catch {
    // Ignore cancellation errors while the port is already closing.
  }
  browserSerialReader = null

  const port = browserSerialPort
  browserSerialPort = null
  if (port) {
    try {
      await port.close()
    } catch {
      // Ignore close errors caused by an already-closed browser port.
    }
  }
  emitConnectionStatus({ connected: false, mode: 'serial', message: 'Browser serial disconnected' })
}

function emitConnectionStatus(status: ConnectionStatusEvent): void {
  connectionStatusListeners.forEach((listener) => listener(status))
}

function emitLine(line: string, generation?: number): void {
  if (generation !== undefined && generation !== browserConnectionGeneration) {
    return
  }

  lineListeners.forEach((listener) => listener(line))
  const parsed = parseSerialLine(line)
  if (parsed.kind === 'gui-event' && parsed.envelope?.type === 'event') {
    const event = parsed.envelope as GuiEventEnvelope
    recordBrowserEvent(event, line)
    eventListeners.forEach((listener) => listener(event))
    return
  }

  if (parsed.kind === 'gui-response' && parsed.envelope?.type === 'response') {
    const response = parsed.envelope as GuiResponseEnvelope
    recordBrowserResponse(response, line)
    resolveBrowserPendingResponse(response, generation)
    return
  }

  if (parsed.kind === 'legacy-response' && parsed.legacy) {
    recordBrowserResponse(parsed.legacy, line)
    resolveBrowserPendingResponse(parsed.legacy, generation)
  }
}

function resolveBrowserPendingResponse(response: GuiResponseEnvelope, generation?: number): void {
  const index = browserPendingResponses.findIndex(
    (pending) => pending.command === response.command && (generation === undefined || pending.generation === generation),
  )
  if (index === -1) {
    return
  }

  if (shouldWaitForLegacyResponse(response)) {
    const pending = browserPendingResponses[index]
    pending.compactFallback = response
    if (pending.compactFallbackTimeout !== undefined) {
      window.clearTimeout(pending.compactFallbackTimeout)
    }
    pending.compactFallbackTimeout = window.setTimeout(() => {
      const fallbackIndex = browserPendingResponses.indexOf(pending)
      if (fallbackIndex === -1) return
      browserPendingResponses.splice(fallbackIndex, 1)
      clearBrowserPendingTimers(pending)
      pending.resolve(response)
    }, OVERSIZED_RESPONSE_LEGACY_GRACE_MS)
    return
  }

  const pending = browserPendingResponses.splice(index, 1)[0]
  clearBrowserPendingTimers(pending)
  pending.resolve(mergeCompactFallbackMetadata(response, pending.compactFallback))
}

function removeBrowserPending(command: string, generation?: number): void {
  const index = browserPendingResponses.findIndex((pending) => pending.command === command && (generation === undefined || pending.generation === generation))
  if (index !== -1) {
    const [pending] = browserPendingResponses.splice(index, 1)
    clearBrowserPendingTimers(pending)
  }
}

function shouldWaitForLegacyResponse(response: GuiResponseEnvelope): boolean {
  return response.ok === true && response.result_omitted === true && response.result === undefined
}

function serialResponseTimeoutMs(command: string): number {
  const normalized = command.trim().toLowerCase()
  if (
    LINEAR_STAGE_MOTION_COMMANDS.some((candidate) => candidate === normalized) ||
    normalized.startsWith('test cartridge_leak open ') ||
    normalized.startsWith('test cartridge_leak nozzle ') ||
    normalized.startsWith('test cartridge_leak sealed ')
  ) {
    return LONG_SERIAL_RESPONSE_TIMEOUT_MS
  }
  return QUICK_SERIAL_RESPONSE_TIMEOUT_MS
}

function canUseBrowserTimedSolenoidUnlock(): boolean {
  if (browserEngineeringUnlocked) {
    return true
  }
  if (!activeRunContext) {
    return true
  }
  return activeRunContext?.workflow === 'cartridge_subassembly' && activeRunContext.cartridge_phase === 'complete'
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

function clearBrowserPendingTimers(pending: BrowserPendingResponse): void {
  window.clearTimeout(pending.timeout)
  if (pending.compactFallbackTimeout !== undefined) {
    window.clearTimeout(pending.compactFallbackTimeout)
    pending.compactFallbackTimeout = undefined
  }
}

function getBrowserSerial(): BrowserSerial | undefined {
  return (navigator as NavigatorWithSerial).serial
}

function browserWebSerialEnabled(): boolean {
  return false
}

function resolveGrantedBrowserPort(path?: string): BrowserSerialPort | undefined {
  if (!path?.startsWith(BROWSER_SERIAL_GRANTED_PREFIX)) {
    return undefined
  }

  const index = Number(path.slice(BROWSER_SERIAL_GRANTED_PREFIX.length))
  return Number.isInteger(index) ? grantedBrowserPorts[index] : undefined
}

function browserPortInfo(port: BrowserSerialPort, index: number): SerialPortInfo {
  return {
    path: `${BROWSER_SERIAL_GRANTED_PREFIX}${index}`,
    friendlyName: describeBrowserPort(port, `approved ${index + 1}`),
  }
}

function describeBrowserPort(port: BrowserSerialPort, fallback?: string): string {
  const info = port.getInfo?.()
  if (info?.usbVendorId || info?.usbProductId) {
    const vendor = info.usbVendorId?.toString(16).padStart(4, '0') ?? 'unknown'
    const product = info.usbProductId?.toString(16).padStart(4, '0') ?? 'unknown'
    return `Browser serial ${vendor}:${product}`
  }

  return fallback ?? 'Browser serial port'
}

function loadBrowserSettings(): StationSettings {
  try {
    const stored = window.localStorage.getItem(BROWSER_SETTINGS_KEY)
    return normalizeStationSettings(stored ? JSON.parse(stored) : DEFAULT_STATION_SETTINGS)
  } catch {
    return DEFAULT_STATION_SETTINGS
  }
}

function loadBrowserHistory(): HistoricalRecords {
  try {
    const stored = window.localStorage.getItem(BROWSER_HISTORY_KEY)
    if (!stored) return emptyHistory()
    const parsed = JSON.parse(stored) as Partial<HistoricalRecords>
    return {
      commands: parsed.commands ?? [],
      responses: parsed.responses ?? [],
      events: parsed.events ?? [],
      overrides: parsed.overrides ?? [],
    }
  } catch {
    return emptyHistory()
  }
}

function loadBrowserActiveRunContext(): LocalRunContext | undefined {
  try {
    const stored = window.localStorage.getItem(BROWSER_ACTIVE_CONTEXT_KEY)
    const context = normalizeRunContext(stored ? JSON.parse(stored) : undefined)
    if (validateBrowserRunContextAgainstSettings(context)) {
      window.localStorage.removeItem(BROWSER_ACTIVE_CONTEXT_KEY)
      return undefined
    }
    return context
  } catch {
    return undefined
  }
}

function saveBrowserActiveRunContext(context?: LocalRunContext): void {
  try {
    if (!context) {
      window.localStorage.removeItem(BROWSER_ACTIVE_CONTEXT_KEY)
      return
    }
    window.localStorage.setItem(BROWSER_ACTIVE_CONTEXT_KEY, JSON.stringify(context))
  } catch {
    // Browser preview recovery is best-effort; Electron persists this state in SQLite.
  }
}

function emptyHistory(): HistoricalRecords {
  return { commands: [], responses: [], events: [], overrides: [] }
}

function filterBrowserHistory(query: HistoricalRecordsQuery = {}): HistoricalRecords {
  const limit = clampHistoryLimit(query.limit)
  const offset = Math.max(0, Math.trunc(query.offset ?? 0))
  const runFilter = query.runUid?.trim()
  const cartridgeFilter = query.cartridgeSerial?.trim()
  const workflowFilter = query.workflow?.trim()
  const linearStageRunIdFilter = query.linearStageRunId?.trim()
  const textFilter = query.text?.trim().toLowerCase()
  const events = browserHistory.events.filter((event) => {
    if (runFilter && event.run_uid !== runFilter && event.record.run_uid !== runFilter) {
      return false
    }
    if (linearStageRunIdFilter && !JSON.stringify(event).includes(linearStageRunIdFilter)) {
      return false
    }
    if (
      cartridgeFilter &&
      event.cartridge_serial !== cartridgeFilter &&
      event.record.cartridge_serial !== cartridgeFilter
    ) {
      return false
    }
    if (workflowFilter && !browserEventMatchesWorkflow(event, workflowFilter)) {
      return false
    }
    if (textFilter && !JSON.stringify(event).toLowerCase().includes(textFilter)) {
      return false
    }
    return true
  })
  const commands = browserHistory.commands.filter((command) => recordMatchesHistoryQuery(`${command.command} ${JSON.stringify(command)}`, { runFilter, cartridgeFilter, workflowFilter, linearStageRunIdFilter, textFilter }))
  const responses = browserHistory.responses.filter((response) => recordMatchesHistoryQuery(`${response.command} ${JSON.stringify(response)}`, { runFilter, cartridgeFilter, workflowFilter, linearStageRunIdFilter, textFilter }))
  const overrides = browserHistory.overrides.filter((override) => recordMatchesHistoryQuery(JSON.stringify(override), { runFilter, cartridgeFilter, workflowFilter, linearStageRunIdFilter, textFilter }))

  return {
    commands: commands.slice(offset, offset + limit),
    responses: responses.slice(offset, offset + limit),
    events: events.slice(offset, offset + limit),
    overrides: overrides.slice(offset, offset + limit),
  }
}

function browserEventMatchesWorkflow(event: StoredMirroredEventRecord, workflow: string): boolean {
  const normalizedWorkflow = workflow.toLowerCase()
  const serialized = JSON.stringify(event).toLowerCase()
  if (serialized.includes(normalizedWorkflow)) return true
  if (normalizedWorkflow !== 'cartridge_subassembly') return false

  return (
    event.event_name === 'dd_cartridge_air_leak_summary' ||
    serialized.includes('cartridge_subassembly') ||
    serialized.includes('cartridge_leak') ||
    (event.event_name === 'dd_test_step_result' && serialized.includes('cartridge_serial'))
  )
}

function recordMatchesHistoryQuery(
  text: string,
  filters: { runFilter?: string; cartridgeFilter?: string; workflowFilter?: string; linearStageRunIdFilter?: string; textFilter?: string },
): boolean {
  const normalized = text.toLowerCase()
  if (filters.workflowFilter === 'linear_stage' && !(/test step|test linear_stage|linear_stage|linear-stage|linear/i.test(text))) {
    return false
  }
  if (filters.runFilter && !text.includes(filters.runFilter)) return false
  if (filters.linearStageRunIdFilter && !text.includes(filters.linearStageRunIdFilter)) return false
  if (filters.cartridgeFilter && !text.includes(filters.cartridgeFilter)) return false
  if (filters.textFilter && !normalized.includes(filters.textFilter)) return false
  return true
}

function clampHistoryLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 500
  }
  return Math.min(10000, Math.max(25, Math.trunc(limit)))
}

function saveBrowserHistory(): void {
  try {
    window.localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(browserHistory))
    return
  } catch (error) {
    browserHistory = {
      commands: browserHistory.commands.slice(0, 200),
      responses: browserHistory.responses.slice(0, 100).map(compactBrowserResponseRecord),
      events: browserHistory.events.slice(0, 200),
      overrides: browserHistory.overrides.slice(0, 100),
    }
    try {
      window.localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(browserHistory))
    } catch (retryError) {
      console.warn('Browser preview history storage is full; latest records are kept in memory only.', retryError ?? error)
    }
  }
}

function compactBrowserResponseRecord(record: StoredCommandResponseRecord): StoredCommandResponseRecord {
  const responseJson = JSON.stringify(record.response)
  const rawLine = record.raw_line && record.raw_line.length > 2048
    ? `${record.raw_line.slice(0, 2048)}...[truncated for browser preview storage]`
    : record.raw_line

  if (responseJson.length <= 100_000) {
    return { ...record, raw_line: rawLine }
  }

  return {
    ...record,
    raw_line: rawLine,
    response: {
      ...record.response,
      result: undefined,
      result_omitted: true,
      result_json_bytes: record.response.result_json_bytes ?? responseJson.length,
      message: record.response.message ?? 'Large response compacted for browser preview storage.',
    },
  }
}

function recordBrowserCommand(command: string, mode: string, context: LocalRunContext | undefined = activeRunContext): void {
  const record: StoredCommandRecord = {
    id: crypto.randomUUID(),
    command,
    mode,
    sent_at: new Date().toISOString(),
    context,
    run_uid: context?.run_uid,
    cartridge_serial: context?.cartridge_serial,
    workflow: context?.workflow,
    linear_stage_run_id: context?.linear_stage_run_id,
  }
  browserHistory = {
    ...browserHistory,
    commands: [record, ...browserHistory.commands],
  }
  saveBrowserHistory()
}

function recordBrowserResponse(response: GuiResponseEnvelope, rawLine?: string): void {
  const record: StoredCommandResponseRecord = {
    id: crypto.randomUUID(),
    command: response.command,
    ok: response.ok,
    response,
    raw_line: rawLine,
    received_at: new Date().toISOString(),
    context: activeRunContext,
    run_uid: activeRunContext?.run_uid,
    cartridge_serial: activeRunContext?.cartridge_serial,
    workflow: activeRunContext?.workflow,
    linear_stage_run_id: activeRunContext?.linear_stage_run_id,
  }
  browserHistory = {
    ...browserHistory,
    responses: [record, ...browserHistory.responses],
  }
  saveBrowserHistory()
}

function recordBrowserEvent(event: GuiEventEnvelope, rawLine?: string): void {
  const mirroredRecord = mirroredEventRecordFromEnvelope(event, rawLine, activeRunContext, BROWSER_APP_VERSION) as MirroredEventRecord
  const record: StoredMirroredEventRecord = {
    id: mirroredRecord.event_id,
    event_name: event.event_name,
    record: mirroredRecord,
    run_uid: mirroredRecord.run_uid,
    cartridge_serial: mirroredRecord.cartridge_serial,
    workflow: mirroredRecord.workflow,
    linear_stage_run_id: mirroredRecord.linear_stage_run_id,
    linear_stage_mode: mirroredRecord.linear_stage_mode,
    app_version: mirroredRecord.app_version,
    created_at: mirroredRecord.local_timestamp,
    upload_status: mirroredRecord.upload_status,
  }
  browserHistory = {
    ...browserHistory,
    events: [record, ...browserHistory.events],
  }
  saveBrowserHistory()
}

function buildMockResponse(command: string): GuiResponseEnvelope {
  const base = {
    type: 'response' as const,
    ok: true,
    command,
    device_id: 'MOCK-BROWSER-001',
    product_id: 33608,
    firmware_version: 5383001,
    timestamp_ms: Date.now(),
  }

  if (command === 'system GetFirmwareVersion') {
    return { ...base, result: 5383001 }
  }
  if (command === CARTRIDGE_READINESS_COMMAND) {
    return { ...base, result: buildBrowserReadinessResult(base.firmware_version) }
  }
  if (command === LINEAR_STAGE_READINESS_COMMAND || command === 'test linear_stage readiness' || command === 'test step prepare' || command === 'test step readiness') {
    return { ...base, result: buildBrowserLinearStageReadinessResult(base.firmware_version) }
  }
  if (command.includes('solenoid IsUnlocked')) {
    return { ...base, result: false }
  }
  if (command.includes('IsConnected') || command.includes('IsLocked')) {
    return { ...base, result: true }
  }
  if (command.includes('GetIdleState')) {
    return { ...base, result: 'idle' }
  }
  if (command.includes('self_check')) {
    return { ...base, result: { passed: true } }
  }
  if (command.startsWith('test cartridge_leak open ')) {
    const parts = command.split(/\s+/)
    activeCartridge = parts[3]
    runCounter += 1
    activeRunUid = `browser-run-${String(runCounter).padStart(4, '0')}`
    return {
      ...base,
      result: {
        run_uid: activeRunUid,
        cartridge_serial: activeCartridge,
        profile_version: CARTRIDGE_PROFILE_VERSION,
      },
    }
  }
  if (command.startsWith('test cartridge_leak nozzle ')) {
    return { ...base, result: { run_uid: activeRunUid, phase: 'nozzle' } }
  }
  if (command.startsWith('test cartridge_leak sealed ')) {
    return { ...base, result: { run_uid: activeRunUid, phase: 'sealed' } }
  }
  if (isLinearStageTestCommand(command)) {
    return { ...base, result: buildMockLinearStageResult(command) }
  }

  return { ...base, result: 'ok' }
}

function buildBrowserReadinessResult(firmwareVersion: number) {
  return {
    command: 'cartridge_leak prepare',
    readiness_mode: 'prepare',
    firmware_version: firmwareVersion,
    hardware_version: 'browser-mock',
    ready: true,
    status: 'READY',
    operator_action: 'Ready to start: test cartridge_leak open <cartridge_serial> <fixture_id> phase1-characterization',
    solenoid_lock_check_deferred: 0,
    checks: {
      active_run_clear: { ok: true, skipped: false, message: 'no active cartridge_leak run' },
      idle_state: { ok: true, skipped: false, message: 'firmware state is Idle', detail: { current_state: 'Idle' } },
      station_self_check: { ok: true, skipped: false, message: 'station self-check passed' },
      tester_power: { ok: true, skipped: false, message: '24V Aux is in range', detail: { aux24_v: 24.1 } },
      cm4_ready: {
        ok: true,
        skipped: false,
        message: 'CM4 is available',
        detail: { available: true, cm4_state: 'Available', aux_5v_rail_state: 'Enabled', aux5_v: 5.1 },
      },
      cm4_power: { ok: true, skipped: false, message: 'tester computer power is ready' },
      solenoid_locked: { ok: true, skipped: false, message: 'locked' },
    },
  }
}

function buildBrowserLinearStageReadinessResult(firmwareVersion: number) {
  return {
    command: 'linear_stage prepare',
    readiness_mode: 'prepare',
    firmware_version: firmwareVersion,
    hardware_version: 'browser-mock',
    ready: 1,
    status: 'READY',
    operator_action: 'Ready to start: test linear_stage full',
    check_idle_state: 1,
    check_station_boot_ready: 1,
    check_cm4_power: 1,
    cm4_power_enable_attempted: false,
    check_cm4_ready: 1,
    cm4_enable_requested: false,
    check_tester_power: 1,
    tester_power_enable_attempted: false,
    check_steppers_power: 1,
    steppers_power_enable_attempted: false,
  }
}

function buildMockEvents(command: string): GuiEventEnvelope[] {
  if (command.startsWith('test cartridge_leak open ')) {
    return [measurementEvent('open', 2.68)]
  }
  if (command.startsWith('test cartridge_leak nozzle ')) {
    return [measurementEvent('nozzle', 2.54)]
  }
  if (command.startsWith('test cartridge_leak sealed ')) {
    return [
      measurementEvent('sealed', 0.34),
      {
        type: 'event',
        event_name: 'dd_cartridge_air_leak_summary',
        device_id: 'MOCK-BROWSER-001',
        product_id: 33608,
        firmware_version: 5383001,
        timestamp_ms: Date.now(),
        data: {
          run_uid: activeRunUid,
          cartridge_serial: activeCartridge,
          profile_version: CARTRIDGE_PROFILE_VERSION,
          open_slpm: 2.68,
          nozzle_slpm: 2.54,
          sealed_slpm: 0.34,
          sealed_open_ratio: 0.127,
          sample_quality: 'acceptable',
          guidance: 'ACCEPT_SINGLE_PASS',
        },
      },
    ]
  }
  if (isLinearStageTestCommand(command)) {
    return buildMockLinearStageEvents(command)
  }

  return []
}

function isLinearStageTestCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  if (/\s(prepare|readiness|status)$/.test(trimmed)) {
    return false
  }
  return LINEAR_STAGE_MOTION_COMMANDS.some((candidate) => candidate.toLowerCase() === trimmed)
}

function buildMockLinearStageResult(command: string): Record<string, unknown> {
  const mode = mockLinearStageMode(command)
  const productionProfile = mode === 'full' || command.toLowerCase().includes('production') || command.toLowerCase().includes('step')
  const deploymentProfile = command.toLowerCase().includes('deployment')
  const profile = deploymentProfile ? 'deployment' : productionProfile ? 'production' : mode
  const includeMechanical = mode === 'full' || mode === 'mechanics'
  const includeOptics = mode === 'full' || mode === 'optics'
  const detail: Record<string, unknown> = {}
  let number = 1

  const addStep = (name: string, expected: unknown, measured: unknown, result: 'Pass' | 'Warn' | 'Fail' = 'Pass') => {
    detail[`${String(number).padStart(2, '0')} | ${name}`] = {
      Expected: expected,
      Measured: measured,
      Result: result,
    }
    number += 1
  }

  addStep(
    'Check dependencies',
    {
      '5V Aux Voltage': '4.75-5.25 V',
      'Pi Available': true,
      '24V Aux Voltage': '23-25 V',
      'Steppers Load Switch': 'Connected',
    },
    {
      '5V Aux Voltage': '5.08 V',
      'Pi Available': true,
      '24V Aux Voltage': '24.18 V',
      'Steppers Load Switch': 'Connected',
    },
  )
  addStep(
    'CM4 task running',
    { 'CM4 progress event': 'reported' },
    {
      Source: 'CM4 task progress',
      Status: 'running',
      Phase: 'cm4_task',
      Mode: mode,
      'Progress sequence': 1,
    },
    'Warn',
  )
  addStep('Initialise Steppers', { Profile: profile, 'Steppers initialised': true }, 'Steppers initialised and enabled')

  const axes = [
    { axis: 'X', span: 182.42, delta: 0.08, repeat: 0.012, response: 0.91, focus: 0.44, current: 420 },
    { axis: 'Y', span: 74.96, delta: -0.04, repeat: 0.009, response: 0.88, focus: 0.39, current: 390 },
    { axis: 'Z', span: 38.02, delta: 0.03, repeat: 0.007, response: 0.82, focus: 0.33, current: 360 },
  ]

  for (const item of axes) {
    if (includeMechanical) {
      addStep(
        `${item.axis} home switch qualification`,
        { 'Home switch leave/re-enter': true },
        {
          Passed: true,
          'Release mm': Number((item.repeat * 5).toFixed(3)),
          'Re-entry mm': Number((item.repeat * 4).toFixed(3)),
          'Repeatability mm': item.repeat,
        },
      )
      addStep(
        `${item.axis} positive boundary qualification`,
        { 'Boundary kind': item.axis === 'X' ? 'front_limit' : 'travel_limit', 'Boundary event detected': true },
        {
          Kind: item.axis === 'X' ? 'front_limit' : 'travel_limit',
          Passed: true,
          'Boundary event detected': true,
          'Stop position mm': Number((item.span + 0.12).toFixed(3)),
          'Repeatability mm': Number((item.repeat * 1.5).toFixed(3)),
        },
      )
      addStep(
        `${item.axis} span qualification`,
        { 'Within calibrated span window': true, 'Expected span mm': item.span },
        {
          Passed: true,
          'Expected span mm': item.span,
          'Measured span mm': Number((item.span + item.delta).toFixed(3)),
          'Delta mm': item.delta,
          'Within window': true,
          'Repeatability mm': Number((item.repeat * 1.2).toFixed(3)),
        },
      )
    }
    if (includeMechanical) {
      addStep(
        `${item.axis} derated current margin`,
        { 'Derated current run': true, 'Derating factor': 0.5 },
        {
          Passed: true,
          'Configured current': item.current,
          'Derated current': Math.round(item.current * 0.5),
          'Derating factor': 0.5,
        },
      )
      if (item.axis === 'X') {
        addStep(
          'X front-limit diagnosis',
          { 'Front-limit diagnostic completed': true },
          {
            Passed: true,
            'Front-limit edge mm': Number((item.span + 0.08).toFixed(3)),
            'Repeatability mm': Number((item.repeat * 1.4).toFixed(3)),
          },
        )
      }
    }
  }

  if (includeOptics) {
    addStep(
      'Select optical region',
      { 'Optical region selected': true },
      {
        Passed: true,
        'Selected Y mm': 37.42,
        'Selected Z mm': 19.14,
        'Focus score': 0.76,
        'Artifact scan id': `mock-scan-${activeRunContext?.linear_stage_run_id ?? 'browser'}`,
      },
    )
    addStep(
      '3x3 scan audit',
      { '3x3 scan audit': true, 'Repeated frames detected': false, 'Monotonic Y passed': true, 'Monotonic Z passed': true, 'Focus passed': true },
      {
        Passed: true,
        'Repeated frames detected': false,
        'Monotonic Y passed': true,
        'Monotonic Z passed': true,
        'Focus passed': true,
        'Frame count': 9,
        'Minimum focus score': 0.73,
        'Artifact scan id': `mock-grid-${activeRunContext?.linear_stage_run_id ?? 'browser'}`,
      },
    )
    for (const item of axes) {
      addStep(
        `${item.axis} optical qualification`,
        { 'Optical response': true },
        {
          Passed: true,
          'Expected step mm': 1.0,
          'Mean shift px': Number((18 + Math.abs(item.delta) * 10).toFixed(2)),
          'Minimum response': item.response,
          'Focus score range': item.focus,
          'Image artifact id': `mock-${item.axis.toLowerCase()}-image-${activeRunContext?.linear_stage_run_id ?? 'browser'}`,
        },
      )
    }
  }

  addStep('Park Steppers', 'Steppers parked', 'Parked')

  return {
    Name: `LINEAR_STAGE_${mode.toUpperCase()}_TEST`,
    IotId: 'MOCK-BROWSER-001',
    SuiteId: 0,
    Result: 1,
    mode,
    linear_stage_mode: mode,
    linear_stage_run_id: activeRunContext?.linear_stage_run_id,
    Profile: profile,
    Detail: detail,
  }
}

function buildMockLinearStageEvents(command: string): GuiEventEnvelope[] {
  const result = buildMockLinearStageResult(command)
  const mode = mockLinearStageMode(command)
  return [
    {
      type: 'event',
      event_name: 'dd_test_step_result',
      device_id: 'MOCK-BROWSER-001',
      product_id: 33608,
      firmware_version: 5383001,
      timestamp_ms: Date.now(),
      data: {
        test_name: result.Name,
        step_name: 'Check dependencies',
        result: 'Pass',
        mode,
        linear_stage_mode: mode,
        linear_stage_run_id: activeRunContext?.linear_stage_run_id,
      },
    },
    {
      type: 'event',
      event_name: 'dd_test_item_update',
      device_id: 'MOCK-BROWSER-001',
      product_id: 33608,
      firmware_version: 5383001,
      timestamp_ms: Date.now(),
      data: {
        test_name: result.Name,
        command,
        result: 'Pass',
        mode,
        linear_stage_mode: mode,
        profile: result.Profile,
        linear_stage_run_id: activeRunContext?.linear_stage_run_id,
        detail: result.Detail,
      },
    },
    {
      type: 'event',
      event_name: 'dd_linear_stage_summary',
      device_id: 'MOCK-BROWSER-001',
      product_id: 33608,
      firmware_version: 5383001,
      timestamp_ms: Date.now(),
      data: {
        test_name: result.Name,
        command,
        result: 'Pass',
        mode,
        linear_stage_mode: mode,
        linear_stage_run_id: activeRunContext?.linear_stage_run_id,
        step_count: Object.keys(result.Detail as Record<string, unknown>).length,
        failed_steps: 0,
        artifacts: {
          scan_id: `mock-grid-${activeRunContext?.linear_stage_run_id ?? 'browser'}`,
        },
      },
    },
  ]
}

function mockLinearStageMode(command: string): LinearStageMode {
  const canonical = linearStageModeForCommand(command)
  if (canonical) return canonical
  const normalized = command.trim().toLowerCase()
  if (normalized === LINEAR_STAGE_MODE_COMMANDS.mechanics || normalized.includes('mechanics')) return 'mechanics'
  if (normalized === LINEAR_STAGE_MODE_COMMANDS.optics || normalized.includes('optics')) return 'optics'
  return 'full'
}

function measurementEvent(phase: 'open' | 'nozzle' | 'sealed', slpm: number): GuiEventEnvelope {
  const samples = buildBrowserMockSamples(slpm)
  return {
    type: 'event',
    event_name: 'dd_test_step_result',
    device_id: 'MOCK-BROWSER-001',
    product_id: 33608,
    firmware_version: 5383001,
    timestamp_ms: Date.now(),
    data: {
      step_name: `MEASURE_${phase.toUpperCase()}_INLET`,
      run_uid: activeRunUid,
      cartridge_serial: activeCartridge,
      profile_version: CARTRIDGE_PROFILE_VERSION,
      phase,
      slpm,
      raw_mean_slpm: Number((slpm * 1.006).toFixed(3)),
      median_slpm: Number((slpm * 0.998).toFixed(3)),
      stddev_slpm: Number((slpm * 0.018).toFixed(3)),
      min_slpm: Number((slpm * 0.953).toFixed(3)),
      max_slpm: Number((slpm * 1.046).toFixed(3)),
      trimmed_count: 24,
      outlier_count: 6,
      coefficient_of_variation: 0.018,
      sample_quality: 'acceptable',
      artifacts: {
        measurement: {
          valid: true,
          sample_count: 30,
          flow_slpm_mean: slpm,
          flow_slpm_raw_mean: Number((slpm * 1.006).toFixed(3)),
          flow_slpm_median: Number((slpm * 0.998).toFixed(3)),
          flow_slpm_stddev: Number((slpm * 0.018).toFixed(3)),
          flow_slpm_min: Math.min(...samples),
          flow_slpm_max: Math.max(...samples),
          trimmed_sample_count: 24,
          outlier_count: 6,
          coefficient_of_variation: 0.018,
          stability_limit_slpm: Number(Math.max(0.04, slpm * 0.05).toFixed(3)),
          quality_ok: true,
          fan_pwm_pct: 100,
          rpm: 17600,
          pressure_hpa: 1012.4,
          temperature_c: 23.8,
          environment_source: 'BROWSER_MOCK',
          settle_ms: 12000,
          dt_ms: 100,
          flow_slpm_samples: samples,
        },
      },
      settle_ms: 12000,
      dt_ms: 100,
    },
  }
}

function buildBrowserMockSamples(slpm: number): number[] {
  return Array.from({ length: 30 }, (_value, index) => {
    const wave = Math.sin(index * 0.9) * slpm * 0.018
    const offset = (index % 5) * slpm * 0.002
    return Number((slpm + wave + offset).toFixed(3))
  })
}

function scheduleBrowserSolenoidRelock(lockAfterMs?: number): void {
  clearBrowserSolenoidRelockTimer()
  const delayMs = typeof lockAfterMs === 'number' && Number.isFinite(lockAfterMs)
    ? Math.min(45000, Math.max(1000, Math.trunc(lockAfterMs)))
    : 45000
  browserSolenoidRelockTimer = window.setTimeout(() => {
    browserSolenoidRelockTimer = undefined
    void browserApi.sendCommand('solenoid Lock')
  }, delayMs)
}

function clearBrowserSolenoidRelockTimer(): void {
  if (browserSolenoidRelockTimer !== undefined) {
    window.clearTimeout(browserSolenoidRelockTimer)
    browserSolenoidRelockTimer = undefined
  }
}

function consumeBrowserLinearStageMotionArm(): void {
  if (activeRunContext?.stage_clear_confirmed) {
    activeRunContext = { ...activeRunContext, stage_clear_confirmed: false }
    saveBrowserActiveRunContext(activeRunContext)
  }
}

function validateBrowserRunContextAgainstSettings(context?: LocalRunContext): string | undefined {
  if (!context) return undefined

  if (context.workflow && context.workflow !== 'cartridge_subassembly' && context.workflow !== 'linear_stage') {
    return 'Unknown workflow context.'
  }
  if (context.operator && !settings.operators.some((value) => value.trim() === context.operator)) {
    return 'Operator must be saved before a run can be armed.'
  }
  if (context.batch && !settings.batches.some((value) => value.trim() === context.batch)) {
    return 'Batch must be saved before a run can be armed.'
  }
  if (context.tester_device_serial && !settings.testerDeviceSerials.some((value) => value.trim().toUpperCase() === context.tester_device_serial?.toUpperCase())) {
    return 'Tester serial must be saved before a run can be armed.'
  }
  if (context.enclosure_base_id && !settings.enclosureBaseIds.some((value) => value.trim().toUpperCase() === context.enclosure_base_id?.toUpperCase())) {
    return 'Enclosure base ID must be saved before a cartridge run can be armed.'
  }
  if (context.nozzle_id && !settings.nozzleIds.some((value) => value.trim().toUpperCase() === context.nozzle_id?.toUpperCase())) {
    return 'Nozzle ID must be saved before a cartridge run can be armed.'
  }
  if (context.seal_fixture_id && !settings.sealFixtureIds.some((value) => value.trim().toUpperCase() === context.seal_fixture_id?.toUpperCase())) {
    return 'Seal ID must be saved before a cartridge run can be armed.'
  }

  if (context.workflow === 'cartridge_subassembly') {
    if (
      !context.operator ||
      !context.batch ||
      !/^SS-A-001-[A-Z0-9]{3,4}-\d{4}$/i.test(context.tester_device_serial ?? '') ||
      !/^SS-P-001-\d{3}-\d{4}$/i.test(context.enclosure_base_id ?? '') ||
      !/^NOZL-\d{4}$/i.test(context.nozzle_id ?? '') ||
      !/^SEAL-\d{4}$/i.test(context.seal_fixture_id ?? '')
    ) {
      return 'Cartridge workflow context is incomplete.'
    }
    if (context.cartridge_phase !== 'open' && (!context.run_uid || !context.cartridge_serial)) {
      return 'Cartridge continuation context requires a run_uid and cartridge serial.'
    }
  }

  if (context.workflow === 'linear_stage') {
    if (
      !context.operator ||
      !context.batch ||
      !/^SS-A-001-[A-Z0-9]{3,4}-\d{4}$/i.test(context.tester_device_serial ?? '') ||
      !context.linear_stage_run_id ||
      !context.linear_stage_mode
    ) {
      return 'Linear-stage workflow context is incomplete.'
    }
  }

  return undefined
}

function normalizeRunContext(context?: LocalRunContext): LocalRunContext | undefined {
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

function normalizeCartridgePhase(value?: string): LocalRunContext['cartridge_phase'] | undefined {
  return value === 'open' || value === 'nozzle' || value === 'sealed' || value === 'complete'
    ? value
    : undefined
}

function normalizeLinearStageMode(value?: string): LinearStageMode | undefined {
  return value === 'full' || value === 'mechanics' || value === 'optics' ? value : undefined
}

function cleanContextValue(value?: string): string | undefined {
  const trimmed = value?.trim()
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
