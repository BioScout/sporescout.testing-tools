import {
  CARTRIDGE_PROFILE,
  CARTRIDGE_READINESS_COMMAND,
  type GuiEventEnvelope,
  type GuiResponseEnvelope,
  type MeasurementSummary,
  type ReadinessItem,
  type TestPhase,
} from './contracts'

export const READINESS_ITEMS: ReadinessItem[] = [
  {
    id: 'firmware',
    label: 'Checking firmware version',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Prepares the tester, then confirms firmware and hardware versions. Command: test cartridge_leak prepare.',
    status: 'pending',
  },
  {
    id: 'active_run_clear',
    label: 'Checking active run state',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Confirms there is no unfinished cartridge test run before a new cartridge starts.',
    status: 'pending',
  },
  {
    id: 'idle_state',
    label: 'Checking tester idle state',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Confirms firmware is in Idle before starting the cartridge workflow.',
    status: 'pending',
  },
  {
    id: 'station_self_check',
    label: 'Checking station self test status',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Confirms station power, flow-sensor presence, and fan command path before open starts.',
    status: 'pending',
  },
  {
    id: 'tester_power',
    label: 'Checking tester power',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Checks the tester power needed for cartridge measurements.',
    status: 'pending',
  },
  {
    id: 'cm4_power',
    label: 'Checking tester computer power',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Checks the internal tester computer power before trusting lock state.',
    status: 'pending',
  },
  {
    id: 'cm4_ready',
    label: 'Checking tester computer readiness',
    command: CARTRIDGE_READINESS_COMMAND,
    info: 'Confirms the internal tester computer is ready before any solenoid state is trusted.',
    status: 'pending',
  },
  {
    id: 'solenoid_locked',
    label: 'Checking solenoid lock state',
    command: 'solenoid IsUnlocked',
    info: 'Runs after tester readiness. The solenoid is safe only when this returns locked.',
    status: 'pending',
  },
]

export type WorkflowStepId =
  | 'connect'
  | 'ready'
  | 'insert'
  | 'scan'
  | 'test'
  | 'remove'
  | 'next'

export interface WorkflowStep {
  id: WorkflowStepId
  label: string
  status: 'pending' | 'active' | 'complete' | 'failed'
}

export const FLOW_STEPS: WorkflowStep[] = [
  { id: 'connect', label: 'Connect', status: 'active' },
  { id: 'ready', label: 'Ready', status: 'pending' },
  { id: 'insert', label: 'Insert Cartridge', status: 'pending' },
  { id: 'test', label: 'Test', status: 'pending' },
  { id: 'remove', label: 'Remove', status: 'pending' },
  { id: 'next', label: 'Next / Exit', status: 'pending' },
]

export function buildReadinessItems(): ReadinessItem[] {
  return READINESS_ITEMS.map((item) => ({ ...item }))
}

export function markReadinessItem(
  items: ReadinessItem[],
  id: string,
  status: ReadinessItem['status'],
  detail?: string,
): ReadinessItem[] {
  return items.map((item) => (item.id === id ? { ...item, status, detail } : item))
}

export function markAllReadinessItems(items: ReadinessItem[], status: ReadinessItem['status']): ReadinessItem[] {
  return items.map((item) => ({ ...item, status, detail: undefined }))
}

export function markReadinessCommandItemsRunning(items: ReadinessItem[]): ReadinessItem[] {
  return items.map((item) => ({
    ...item,
    status: item.command === CARTRIDGE_READINESS_COMMAND ? 'running' : 'pending',
    detail: undefined,
  }))
}

export function applyCartridgeReadinessResult(
  items: ReadinessItem[],
  result: unknown,
): { items: ReadinessItem[]; ready: boolean; operatorAction?: string } {
  const response = asRecord(result)
  const checks = asRecord(response.checks)
  const operatorAction = asString(response.operator_action)
  const ready = response.ready === true || response.ready === 1 || response.status === 'READY'

  return {
    ready,
    operatorAction,
    items: items.map((item) => {
      if (item.id === 'firmware') {
        const firmwareVersion = asNumber(response.firmware_version)
        const hardwareVersion = asString(response.hardware_version)
        const detail = [firmwareVersion ? `firmware ${firmwareVersion}` : 'firmware reported', hardwareVersion]
          .filter(Boolean)
          .join(', ')
        return { ...item, status: 'passed', detail }
      }

      const rawCheck = checks[item.id] ?? response[`check_${item.id}`]
      if (typeof rawCheck === 'number') {
        const skippedDetail =
          item.id === 'station_self_check'
            ? asString(response.station_self_check_message) ?? 'Station self-check waits for tester power.'
            : item.id === 'solenoid_locked'
              ? 'Checked next after tester computer readiness.'
              : 'Skipped by firmware'
        return {
          ...item,
          status: rawCheck === 1 ? 'passed' : rawCheck === -1 ? 'pending' : 'failed',
          detail: rawCheck === 1 ? 'Ready' : rawCheck === -1 ? skippedDetail : 'Needs attention',
        }
      }
      if (typeof rawCheck === 'boolean') {
        return { ...item, status: rawCheck ? 'passed' : 'failed', detail: rawCheck ? 'Ready' : 'Needs attention' }
      }

      const check = asRecord(rawCheck)
      if (Object.keys(check).length === 0) {
        return { ...item, status: 'failed', detail: 'Missing readiness result' }
      }

      const skipped = check.skipped === true
      const ok = check.ok === true
      const message = asString(check.message) ?? (ok ? 'Ready' : 'Needs attention')
      return {
        ...item,
        status: ok ? 'passed' : skipped ? 'pending' : 'failed',
        detail: message,
      }
    }),
  }
}

