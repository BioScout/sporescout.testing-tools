import {
  CARTRIDGE_PROFILE_VERSION,
  DEFAULT_STATION_SETTINGS,
  type CommandDispatchResult,
  type ConnectRequest,
  type ConnectionMode,
  type GuiEventEnvelope,
  type GuiResponseEnvelope,
  type SerialPortInfo,
  type StationSettings,
  type TestingToolsApi,
} from '../shared/contracts'
import { formatGuiEvent, formatGuiResponse, parseSerialLine } from '../shared/serialParser'

const BROWSER_SERIAL_CHOOSE_PATH = 'WEB_SERIAL_REQUEST'
const BROWSER_SERIAL_GRANTED_PREFIX = 'WEB_SERIAL_GRANTED_'
const DEFAULT_BAUD_RATE = 115200
const SERIAL_RESPONSE_TIMEOUT_MS = 25000

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
  resolve: (response: GuiResponseEnvelope) => void
  timeout: number
}

export function getTestingToolsApi(): TestingToolsApi {
  return window.testingTools ?? browserApi
}

export function getDefaultConnectionMode(): ConnectionMode {
  return window.testingTools || getBrowserSerial() ? 'serial' : 'mock'
}

let settings: StationSettings = DEFAULT_STATION_SETTINGS
let activeRunUid = ''
let activeCartridge = ''
let runCounter = 0
let browserConnectionMode: ConnectionMode | undefined
let browserSerialPort: BrowserSerialPort | null = null
let browserSerialReader: ReadableStreamDefaultReader<Uint8Array> | null = null
let browserSerialReadLoopActive = false
let browserSerialBuffer = ''
let grantedBrowserPorts: BrowserSerialPort[] = []
const lineListeners = new Set<(line: string) => void>()
const eventListeners = new Set<(event: GuiEventEnvelope) => void>()
const browserPendingResponses: BrowserPendingResponse[] = []

const browserApi: TestingToolsApi = {
  async listSerialPorts() {
    const serial = getBrowserSerial()
    if (!serial) {
      return [{ path: 'MOCK', friendlyName: 'Mock tester' }]
    }

    grantedBrowserPorts = await serial.getPorts()
    return [
      ...grantedBrowserPorts.map((port, index) => browserPortInfo(port, index)),
      {
        path: BROWSER_SERIAL_CHOOSE_PATH,
        friendlyName: 'Choose serial port in browser',
      },
    ]
  },
  async connect(request: ConnectRequest) {
    await disconnectBrowserSerial()

    if (request.mode === 'serial') {
      return connectBrowserSerial(request)
    }

    browserConnectionMode = 'mock'
    emitLine('Mock tester connected')
    return { ok: true, mode: 'mock' }
  },
  async disconnect() {
    if (browserConnectionMode === 'serial') {
      await disconnectBrowserSerial()
      emitLine('Browser serial disconnected')
    } else {
      browserConnectionMode = undefined
      emitLine('Mock tester disconnected')
    }

    return { ok: true }
  },
  async sendCommand(command: string) {
    if (browserConnectionMode === 'serial') {
      return sendBrowserSerialCommand(command)
    }

    const response = buildMockResponse(command)
    emitLine(formatGuiResponse(response))
    buildMockEvents(command).forEach((event) => emitLine(formatGuiEvent(event)))
    return { accepted: true, command, response }
  },
  async getSettings() {
    return settings
  },
  async saveSettings(nextSettings: StationSettings) {
    settings = nextSettings
    return settings
  },
  async saveOverride() {
    return undefined
  },
  async getStorageSummary() {
    return {
      databasePath: 'Browser preview only',
      jsonlPath: 'Browser preview only',
      eventCount: 0,
      commandCount: 0,
      overrideCount: 0,
    }
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
    startBrowserSerialReadLoop(port)
    emitLine('Browser serial connected')

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
  if (!browserSerialPort?.writable) {
    return { accepted: false, command, error: 'Browser serial port is not connected.' }
  }

  const responsePromise = waitForBrowserSerialResponse(command)
  const writer = browserSerialPort.writable.getWriter()

  try {
    await writer.write(new TextEncoder().encode(`${command}\n`))
  } catch (error) {
    removeBrowserPending(command)
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

function waitForBrowserSerialResponse(command: string): Promise<CommandDispatchResult> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      removeBrowserPending(command)
      resolve({ accepted: true, command, timedOut: true })
    }, SERIAL_RESPONSE_TIMEOUT_MS)

    browserPendingResponses.push({
      command,
      timeout,
      resolve: (response) => {
        resolve({ accepted: true, command, response })
      },
    })
  })
}

