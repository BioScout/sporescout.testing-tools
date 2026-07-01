export const APP_NAME = 'SporeScout Cartridge Subassembly Tester'
export const ROUTE_CARTRIDGE_SUBASSEMBLY = '/admin/cartridge-subassembly'
export const ROUTE_LINEAR_STAGE = '/admin/linear-stage'

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
export const CARTRIDGE_PROFILE_VERSION = 'phase1-characterization.v3'
export const CARTRIDGE_READINESS_COMMAND = 'test cartridge_leak prepare'
export const LINEAR_STAGE_READINESS_COMMAND = 'test linear_stage prepare'
export type LinearStageMode = 'production_full' | 'mechanics_only' | 'optics_only'
export type LinearStageSessionType =
  | 'LINEAR_STAGE_COMPREHENSIVE'
  | 'LINEAR_STAGE_MECHANICS'
  | 'LINEAR_STAGE_OPTICS'

export const LINEAR_STAGE_MODE_SESSION_TYPES: Record<LinearStageMode, LinearStageSessionType> = {
  production_full: 'LINEAR_STAGE_COMPREHENSIVE',
  mechanics_only: 'LINEAR_STAGE_MECHANICS',
  optics_only: 'LINEAR_STAGE_OPTICS',
}

export const LINEAR_STAGE_SESSION_TYPE_MODES: Record<LinearStageSessionType, LinearStageMode> = {
  LINEAR_STAGE_COMPREHENSIVE: 'production_full',
  LINEAR_STAGE_MECHANICS: 'mechanics_only',
  LINEAR_STAGE_OPTICS: 'optics_only',
}

