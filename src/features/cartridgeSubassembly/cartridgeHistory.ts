import type {
  GuiEventEnvelope,
  MeasurementSummary,
  StoredMirroredEventRecord,
  TestPhase,
} from '../../shared/contracts'
import { deriveGuidanceFromMeasurements, extractGuidance, extractMeasurement } from '../../shared/workflow'

export type CartridgeHistoryResult = 'accept' | 'borderline' | 'suspect' | 'repeat' | 'unknown'

export interface CartridgeHistoryFilters {
  attemptView?: 'all' | 'latest'
  operator?: string
  productionBatch?: string
  appVersion?: string
  result?: 'all' | CartridgeHistoryResult
}

export interface CartridgeHistoryRun {
  id: string
  runUid?: string
  firmwareRunUid?: string
  cartridgeSerial?: string
  startedAt: string
  completedAt: string
  operator?: string
  productionBatch?: string
  appVersion?: string
  testerDeviceSerial?: string
  enclosureBaseId?: string
  nozzleId?: string
  sealFixtureId?: string
  deviceId?: string
  productId?: number
  firmwareVersion?: number
  profileVersion?: string
  status?: string
  guidance?: string
  sealedOpenRatio?: number
  sampleQuality?: string
  measurements: Partial<Record<TestPhase, MeasurementSummary>>
  eventCount: number
  rawEvents: StoredMirroredEventRecord[]
  attemptIndex: number
  attemptCount: number
}

const PHASES: TestPhase[] = ['open', 'nozzle', 'sealed']

export function buildCartridgeHistoryRuns(events: StoredMirroredEventRecord[]): CartridgeHistoryRun[] {
  const runs = new Map<string, CartridgeHistoryRun>()

  for (const event of [...events].sort((a, b) => eventTime(a).localeCompare(eventTime(b)))) {
    const record = event.record
    const data = asRecord(record.data)
    const context = asRecord(data.context)
    const runUid = firstString(event.run_uid, record.run_uid, data.run_uid, data.run, context.run_uid, context.run)
    const cartridgeSerial = firstString(
      event.cartridge_serial,
      record.cartridge_serial,
      data.cartridge_serial,
      data.cartridge,
      data.cart,
      context.cartridge_serial,
      context.cartridge,
      context.cart,
    )
    const fallbackKey = `${cartridgeSerial ?? 'unknown-cartridge'}:${eventTime(event)}:${event.id}`
    const id = runUid ?? fallbackKey
    const existing = runs.get(id)
    const run = existing ?? createEmptyRun(id, eventTime(event))

    run.runUid = run.runUid ?? runUid
    run.firmwareRunUid = run.firmwareRunUid ?? record.firmware_run_uid
    run.cartridgeSerial = run.cartridgeSerial ?? cartridgeSerial
    run.startedAt = earlierTimestamp(run.startedAt, eventTime(event))
    run.completedAt = laterTimestamp(run.completedAt, eventTime(event))
    run.operator = run.operator ?? firstString(record.operator, context.operator)
    run.productionBatch = run.productionBatch ?? firstString(record.batch, context.batch, data.batch)
    run.appVersion = run.appVersion ?? firstString(record.app_version, data.app_version, context.app_version)
    run.testerDeviceSerial = run.testerDeviceSerial ?? firstString(record.tester_device_serial, context.tester_device_serial)
    run.enclosureBaseId = run.enclosureBaseId ?? firstString(record.enclosure_base_id, data.fix, context.enclosure_base_id)
    run.nozzleId = run.nozzleId ?? firstString(record.nozzle_id, data.noz, context.nozzle_id)
    run.sealFixtureId = run.sealFixtureId ?? firstString(record.seal_fixture_id, data.seal, context.seal_fixture_id)
    run.deviceId = run.deviceId ?? firstString(record.device_id, data.dev)
    run.productId = run.productId ?? record.product_id
    run.firmwareVersion = run.firmwareVersion ?? record.firmware_version
    run.profileVersion = run.profileVersion ?? firstString(data.profile_version, data.prof_ver, data.prof)
    run.status = run.status ?? firstString(data.status)

    const envelope = eventEnvelopeFromRecord(event)
    const measurement = extractMeasurement(envelope)
    if (measurement) {
      run.measurements[measurement.phase] = measurement
    }
    for (const phase of PHASES) {
      const summaryMeasurement = measurementFromSummary(data, phase)
      if (summaryMeasurement) {
        run.measurements[phase] = mergeSummaryMeasurement(run.measurements[phase], summaryMeasurement)
      }
    }

    const eventGuidance = extractGuidance(envelope)
    run.guidance = run.guidance ?? eventGuidance.guidance
    run.sealedOpenRatio = eventGuidance.sealedOpenRatio ?? run.sealedOpenRatio ?? ratioFromMeasurements(run.measurements)
    run.sampleQuality = combineSampleQuality(
      run.sampleQuality,
      eventGuidance.sampleQuality,
      compactValidityQuality(data),
      sampleQualityFromMeasurements(run.measurements),
    )
    run.rawEvents.push(event)
    run.eventCount = run.rawEvents.length
    runs.set(id, run)
  }

  const completedRuns = [...runs.values()].map((run) => {
    const derived = deriveGuidanceFromMeasurements(run.measurements as Record<string, MeasurementSummary>)
    return {
      ...run,
      guidance: run.guidance ?? derived.guidance,
      sealedOpenRatio: run.sealedOpenRatio ?? derived.sealedOpenRatio,
      sampleQuality: combineSampleQuality(run.sampleQuality, derived.sampleQuality),
    }
  })

  const attemptsByCartridge = new Map<string, CartridgeHistoryRun[]>()
  for (const run of completedRuns) {
    const key = run.cartridgeSerial ?? run.id
    attemptsByCartridge.set(key, [...(attemptsByCartridge.get(key) ?? []), run])
  }
  for (const attempts of attemptsByCartridge.values()) {
    attempts.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    attempts.forEach((run, index) => {
      run.attemptIndex = index + 1
      run.attemptCount = attempts.length
    })
  }

  return completedRuns.sort((a, b) => b.completedAt.localeCompare(a.completedAt))
}