function startBrowserSerialReadLoop(port: BrowserSerialPort): void {
  if (browserSerialReadLoopActive || !port.readable) {
    return
  }

  browserSerialReadLoopActive = true
  void readBrowserSerial(port)
}

async function readBrowserSerial(port: BrowserSerialPort): Promise<void> {
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
            appendBrowserSerialChunk(decoder.decode(value, { stream: true }))
          }
        }
      } finally {
        browserSerialReader.releaseLock()
        browserSerialReader = null
      }
    }
  } catch (error) {
    if (browserSerialReadLoopActive) {
      emitLine(`Browser serial read error: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  } finally {
    browserSerialReadLoopActive = false
  }
}

function appendBrowserSerialChunk(chunk: string): void {
  browserSerialBuffer += chunk
  for (;;) {
    const newlineIndex = browserSerialBuffer.search(/\r?\n/)
    if (newlineIndex === -1) {
      return
    }

    const line = browserSerialBuffer.slice(0, newlineIndex)
    browserSerialBuffer = browserSerialBuffer.slice(browserSerialBuffer[newlineIndex] === '\r' ? newlineIndex + 2 : newlineIndex + 1)
    if (line.trim()) {
      emitLine(line)
    }
  }
}

async function disconnectBrowserSerial(): Promise<void> {
  browserConnectionMode = undefined
  for (const pending of browserPendingResponses.splice(0)) {
    window.clearTimeout(pending.timeout)
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
}

function emitLine(line: string): void {
  lineListeners.forEach((listener) => listener(line))
  const parsed = parseSerialLine(line)
  if (parsed.kind === 'gui-event' && parsed.envelope?.type === 'event') {
    eventListeners.forEach((listener) => listener(parsed.envelope as GuiEventEnvelope))
    return
  }

  if (parsed.kind === 'gui-response' && parsed.envelope?.type === 'response') {
    resolveBrowserPendingResponse(parsed.envelope as GuiResponseEnvelope)
    return
  }

  if (parsed.kind === 'legacy-response' && parsed.legacy) {
    resolveBrowserPendingResponse(parsed.legacy)
  }
}

function resolveBrowserPendingResponse(response: GuiResponseEnvelope): void {
  const index = browserPendingResponses.findIndex(
    (pending) => pending.command === response.command || response.command.length > 0,
  )
  if (index === -1) {
    return
  }

  const pending = browserPendingResponses.splice(index, 1)[0]
  window.clearTimeout(pending.timeout)
  pending.resolve(response)
}

function removeBrowserPending(command: string): void {
  const index = browserPendingResponses.findIndex((pending) => pending.command === command)
  if (index !== -1) {
    const [pending] = browserPendingResponses.splice(index, 1)
    window.clearTimeout(pending.timeout)
  }
}

function getBrowserSerial(): BrowserSerial | undefined {
  return (navigator as NavigatorWithSerial).serial
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

  return { ...base, result: 'ok' }
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

  return []
}

function measurementEvent(phase: 'open' | 'nozzle' | 'sealed', slpm: number): GuiEventEnvelope {
  return {
    type: 'event',
    event_name: `dd_test_cartridge_air_leak_${phase}`,
    device_id: 'MOCK-BROWSER-001',
    product_id: 33608,
    firmware_version: 5383001,
    timestamp_ms: Date.now(),
    data: {
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
      settle_ms: 12000,
      dt_ms: 100,
    },
  }
}
