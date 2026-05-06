import {
  CARTRIDGE_PROFILE_VERSION,
  DEFAULT_STATION_SETTINGS,
  type GuiEventEnvelope,
  type GuiResponseEnvelope,
  type StationSettings,
  type TestingToolsApi,
} from '../shared/contracts'
import { formatGuiEvent, formatGuiResponse, parseSerialLine } from '../shared/serialParser'

export function getTestingToolsApi(): TestingToolsApi {
  return window.testingTools ?? browserMockApi
}

let settings: StationSettings = DEFAULT_STATION_SETTINGS
let activeRunUid = ''
let activeCartridge = ''
let runCounter = 0
const lineListeners = new Set<(line: string) => void>()
const eventListeners = new Set<(event: GuiEventEnvelope) => void>()

const browserMockApi: TestingToolsApi = {
  async listSerialPorts() {
    return [{ path: 'MOCK', friendlyName: 'Mock tester' }]
  },
  async connect() {
    emitLine('Mock tester connected')
    return { ok: true, mode: 'mock' }
  },
  async disconnect() {
    emitLine('Mock tester disconnected')
    return { ok: true }
  },
  async sendCommand(command: string) {
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

function emitLine(line: string): void {
  lineListeners.forEach((listener) => listener(line))
  const parsed = parseSerialLine(line)
  if (parsed.kind === 'gui-event' && parsed.envelope?.type === 'event') {
    eventListeners.forEach((listener) => listener(parsed.envelope as GuiEventEnvelope))
  }
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