export function latestRunsByCartridge(runs: CartridgeHistoryRun[]): CartridgeHistoryRun[] {
  const latest = new Map<string, CartridgeHistoryRun>()
  for (const run of runs) {
    const key = run.cartridgeSerial ?? run.id
    const existing = latest.get(key)
    if (!existing || run.completedAt.localeCompare(existing.completedAt) > 0) {
      latest.set(key, run)
    }
  }
  return [...latest.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt))
}

export function filterCartridgeHistoryRuns(
  runs: CartridgeHistoryRun[],
  filters: CartridgeHistoryFilters,
): CartridgeHistoryRun[] {
  const attemptScopedRuns = filters.attemptView === 'latest' ? latestRunsByCartridge(runs) : runs
  return attemptScopedRuns.filter((run) => {
    if (filters.operator && filters.operator !== 'all' && (run.operator ?? 'unknown') !== filters.operator) return false
    if (filters.productionBatch && filters.productionBatch !== 'all' && (run.productionBatch ?? 'unknown') !== filters.productionBatch) return false
    if (filters.appVersion && filters.appVersion !== 'all' && (run.appVersion ?? 'unknown') !== filters.appVersion) return false
    if (filters.result && filters.result !== 'all' && cartridgeHistoryResult(run) !== filters.result) return false
    return true
  })
}