export const LINEAR_STAGE_SUITE_COMMAND = 'test suite'
export const LINEAR_STAGE_MODE_COMMANDS: Record<LinearStageMode, string> = {
  production_full: `${LINEAR_STAGE_SUITE_COMMAND}({"sessionId":1,"sessionType":"LINEAR_STAGE_COMPREHENSIVE","repeats":1})`,
  mechanics_only: `${LINEAR_STAGE_SUITE_COMMAND}({"sessionId":1,"sessionType":"LINEAR_STAGE_MECHANICS","repeats":1})`,
  optics_only: `${LINEAR_STAGE_SUITE_COMMAND}({"sessionId":1,"sessionType":"LINEAR_STAGE_OPTICS","repeats":1})`,
}
export const LINEAR_STAGE_OPERATOR_MOTION_COMMANDS = Object.values(LINEAR_STAGE_MODE_COMMANDS)
export const LINEAR_STAGE_ENGINEERING_MOTION_COMMANDS = [] as const
export const LINEAR_STAGE_MOTION_COMMANDS = LINEAR_STAGE_OPERATOR_MOTION_COMMANDS
export const LINEAR_STAGE_STAGE_CLEAR_MAX_AGE_MS = 2 * 60 * 1000
export const LINEAR_STAGE_SAFE_COMMANDS = [
  LINEAR_STAGE_READINESS_COMMAND,
  'test linear_stage readiness',
  'test linear_stage status',
  'test step prepare',
  'test step readiness',
  'test step status',
] as const

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
      ...(value?.testerDeviceSerials ?? []).map(canonicalHardwareId).filter(isTesterDeviceSerial),
      ...DEFAULT_STATION_SETTINGS.testerDeviceSerials,
    ]),
    enclosureBaseIds: uniqueNonEmpty([
      ...(value?.enclosureBaseIds ?? legacy?.fixtureIds ?? []).map(canonicalHardwareId).filter(isEnclosureBaseId),
      DEFAULT_STATION_SETTINGS.defaultEnclosureBaseId,
    ]),
    nozzleIds: uniqueNonEmpty([...(value?.nozzleIds ?? []).map(canonicalHardwareId).filter(isNozzleId), DEFAULT_STATION_SETTINGS.defaultNozzleId]),
    sealFixtureIds: uniqueNonEmpty([...(value?.sealFixtureIds ?? []).map(canonicalHardwareId).filter(isSealFixtureId), DEFAULT_STATION_SETTINGS.defaultSealFixtureId]),
    operators: uniqueNonEmpty(value?.operators ?? []),
    batches: uniqueNonEmpty([...(value?.batches ?? []), DEFAULT_STATION_SETTINGS.latestBatch]),
  }

  if (!value?.defaultEnclosureBaseId && legacy?.defaultFixtureId && isEnclosureBaseId(legacy.defaultFixtureId)) {
    merged.defaultEnclosureBaseId = legacy.defaultFixtureId
  }

  merged.defaultTesterDeviceSerial = ensureKnownDefault(
    isTesterDeviceSerial(merged.defaultTesterDeviceSerial) ? canonicalHardwareId(merged.defaultTesterDeviceSerial) : '',
    merged.testerDeviceSerials,
    DEFAULT_STATION_SETTINGS.defaultTesterDeviceSerial,
  )
  merged.defaultEnclosureBaseId = ensureKnownDefault(
    isEnclosureBaseId(merged.defaultEnclosureBaseId) ? canonicalHardwareId(merged.defaultEnclosureBaseId) : '',
    merged.enclosureBaseIds,
    DEFAULT_STATION_SETTINGS.defaultEnclosureBaseId,
  )
  merged.defaultNozzleId = ensureKnownDefault(
    isNozzleId(merged.defaultNozzleId) ? canonicalHardwareId(merged.defaultNozzleId) : '',
    merged.nozzleIds,
    DEFAULT_STATION_SETTINGS.defaultNozzleId,
  )
  merged.defaultSealFixtureId = ensureKnownDefault(
    isSealFixtureId(merged.defaultSealFixtureId) ? canonicalHardwareId(merged.defaultSealFixtureId) : '',
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

export interface ConnectionStatusEvent {
  connected: boolean
  mode?: ConnectionMode
  path?: string
  message?: string
}

export interface GuiResponseEnvelope {
  type: 'response'
  ok: boolean
  command: string
  result?: unknown
  error?: string
  result_omitted?: boolean
  result_json_bytes?: number
  message?: string
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
  valid?: boolean
  sample_count?: number
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
  stability_limit_slpm?: number
  settle_ms: number
  dt_ms: number
  fan_pwm_pct?: number
  rpm?: number
  pressure_hpa?: number
  temperature_c?: number
  environment_source?: string
  flow_lpm_mean?: number
  flow_slpm_samples?: number[]
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
  event_id: string
  idempotency_key: string
  event_name: string
  data: Record<string, unknown>
  raw_line?: string
  local_timestamp: string
  device_id?: string
  product_id?: number
  firmware_version?: number
  run_uid?: string
  firmware_run_uid?: string
  cartridge_serial?: string
  station_id?: string
  operator?: string
  batch?: string
  tester_device_serial?: string
  enclosure_base_id?: string
  nozzle_id?: string
  seal_fixture_id?: string
  workflow?: string
  linear_stage_run_id?: string
  linear_stage_mode?: LinearStageMode
  app_version?: string
  jsonl_status?: 'pending' | 'written' | 'write_failed'
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
  context?: LocalRunContext
  run_uid?: string
  cartridge_serial?: string
  workflow?: string
  linear_stage_run_id?: string
}

export interface StoredCommandResponseRecord {
  id: string
  command: string
  ok: boolean
  response: GuiResponseEnvelope
  raw_line?: string
  received_at: string
  context?: LocalRunContext
  run_uid?: string
  cartridge_serial?: string
  workflow?: string
  linear_stage_run_id?: string
}

export interface StoredMirroredEventRecord {
  id: string
  event_name: string
  record: MirroredEventRecord
  run_uid?: string
  cartridge_serial?: string
  workflow?: string
  linear_stage_run_id?: string
  linear_stage_mode?: LinearStageMode
  app_version?: string
  created_at: string
  upload_status: MirroredEventRecord['upload_status']
}

export interface HistoricalRecords {
  commands: StoredCommandRecord[]
  responses: StoredCommandResponseRecord[]
  events: StoredMirroredEventRecord[]
  overrides: OverrideRecord[]
}

export interface HistoricalRecordsQuery {
  limit?: number
  offset?: number
  runUid?: string
  cartridgeSerial?: string
  workflow?: string
  linearStageRunId?: string
  text?: string
}

export interface LocalRunContext {
  station_id?: string
  operator?: string
  batch?: string
  tester_device_serial?: string
  enclosure_base_id?: string
  nozzle_id?: string
  seal_fixture_id?: string
  cartridge_serial?: string
  run_uid?: string
  workflow?: string
  cartridge_phase?: 'open' | 'nozzle' | 'sealed' | 'complete'
  linear_stage_run_id?: string
  linear_stage_mode?: LinearStageMode
  stage_clear_confirmed?: boolean
  stage_clear_arm_id?: string
  stage_clear_armed_at?: string
}

export interface StorageSummary {
  databasePath: string
  jsonlPath: string
  eventCount: number
  commandCount: number
  responseCount: number
  overrideCount: number
}

export interface UpdateCheckResult {
  checked_at: string
  status: 'idle' | 'checking' | 'available' | 'current' | 'failed'
  version?: string
  message?: string
}

export interface EngineeringUnlockResult {
  ok: boolean
  error?: string
}

export interface LinearStageArmResult {
  ok: boolean
  armId?: string
  armedAt?: string
  error?: string
}

export interface TestingToolsApi {
  listSerialPorts: () => Promise<SerialPortInfo[]>
  connect: (request: ConnectRequest) => Promise<{ ok: boolean; mode: ConnectionMode; path?: string; error?: string }>
  disconnect: () => Promise<{ ok: boolean }>
  getRuntimeConfig: () => Promise<{ serialBackend: 'electron' | 'browser'; exactSerialPort?: string; appVersion?: string }>
  sendCommand: (command: string) => Promise<CommandDispatchResult>
  armLinearStageTest: (context: LocalRunContext) => Promise<LinearStageArmResult>
  runLinearStageTest: (armId: string, command: string) => Promise<CommandDispatchResult>
  getSettings: () => Promise<StationSettings>
  saveSettings: (settings: StationSettings) => Promise<StationSettings>
  unlockEngineering: (password: string) => Promise<EngineeringUnlockResult>
  saveOverride: (override: OverrideRecord) => Promise<void>
  setActiveRunContext: (context?: LocalRunContext) => Promise<void>
  getActiveRunContext: () => Promise<LocalRunContext | undefined>
  unlockSolenoidForRemoval: (lockAfterMs?: number) => Promise<CommandDispatchResult>
  getStorageSummary: () => Promise<StorageSummary>
  getHistoricalRecords: (query?: HistoricalRecordsQuery) => Promise<HistoricalRecords>
  checkForUpdates: () => Promise<UpdateCheckResult>
  onSerialLine: (callback: (line: string) => void) => () => void
  onDeviceEvent: (callback: (event: GuiEventEnvelope) => void) => () => void
  onConnectionStatus: (callback: (status: ConnectionStatusEvent) => void) => () => void
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanStationOption).filter(Boolean)))
}