export function isReadinessAutoRetryable(result: unknown): boolean {
  const response = asRecord(result)
  const checks = asRecord(response.checks)
  const testerPower = readinessCheckPassed(checks.tester_power ?? response.check_tester_power)
  const cm4Power = readinessCheckPassed(checks.cm4_power ?? response.check_cm4_power)
  const cm4Ready = readinessCheckPassed(checks.cm4_ready ?? response.check_cm4_ready)
  const stationBootReady = readinessCheckPassed(checks.station_boot_ready ?? response.check_station_boot_ready)
  const ready = response.ready === true || response.ready === 1 || response.status === 'READY'

  return !ready && testerPower === true && cm4Power === true && cm4Ready === false && stationBootReady !== false
}

export function buildCartridgeOpenCommand(
  cartridgeSerial: string,
  enclosureBaseId: string,
): string {
  return `test cartridge_leak open ${cartridgeSerial} ${enclosureBaseId} ${CARTRIDGE_PROFILE}`
}

export function buildCartridgePhaseCommand(
  phase: Exclude<TestPhase, 'open'>,
  runUid: string,
  hardwareId: string,
): string {
  return `test cartridge_leak ${phase} ${runUid} ${hardwareId}`
}

export function extractRunUid(response: GuiResponseEnvelope): string | undefined {
  if (!response.ok) {
    return undefined
  }

  const result = asRecord(response.result)
  return asString(result.run_uid) ?? asString(result.runUid)
}

export function extractGuidance(event: GuiEventEnvelope): {
  guidance?: string
  sealedOpenRatio?: number
  sampleQuality?: string
} {
  const context = asRecord(event.data.context)
  const compactRatios = asRecord(event.data.r)
  const contextRatios = asRecord(context.r)
  const ratios = asRecord(event.data.ratios)
  const sealed = asRecord(event.data.sealed)
  const compactSealed = asRecord(event.data.s)
  return {
    guidance:
      asString(event.data.guidance) ??
      asString(event.data.phase1_guidance) ??
      asString(event.data.g) ??
      asString(context.g),
    sealedOpenRatio:
      asNumber(event.data.sealed_open_ratio) ??
      asNumber(ratios.sealed_open_ratio) ??
      asNumber(ratios.so) ??
      asNumber(compactRatios.so) ??
      asNumber(contextRatios.so),
    sampleQuality:
      asString(event.data.sample_quality) ??
      (asBoolean(sealed.quality_ok) === false || asBoolean(sealed.q) === false || asBoolean(compactSealed.q) === false
        ? 'repeat'
        : asBoolean(sealed.quality_ok) === true || asBoolean(sealed.q) === true || asBoolean(compactSealed.q) === true
          ? 'acceptable'
          : undefined),
  }
}

export function deriveGuidanceFromMeasurements(measurements: Record<string, MeasurementSummary>): {
  guidance?: string
  sealedOpenRatio?: number
  sampleQuality?: string
} {
  const open = measurements.open
  const nozzle = measurements.nozzle
  const sealed = measurements.sealed
  if (!open || !sealed || open.slpm <= 0) {
    return {}
  }

  const sampleQuality =
    measurementIsAcceptable(open) &&
    measurementIsAcceptable(sealed) &&
    (!nozzle || measurementIsAcceptable(nozzle))
      ? 'acceptable'
      : 'repeat'
  const sealedOpenRatio = sealed.slpm / open.slpm
  if (!Number.isFinite(sealedOpenRatio)) {
    return {
      guidance: 'REPEAT_INVALID_RATIO',
      sampleQuality,
    }
  }

  if (sampleQuality !== 'acceptable') {
    return {
      guidance: 'REPEAT_MEASUREMENT_QUALITY',
      sealedOpenRatio,
      sampleQuality,
    }
  }

  if (sealedOpenRatio < 0.25) {
    return {
      guidance: 'ACCEPT_SINGLE_PASS',
      sealedOpenRatio,
      sampleQuality,
    }
  }

  if (sealedOpenRatio < 0.28) {
    return {
      guidance: 'RESEAT_AND_REPEAT_BORDERLINE',
      sealedOpenRatio,
      sampleQuality,
    }
  }

  return {
    guidance: 'RESEAT_AND_REPEAT_SUSPECT_FAIL',
    sealedOpenRatio,
    sampleQuality,
  }
}