export function cartridgeHistoryResult(run: CartridgeHistoryRun): CartridgeHistoryResult {
  if (run.sampleQuality === 'repeat') return 'repeat'
  switch (run.guidance) {
    case 'ACCEPT_SINGLE_PASS':
      return 'accept'
    case 'RESEAT_AND_REPEAT_BORDERLINE':
      return 'borderline'
    case 'RESEAT_AND_REPEAT_SUSPECT_FAIL':
      return 'suspect'
    case 'REPEAT_MEASUREMENT_QUALITY':
    case 'REPEAT_INVALID_RATIO':
      return 'repeat'
    default:
      if (typeof run.sealedOpenRatio !== 'number') return 'unknown'
      if (run.sealedOpenRatio < 0.25) return 'accept'
      if (run.sealedOpenRatio < 0.28) return 'borderline'
      return 'suspect'
  }
}

export function summarizeCartridgeHistory(runs: CartridgeHistoryRun[]) {
  const uniqueCartridges = new Set(runs.map((run) => run.cartridgeSerial).filter(Boolean))
  const ratios = runs
    .map((run) => run.sealedOpenRatio)
    .filter((ratio): ratio is number => typeof ratio === 'number' && Number.isFinite(ratio))
    .sort((a, b) => a - b)
  const resultCounts = {
    accept: 0,
    borderline: 0,
    suspect: 0,
    repeat: 0,
    unknown: 0,
  }
  for (const run of runs) {
    resultCounts[cartridgeHistoryResult(run)] += 1
  }

  return {
    runCount: runs.length,
    uniqueCartridgeCount: uniqueCartridges.size,
    resultCounts,
    ratioMin: ratios[0],
    ratioMedian: ratios.length ? ratios[Math.floor(ratios.length / 2)] : undefined,
    ratioMax: ratios.at(-1),
    repeatAttemptCount: runs.filter((run) => run.attemptCount > 1).length,
    operators: uniqueDefined(runs.map((run) => run.operator)),
    productionBatches: uniqueDefined(runs.map((run) => run.productionBatch)),
    appVersions: uniqueDefined(runs.map((run) => run.appVersion ?? 'unknown')),
  }
}

function createEmptyRun(id: string, timestamp: string): CartridgeHistoryRun {
  return {
    id,
    startedAt: timestamp,
    completedAt: timestamp,
    measurements: {},
    eventCount: 0,
    rawEvents: [],
    attemptIndex: 1,
    attemptCount: 1,
  }
}

function eventEnvelopeFromRecord(event: StoredMirroredEventRecord): GuiEventEnvelope {
  const record = event.record
  return {
    type: 'event',
    event_name: record.event_name,
    data: record.data,
    device_id: record.device_id,
    product_id: record.product_id,
    firmware_version: record.firmware_version,
  }
}

function measurementFromSummary(data: Record<string, unknown>, phase: TestPhase): MeasurementSummary | undefined {
  const source = measurementSourceForPhase(data, phase)
  const slpm = asNumber(source.slpm)
    ?? asNumber(source.flow_slpm_mean)
    ?? asNumber(data[`${phase}_slpm`])
    ?? asNumber(data[phase === 'open' ? 'o_slpm' : phase === 'nozzle' ? 'n_slpm' : 's_slpm'])
  if (slpm === undefined) return undefined

  const qualityOk = asBoolean(source.quality_ok) ?? asBoolean(source.q)
  return {
    phase,
    valid: asBoolean(source.valid) ?? qualityOk,
    sample_count: asNumber(source.sample_count) ?? asNumber(source.cnt),
    slpm,
    raw_mean_slpm: asNumber(source.flow_slpm_raw_mean) ?? asNumber(source.raw_mean_slpm) ?? asNumber(source.raw) ?? slpm,
    median_slpm: asNumber(source.flow_slpm_median) ?? asNumber(source.median_slpm) ?? asNumber(source.med) ?? slpm,
    stddev_slpm: asNumber(source.flow_slpm_stddev) ?? asNumber(source.stddev_slpm) ?? asNumber(source.sd) ?? 0,
    min_slpm: asNumber(source.flow_slpm_min) ?? asNumber(source.min_slpm) ?? asNumber(source.min) ?? slpm,
    max_slpm: asNumber(source.flow_slpm_max) ?? asNumber(source.max_slpm) ?? asNumber(source.max) ?? slpm,
    trimmed_count: asNumber(source.trimmed_sample_count) ?? asNumber(source.trimmed_count) ?? asNumber(source.trim_cnt),
    outlier_count: asNumber(source.outlier_count) ?? asNumber(source.out),
    coefficient_of_variation: asNumber(source.coefficient_of_variation) ?? asNumber(source.cv) ?? 0,
    sample_quality:
      source.sample_quality === 'repeat' || qualityOk === false || asBoolean(source.valid) === false
        ? 'repeat'
        : 'acceptable',
    stability_limit_slpm: asNumber(source.stability_limit_slpm),
    settle_ms: asNumber(source.settle_ms) ?? 12000,
    dt_ms: asNumber(source.dt_ms) ?? 100,
    fan_pwm_pct: asNumber(source.fan_pwm_pct) ?? asNumber(source.pwm),
    rpm: asNumber(source.rpm),
    pressure_hpa: asNumber(source.pressure_hpa) ?? asNumber(source.p),
    temperature_c: asNumber(source.temperature_c) ?? asNumber(source.t),
    environment_source: firstString(source.environment_source, source.src),
    flow_lpm_mean: asNumber(source.flow_lpm_mean) ?? asNumber(source.lpm),
    flow_slpm_samples: asNumberArray(source.flow_slpm_samples),
  }
}