function cleanStationOption(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (!cleaned || cleaned.length > 80 || hasControlCharacter(cleaned)) {
    return ''
  }
  return cleaned
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127
  })
}

export function isTesterDeviceSerial(value: string): boolean {
  return /^SS-A-001-[A-Z0-9]{3,4}-\d{4}$/i.test(value.trim())
}

export function isEnclosureBaseId(value: string): boolean {
  return /^SS-P-001-\d{3}-\d{4}$/i.test(value.trim())
}

export function isNozzleId(value: string): boolean {
  return /^NOZL-\d{4}$/i.test(value.trim())
}

export function isSealFixtureId(value: string): boolean {
  return /^SEAL-\d{4}$/i.test(value.trim())
}

export function isLinearStageMotionCommand(command: string): boolean {
  return linearStageModeForCommand(command) !== undefined
}

export function linearStageModeForCommand(command: string): LinearStageMode | undefined {
  const request = parseLinearStageSuiteCommand(command)
  return request?.mode
}

export function isCanonicalLinearStageModeCommand(command: string): boolean {
  return parseLinearStageSuiteCommand(command) !== undefined
}

export function isLinearStageSafeCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  return LINEAR_STAGE_SAFE_COMMANDS.some((allowed) => allowed.toLowerCase() === normalized)
}

