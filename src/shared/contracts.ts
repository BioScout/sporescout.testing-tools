export const APP_NAME = 'SporeScout Cartridge Subassembly Tester'
export const ROUTE_CARTRIDGE_SUBASSEMBLY = '/admin/cartridge-subassembly'

export const DASHBOARD_SIDEBAR_WIDTH = 240
export const DASHBOARD_PRIMARY = '#1397f1'
export const DASHBOARD_SECONDARY = '#f2a108'

export const DEFAULT_STATION_SETTINGS: StationSettings = {
  stationId: 'STATION-001',
  fixtureIds: ['FIX-0001'],
  nozzleIds: ['NOZL-0001'],
  sealFixtureIds: ['SEAL-0001'],
  defaultFixtureId: 'FIX-0001',
  defaultNozzleId: 'NOZL-0001',
  defaultSealFixtureId: 'SEAL-0001',
  operators: [],
  batches: ['P1-DEV-2026-05'],
  latestBatch: 'P1-DEV-2026-05',
}

export const ENGINEERING_PASSWORD = 'Banana12!'
export const CARTRIDGE_PROFILE = 'phase1-characterization'
export const CARTRIDGE_PROFILE_VERSION = 'phase1-characterization.v2'

export type ConnectionMode = 'mock' | 'serial'
export type DeviceState = 'disconnected' | 'connecting' | 'ready' | 'busy' | 'fault'
export type ReadinessStatus = 'pending' | 'running' | 'passed' | 'failed'
export type TestPhase = 'open' | 'nozzle' | 'sealed'

export interface StationSettings {
  stationId: string
  fixtureIds: string[]
  nozzleIds: string[]
  sealFixtureIds: string[]
  defaultFixtureId: string
  defaultNozzleId: string
  defaultSealFixtureId: string
  operators: string[]
  batches: string[]
  latestBatch: string
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  friendlyName?: string
}

export interface ConnectRequest {
  mode: ConnectionMode
  path?: string
  baudRate?: number
}

export interface GuiResponseEnvelope {
  type: 'response'
  ok: boolean
  command: string
  result?: unknown
  error?: string
  firmware_version?: number
  device_id?: string
  product_id?: number
  timestamp_ms?: number
}

export interface GuiEventEnvelope {
  type: 'event'
  event_name: string
  data: Record<string, unknown>
  device_id?: string
  product_id?: number
  firmware_version?: number
  timestamp_ms?: number
}

export interface ParsedSerialLine {
  kind: 'gui-response' | 'gui-event' | 'legacy-response' | 'log'
  raw: string
  envelope?: GuiResponseEnvelope | GuiEventEnvelope
  legacy?: GuiResponseEnvelope
  error?: string
}

export interface CommandDispatchResult {
  accepted: boolean
  command: string
  response?: GuiResponseEnvelope
  timedOut?: boolean
  error?: string
}

export interface ReadinessItem {
  id: string
  label: string
  command: string
  status: ReadinessStatus
  detail?: string
}

export interface MeasurementSummary {
  phase: TestPhase
  slpm: number
  raw_mean_slpm: number
  median_slpm: number
  stddev_slpm: number
  min_slpm: number
  max_slpm: number
  trimmed_count: number
  outlier_count: number
  coefficient_of_variation: number
  sample_quality: 'acceptable' | 'repeat'
  settle_ms: number
  dt_ms: number
}

export interface CartridgeRun {
  runId: string
  runUid?: string
  cartridgeSerial?: string
  fixtureId: string
  nozzleId: string
  sealFixtureId: string
  startedAt: string
  completedAt?: string
  guidance?: string
  sealedOpenRatio?: number
  sampleQuality?: string
}

export interface MirroredEventRecord {
  event_name: string
  data: Record<string, unknown>
  raw_line?: string
  local_timestamp: string
  device_id?: string
  product_id?: number
  firmware_version?: number
  run_uid?: string
  cartridge_serial?: string
  upload_status: 'local_only' | 'queued' | 'uploaded' | 'failed'
}

export interface OverrideRecord {
  id: string
  run_uid?: string
  cartridge_serial?: string
  operator: string
  reason: string
  action: string
  created_at: string
}

export interface StorageSummary {
  databasePath: string
  jsonlPath: string
  eventCount: number
  commandCount: number
  overrideCount: number
}

export interface UpdateCheckResult {
  checked_at: string
  status: 'idle' | 'checking' | 'available' | 'current' | 'failed'
  version?: string
  message?: string
}

export interface TestingToolsApi {
  listSerialPorts: () => Promise<SerialPortInfo[]>
  connect: (request: ConnectRequest) => Promise<{ ok: boolean; mode: ConnectionMode; path?: string; error?: string }>
  disconnect: () => Promise<{ ok: boolean }>
  sendCommand: (command: string) => Promise<CommandDispatchResult>
  getSettings: () => Promise<StationSettings>
  saveSettings: (settings: StationSettings) => Promise<StationSettings>
  saveOverride: (override: OverrideRecord) => Promise<void>
  getStorageSummary: () => Promise<StorageSummary>
  checkForUpdates: () => Promise<UpdateCheckResult>
  onSerialLine: (callback: (line: string) => void) => () => void
  onDeviceEvent: (callback: (event: GuiEventEnvelope) => void) => () => void
}
