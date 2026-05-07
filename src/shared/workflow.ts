import {
  CARTRIDGE_PROFILE,
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
    command: 'system GetFirmwareVersion',
    info: 'Confirms the tester is running the expected firmware. Command: system GetFirmwareVersion.',
    status: 'pending',
  },
  {
    id: 'self-test',
    label: 'Running tester self check',
    command: 'test self_check',
    info: 'Runs the built-in tester self check before cartridge testing starts. Command: test self_check.',
    status: 'pending',
  },
  {
    id: 'power',
    label: 'Checking tester power',
    command: 'load_switch_24v_aux_in IsConnected',
    info: 'Checks that the internal power path needed for the test is available. Command: load_switch_24v_aux_in IsConnected.',
    status: 'pending',
  },
  {
    id: 'solenoid',
    label: 'Checking solenoid lock state',
    command: 'solenoid IsLocked',
    info: 'Confirms the cartridge lock is in the locked state before the next step. Command: solenoid IsLocked.',
    status: 'pending',
  },
  {
    id: 'idle',
    label: 'Checking tester idle state',
    command: 'system GetIdleState',
    info: 'Confirms the tester is idle before starting the cartridge workflow. Command: system GetIdleState.',
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
  return {
    guidance: asString(event.data.guidance),
    sealedOpenRatio: asNumber(event.data.sealed_open_ratio),
    sampleQuality: asString(event.data.sample_quality),
  }
}

export function extractMeasurement(event: GuiEventEnvelope): MeasurementSummary | null {
  const phase = asString(event.data.phase)
  if (phase !== 'open' && phase !== 'nozzle' && phase !== 'sealed') {
    return null
  }

  const slpm = asNumber(event.data.slpm)
  if (slpm === undefined) {
    return null
  }

  return {
    phase,
    slpm,
    raw_mean_slpm: asNumber(event.data.raw_mean_slpm) ?? slpm,
    median_slpm: asNumber(event.data.median_slpm) ?? slpm,
    stddev_slpm: asNumber(event.data.stddev_slpm) ?? 0,
    min_slpm: asNumber(event.data.min_slpm) ?? slpm,
    max_slpm: asNumber(event.data.max_slpm) ?? slpm,
    trimmed_count: asNumber(event.data.trimmed_count) ?? 24,
    outlier_count: asNumber(event.data.outlier_count) ?? 6,
    coefficient_of_variation: asNumber(event.data.coefficient_of_variation) ?? 0,
    sample_quality: event.data.sample_quality === 'repeat' ? 'repeat' : 'acceptable',
    settle_ms: asNumber(event.data.settle_ms) ?? 12000,
    dt_ms: asNumber(event.data.dt_ms) ?? 100,
  }
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

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