export function validateGuiCommand(
  command: string,
  context?: LocalRunContext,
  options: { allowSolenoidUnlock?: boolean; allowLinearStageMotion?: boolean; allowEngineeringLinearStageMotion?: boolean } = {},
): { ok: true; command: string; consumesLinearStageArm?: boolean } | { ok: false; command: string; error: string } {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, command, error: 'Command is empty.' }
  }

  if (trimmed === 'solenoid IsUnlocked' || trimmed === 'solenoid Lock') {
    return { ok: true, command: trimmed }
  }
  if (trimmed === 'solenoid Unlock') {
    return options.allowSolenoidUnlock
      ? { ok: true, command: trimmed }
      : { ok: false, command: trimmed, error: 'Solenoid unlock must use the timed removal control.' }
  }

  if (trimmed === CARTRIDGE_READINESS_COMMAND) {
    return { ok: true, command: trimmed }
  }
  const openMatch = trimmed.match(/^test cartridge_leak open (SS-SA-007-\d{3}-\d{4}) (SS-P-001-\d{3}-\d{4}) phase1-characterization$/i)
  if (openMatch) {
    const contextError = validateCartridgeContext(context, {
      phase: 'open',
      cartridgeSerial: openMatch[1],
      enclosureBaseId: openMatch[2],
    })
    return contextError ? { ok: false, command: trimmed, error: contextError } : { ok: true, command: trimmed }
  }
  const nozzleMatch = trimmed.match(/^test cartridge_leak nozzle (\S+) (NOZL-\d{4})$/i)
  if (nozzleMatch) {
    const contextError = validateCartridgeContext(context, {
      phase: 'nozzle',
      runUid: nozzleMatch[1],
      nozzleId: nozzleMatch[2],
    })
    return contextError ? { ok: false, command: trimmed, error: contextError } : { ok: true, command: trimmed }
  }
  const sealedMatch = trimmed.match(/^test cartridge_leak sealed (\S+) (SEAL-\d{4})$/i)
  if (sealedMatch) {
    const contextError = validateCartridgeContext(context, {
      phase: 'sealed',
      runUid: sealedMatch[1],
      sealFixtureId: sealedMatch[2],
    })
    return contextError ? { ok: false, command: trimmed, error: contextError } : { ok: true, command: trimmed }
  }
  const cancelMatch = trimmed.match(/^test cartridge_leak cancel (\S+)$/i)
  if (cancelMatch) {
    const contextError = validateCartridgeContext(context, {
      runUid: cancelMatch[1],
    })
    return contextError ? { ok: false, command: trimmed, error: contextError } : { ok: true, command: trimmed }
  }

  if (isLinearStageSafeCommand(trimmed)) {
    return { ok: true, command: trimmed }
  }
  if (isLinearStageMotionCommand(trimmed)) {
    const commandMode = linearStageModeForCommand(trimmed)
    const modeMatches = commandMode !== undefined && context?.linear_stage_mode === commandMode
    const canonicalMotion = isCanonicalLinearStageModeCommand(trimmed)
    const engineeringMotionAllowed = options.allowEngineeringLinearStageMotion === true
    const motionCommandAllowed = options.allowLinearStageMotion === true && (canonicalMotion || engineeringMotionAllowed)
    const armFresh = isFreshLinearStageArm(context)
    const motionArmed =
      motionCommandAllowed &&
      context?.workflow === 'linear_stage' &&
      context.stage_clear_confirmed === true &&
      armFresh &&
      Boolean(context.linear_stage_run_id) &&
      Boolean(context.operator) &&
      Boolean(context.batch) &&
      isTesterDeviceSerial(context.tester_device_serial ?? '') &&
      modeMatches
    return motionArmed
      ? { ok: true, command: trimmed, consumesLinearStageArm: true }
      : {
          ok: false,
          command: trimmed,
          error: !motionCommandAllowed
            ? 'Linear-stage motion must use the dedicated stage-clear run control.'
            : commandMode && !modeMatches
              ? 'Linear-stage motion command does not match the armed mode for this run.'
              : !armFresh
                ? 'Linear-stage stage-clear confirmation expired. Reconfirm that the stage is clear.'
                : 'Linear-stage motion is blocked until the stage-clear confirmation is armed for this run.',
        }
  }

  return { ok: false, command: trimmed, error: 'Command is not allowed from the GUI workflow.' }
}

export function buildLinearStageSuiteCommand(mode: LinearStageMode, sessionId: number, repeats = 1): string {
  const normalizedSessionId = Math.trunc(sessionId)
  const normalizedRepeats = Math.trunc(repeats)
  if (!Number.isFinite(normalizedSessionId) || normalizedSessionId <= 0) {
    throw new Error('Linear-stage suite session id must be a positive integer.')
  }
  if (!Number.isFinite(normalizedRepeats) || normalizedRepeats <= 0) {
    throw new Error('Linear-stage suite repeats must be a positive integer.')
  }

  return `${LINEAR_STAGE_SUITE_COMMAND}(${JSON.stringify({
    sessionId: normalizedSessionId,
    sessionType: LINEAR_STAGE_MODE_SESSION_TYPES[mode],
    repeats: normalizedRepeats,
  })})`
}