function measurementSourceForPhase(data: Record<string, unknown>, phase: TestPhase): Record<string, unknown> {
  if (phase === 'open') return firstRecord(data.open, data.o)
  if (phase === 'nozzle') return firstRecord(data.nozzle, data.n)
  return firstRecord(data.sealed, data.s)
}

function ratioFromMeasurements(measurements: Partial<Record<TestPhase, MeasurementSummary>>): number | undefined {
  const open = measurements.open
  const sealed = measurements.sealed
  if (!open || !sealed || open.slpm <= 0) return undefined
  const ratio = sealed.slpm / open.slpm
  return Number.isFinite(ratio) ? ratio : undefined
}

function sampleQualityFromMeasurements(measurements: Partial<Record<TestPhase, MeasurementSummary>>): string | undefined {
  const available = PHASES.map((phase) => measurements[phase]).filter(Boolean) as MeasurementSummary[]
  if (!available.length) return undefined
  return available.every((measurement) => measurement.valid !== false && measurement.sample_quality === 'acceptable')
    ? 'acceptable'
    : 'repeat'
}

function compactValidityQuality(data: Record<string, unknown>): string | undefined {
  const ratios = firstRecord(data.r, data.ratios)
  return asBoolean(ratios.valid) === false ? 'repeat' : undefined
}

function mergeSummaryMeasurement(
  existing: MeasurementSummary | undefined,
  summary: MeasurementSummary,
): MeasurementSummary {
  if (!existing) return summary
  const quality = combineSampleQuality(existing.sample_quality, summary.sample_quality)
  return {
    ...summary,
    ...existing,
    valid: existing.valid === false || summary.valid === false ? false : existing.valid ?? summary.valid,
    sample_quality: quality === 'repeat' || quality === 'acceptable' ? quality : existing.sample_quality,
  }
}

function combineSampleQuality(...values: Array<string | undefined>): string | undefined {
  if (values.some((value) => value === 'repeat')) return 'repeat'
  if (values.some((value) => value === 'acceptable')) return 'acceptable'
  return undefined
}

function eventTime(event: StoredMirroredEventRecord): string {
  return event.created_at || event.record.local_timestamp || ''
}

function earlierTimestamp(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  return left.localeCompare(right) <= 0 ? left : right
}

function laterTimestamp(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  return left.localeCompare(right) >= 0 ? left : right
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = asRecord(value)
    if (Object.keys(record).length > 0) return record
  }
  return {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value)
    if (text) return text
  }
  return undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const samples = value.filter((sample): sample is number => typeof sample === 'number' && Number.isFinite(sample))
  return samples.length ? samples : undefined
}