export function extractMeasurement(event: GuiEventEnvelope): MeasurementSummary | null {
  const context = asRecord(event.data.context)
  const artifacts = asRecord(event.data.artifacts)
  const artifactMeasurement = asRecord(artifacts.measurement)
  const compactMeasurement = asRecord(context.m)
  const source = Object.keys(artifactMeasurement).length
    ? artifactMeasurement
    : Object.keys(compactMeasurement).length
      ? compactMeasurement
      : event.data

  const phase = asString(event.data.phase) ?? phaseFromStepName(asString(event.data.step_name))
  if (phase !== 'open' && phase !== 'nozzle' && phase !== 'sealed') {
    return null
  }

  const slpm = asNumber(source.flow_slpm_mean) ?? asNumber(source.slpm)
  if (slpm === undefined) {
    return null
  }

  const qualityOk = asBoolean(source.quality_ok) ?? asBoolean(source.q)
  const valid = asBoolean(source.valid)
  return {
    phase,
    valid,
    sample_count: asNumber(source.sample_count) ?? asNumber(source.cnt),
    slpm,
    raw_mean_slpm: asNumber(source.flow_slpm_raw_mean) ?? asNumber(source.raw_mean_slpm) ?? asNumber(source.raw) ?? slpm,
    median_slpm: asNumber(source.flow_slpm_median) ?? asNumber(source.median_slpm) ?? asNumber(source.med) ?? slpm,
    stddev_slpm: asNumber(source.flow_slpm_stddev) ?? asNumber(source.stddev_slpm) ?? asNumber(source.sd) ?? 0,
    min_slpm: asNumber(source.flow_slpm_min) ?? asNumber(source.min_slpm) ?? asNumber(source.min) ?? slpm,
    max_slpm: asNumber(source.flow_slpm_max) ?? asNumber(source.max_slpm) ?? asNumber(source.max) ?? slpm,
    trimmed_count: asNumber(source.trimmed_sample_count) ?? asNumber(source.trimmed_count) ?? asNumber(source.trim_cnt) ?? 24,
    outlier_count: asNumber(source.outlier_count) ?? asNumber(source.out) ?? 6,
    coefficient_of_variation:
      asNumber(source.coefficient_of_variation) ?? asNumber(source.cv) ?? 0,
    sample_quality:
      source.sample_quality === 'repeat' || qualityOk === false || valid === false ? 'repeat' : 'acceptable',
    stability_limit_slpm: asNumber(source.stability_limit_slpm),
    settle_ms: asNumber(source.settle_ms) ?? 12000,
    dt_ms: asNumber(source.dt_ms) ?? 100,
    fan_pwm_pct: asNumber(source.fan_pwm_pct) ?? asNumber(source.pwm),
    rpm: asNumber(source.rpm),
    pressure_hpa: asNumber(source.pressure_hpa) ?? asNumber(source.p),
    temperature_c: asNumber(source.temperature_c) ?? asNumber(source.t),
    environment_source: asString(source.environment_source) ?? asString(source.src),
    flow_lpm_mean: asNumber(source.flow_lpm_mean) ?? asNumber(source.lpm),
    flow_slpm_samples: asNumberArray(source.flow_slpm_samples),
  }
}

function measurementIsAcceptable(measurement: MeasurementSummary): boolean {
  return measurement.valid !== false && measurement.sample_quality === 'acceptable'
}

export function progressLabel(phase: TestPhase, elapsedMs: number): string {
  if (elapsedMs < 12000) {
    const secondsRemaining = Math.max(0, Math.ceil((12000 - elapsedMs) / 1000))
    return `${capitalize(phase)} settling, ${secondsRemaining}s`
  }

  const sampleIndex = Math.min(30, Math.max(0, Math.floor((elapsedMs - 12000) / 100)))
  return `${capitalize(phase)} sampling ${sampleIndex}/30`
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readinessCheckPassed(value: unknown): boolean | undefined {
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value === 'boolean') return value

  const check = asRecord(value)
  if (Object.keys(check).length === 0) return undefined
  if (check.skipped === true) return undefined
  return check.ok === true
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const samples = value.filter((sample): sample is number => typeof sample === 'number' && Number.isFinite(sample))
  return samples.length ? samples : undefined
}

function phaseFromStepName(stepName?: string): TestPhase | undefined {
  if (!stepName) return undefined
  if (stepName.includes('OPEN')) return 'open'
  if (stepName.includes('NOZZLE')) return 'nozzle'
  if (stepName.includes('SEALED')) return 'sealed'
  return undefined
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