export function parseLinearStageSuiteCommand(command: string): { mode: LinearStageMode; sessionId: number; sessionType: LinearStageSessionType; repeats: number } | undefined {
  const trimmed = command.trim()
  const match = trimmed.match(/^test\s+suite\s*\((.*)\)$/i)
  if (!match) return undefined

  let payload: unknown
  try {
    payload = JSON.parse(match[1])
  } catch {
    return undefined
  }

  const request = isPlainObject(payload) ? payload : undefined
  const sessionId = typeof request?.sessionId === 'number' ? request.sessionId : undefined
  const repeats = request?.repeats === undefined ? 1 : typeof request.repeats === 'number' ? request.repeats : undefined
  const rawSessionType = typeof request?.sessionType === 'string' ? request.sessionType.trim().toUpperCase() : undefined
  const sessionType = rawSessionType && rawSessionType in LINEAR_STAGE_SESSION_TYPE_MODES ? rawSessionType as LinearStageSessionType : undefined

  if (sessionType === undefined || sessionId === undefined || repeats === undefined) {
    return undefined
  }
  if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(repeats) || repeats <= 0) {
    return undefined
  }

  return {
    mode: LINEAR_STAGE_SESSION_TYPE_MODES[sessionType],
    sessionId,
    sessionType,
    repeats,
  }
}

function isFreshLinearStageArm(context?: LocalRunContext): boolean {
  if (!context?.stage_clear_confirmed || !context.stage_clear_arm_id || !context.stage_clear_armed_at) return false
  const armedAtMs = Date.parse(context.stage_clear_armed_at)
  if (!Number.isFinite(armedAtMs)) return false
  const ageMs = Date.now() - armedAtMs
  return ageMs >= 0 && ageMs <= LINEAR_STAGE_STAGE_CLEAR_MAX_AGE_MS
}

function validateCartridgeContext(
  context: LocalRunContext | undefined,
  expected: {
    phase?: 'open' | 'nozzle' | 'sealed'
    cartridgeSerial?: string
    enclosureBaseId?: string
    runUid?: string
    nozzleId?: string
    sealFixtureId?: string
  },
): string | undefined {
  if (context?.workflow !== 'cartridge_subassembly') {
    return 'Cartridge command is blocked until a cartridge workflow is active.'
  }
  if (!context.operator || !context.batch) {
    return 'Cartridge command is blocked until operator and batch are recorded.'
  }
  if (!isTesterDeviceSerial(context.tester_device_serial ?? '')) {
    return 'Cartridge command is blocked until a valid tester serial is recorded.'
  }
  if (!isEnclosureBaseId(context.enclosure_base_id ?? '')) {
    return 'Cartridge command is blocked until a valid enclosure base ID is recorded.'
  }
  if (!isNozzleId(context.nozzle_id ?? '') || !isSealFixtureId(context.seal_fixture_id ?? '')) {
    return 'Cartridge command is blocked until valid nozzle and seal IDs are recorded.'
  }
  if (expected.phase && context.cartridge_phase !== expected.phase) {
    return `Cartridge command is blocked; active phase is ${context.cartridge_phase ?? 'none'}, command phase is ${expected.phase}.`
  }
  if (expected.cartridgeSerial && canonicalHardwareId(context.cartridge_serial ?? '') !== canonicalHardwareId(expected.cartridgeSerial)) {
    return 'Cartridge command serial does not match the scanned cartridge.'
  }
  if (expected.enclosureBaseId && canonicalHardwareId(context.enclosure_base_id ?? '') !== canonicalHardwareId(expected.enclosureBaseId)) {
    return 'Cartridge command enclosure base does not match the active station setting.'
  }
  if (expected.runUid && context.run_uid !== expected.runUid) {
    return 'Cartridge command run_uid does not match the firmware-generated active run_uid.'
  }
  if (expected.nozzleId && canonicalHardwareId(context.nozzle_id ?? '') !== canonicalHardwareId(expected.nozzleId)) {
    return 'Cartridge command nozzle ID does not match the active station setting.'
  }
  if (expected.sealFixtureId && canonicalHardwareId(context.seal_fixture_id ?? '') !== canonicalHardwareId(expected.sealFixtureId)) {
    return 'Cartridge command seal ID does not match the active station setting.'
  }
  return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isKnownOption(value: string, options: string[]): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && options.some((option) => option.trim() === trimmed)
}

export function canonicalHardwareId(value: string): string {
  return value.trim().toUpperCase()
}

function ensureKnownDefault(value: string, options: string[], fallback: string): string {
  const trimmed = value.trim()
  return trimmed || options[0] || fallback
}
