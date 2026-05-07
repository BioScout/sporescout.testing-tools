export const APP_NAME = 'SporeScout Cartridge Subassembly Tester'
export const ROUTE_CARTRIDGE_SUBASSEMBLY = '/admin/cartridge-subassembly'

export const DASHBOARD_SIDEBAR_WIDTH = 240
export const DASHBOARD_PRIMARY = '#1397f1'
export const DASHBOARD_SECONDARY = '#f2a108'

export const DEFAULT_STATION_SETTINGS: StationSettings = {
  stationId: 'STATION-001',
  testerDeviceSerials: ['SS-A-001-101A-0013', 'SS-A-001-101A-0122'],
  defaultTesterDeviceSerial: 'SS-A-001-101A-0013',
  enclosureBaseIds: ['SS-P-001-101-0001'],
  nozzleIds: ['NOZL-0001'],
  sealFixtureIds: ['SEAL-0001'],
  defaultEnclosureBaseId: 'SS-P-001-101-0001',
  defaultNozzleId: 'NOZL-0001',
  defaultSealFixtureId: 'SEAL-0001',
  operators: [],
  batches: ['P1-DEV-2026-05'],
  latestBatch: 'P1-DEV-2026-05',
}

export const ENGINEERING_PASSWORD = 'Banana12!'
export const CARTRIDGE_PROFILE = 'phase1-characterization'
export const CARTRIDGE_PROFILE_VERSION = 'phase1-characterization.v2'
export const CARTRIDGE_READINESS_COMMAND = 'test cartridge_leak readiness'

export type ConnectionMode = 'mock' | 'serial'
export type DeviceState = 'disconnected' | 'connecting' | 'ready' | 'busy' | 'fault'
export type ReadinessStatus = 'pending' | 'running' | 'passed' | 'failed'
export type TestPhase = 'open' | 'nozzle' | 'sealed'

export interface StationSettings {
  stationId: string
  testerDeviceSerials: string[]
  defaultTesterDeviceSerial: string
  enclosureBaseIds: string[]
  nozzleIds: string[]
  sealFixtureIds: string[]
  defaultEnclosureBaseId: string
  defaultNozzleId: string
  defaultSealFixtureId: string
  operators: string[]
  batches: string[]
  latestBatch: string
}

export function normalizeStationSettings(value?: Partial<StationSettings> | null): StationSettings {
  const legacy = value as Partial<StationSettings> & {
    fixtureIds?: string[]
    defaultFixtureId?: string
  } | null | undefined

  const merged: StationSettings = {
    ...DEFAULT_STATION_SETTINGS,
    ...value,
    testerDeviceSerials: uniqueNonEmpty([
      ...(value?.testerDeviceSerials ?? []),
      ...DEFAULT_STATION_SETTINGS.testerDeviceSerials,
    ]),
    enclosureBaseIds: uniqueNonEmpty([
      ...(value?.enclosureBaseIds ?? legacy?.fixtureIds ?? []).filter(isEnclosureBaseId),
      DEFAULT_STATION_SETTINGS.defaultEnclosureBaseId,
    ]),
    nozzleIds: uniqueNonEmpty([...(value?.nozzleIds ?? []), DEFAULT_STATION_SETTINGS.defaultNozzleId]),
    sealFixtureIds: uniqueNonEmpty([...(value?.sealFixtureIds ?? []), DEFAULT_STATION_SETTINGS.defaultSealFixtureId]),
    operators: uniqueNonEmpty(value?.operators ?? []),
    batches: uniqueNonEmpty([...(value?.batches ?? []), DEFAULT_STATION_SETTINGS.latestBatch]),
  }

  if (!value?.defaultEnclosureBaseId && legacy?.defaultFixtureId && isEnclosureBaseId(legacy.defaultFixtureId)) {
    merged.defaultEnclosureBaseId = legacy.defaultFixtureId
  }

  merged.defaultTesterDeviceSerial = ensureKnownDefault(
    merged.defaultTesterDeviceSerial,
    merged.testerDeviceSerials,
    DEFAULT_STATION_SETTINGS.defaultTesterDeviceSerial,
  )
  merged.defaultEnclosureBaseId = ensureKnownDefault(
    isEnclosureBaseId(merged.defaultEnclosureBaseId) ? merged.defaultEnclosureBaseId : '',
    merged.enclosureBaseIds,
    DEFAULT_STATION_SETTINGS.defaultEnclosureBaseId,
  )
  merged.defaultNozzleId = ensureKnownDefault(
    merged.defaultNozzleId,
    merged.nozzleIds,
    DEFAULT_STATION_SETTINGS.defaultNozzleId,
  )
  merged.defaultSealFixtureId = ensureKnownDefault(
    merged.defaultSealFixtureId,
    merged.sealFixtureIds,
    DEFAULT_STATION_SETTINGS.defaultSealFixtureId,
  )
  merged.latestBatch = ensureKnownDefault(merged.latestBatch, merged.batches, DEFAULT_STATION_SETTINGS.latestBatch)

  return merged
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
  info: string
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
  enclosureBaseId: string
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

export interface StoredCommandRecord {
  id: string
  command: string
  mode: string
  sent_at: string
}

export interface StoredCommandResponseRecord {
  id: string
  command: string
  ok: boolean
  response: GuiResponseEnvelope
  raw_line?: string
  received_at: string
}

export interface StoredMirroredEventRecord {
  id: string
  event_name: string
  record: MirroredEventRecord
  run_uid?: string
  cartridge_serial?: string
  created_at: string
  upload_status: MirroredEventRecord['upload_status']
}

export interface HistoricalRecords {
  commands: StoredCommandRecord[]
  responses: StoredCommandResponseRecord[]
  events: StoredMirroredEventRecord[]
  overrides: OverrideRecord[]
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
  getHistoricalRecords: () => Promise<HistoricalRecords>
  checkForUpdates: () => Promise<UpdateCheckResult>
  onSerialLine: (callback: (line: string) => void) => () => void
  onDeviceEvent: (callback: (event: GuiEventEnvelope) => void) => () => void
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function isEnclosureBaseId(value: string): boolean {
  return /^SS-P-001-\d{3}-\d{4}$/i.test(value.trim())
}

function ensureKnownDefault(value: string, options: string[], fallback: string): string {
  const trimmed = value.trim()
  return trimmed || options[0] || fallback
}
