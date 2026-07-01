import {
  LINEAR_STAGE_MODE_SESSION_TYPES,
  LINEAR_STAGE_SESSION_TYPE_MODES,
  buildLinearStageSuiteCommand,
  linearStageModeForCommand,
  parseLinearStageSuiteCommand,
  type LinearStageMode,
  type LinearStageSessionType,
} from '../../shared/contracts'

export interface LinearStageModeConfig {
  mode: LinearStageMode
  sessionType: LinearStageSessionType
  label: string
  shortLabel: string
  profile: 'production' | 'service'
  testMode: 'full_function' | 'mechanics_only' | 'optics_only'
  uploadScanArtifacts: boolean
  suiteMode: 'Production' | 'Deployment' | 'Service'
  scope: string
  operatorNote: string
  timeoutLabel: string
  timeoutMs: number
  plannedSteps: readonly string[]
}

const POWER_AND_SESSION_WITH_UPLOAD = [
  'Enable 5V AUX rail',
  'Connect 24V AUX',
  'Enable 24V AUX',
  'Connect modem',
  'Wait for CM4 readiness',
  'Check camera connection',
  'Check camera image capture',
  'Check camera LED',
  'Wait for internet readiness',
  'Authenticate BioScout API',
  'Connect steppers',
  'Start CM4 session',
  'Initialize steppers',
] as const

const POWER_AND_SESSION_MECHANICS = [
  'Enable 5V AUX rail',
  'Connect 24V AUX',
  'Enable 24V AUX',
  'Wait for CM4 readiness',
  'Connect steppers',
  'Start CM4 session',
  'Initialize steppers',
] as const

const POWER_AND_SESSION_WITH_CAMERA = [
  'Enable 5V AUX rail',
  'Connect 24V AUX',
  'Enable 24V AUX',
  'Wait for CM4 readiness',
  'Check camera connection',
  'Check camera image capture',
  'Check camera LED',
  'Connect steppers',
  'Start CM4 session',
  'Initialize steppers',
] as const

const MECHANICS_STEPS = [
  'X home switch',
  'X hard limit',
  'X span',
  'X current margin',
  'Y home switch',
  'Y hard limit',
  'Y span',
  'Y current margin',
  'Z home switch',
  'Z hard limit',
  'Z span',
  'Z current margin',
] as const

const PRODUCTION_OPTICS_STEPS = [
  'Optical region selection',
  'Home tile capture',
  'Production workspace stress',
  'X focus',
  'Y displacement',
  'Z displacement',
] as const

const SCAN_UPLOAD_STEPS = [
  'Scan capture',
  'Scan audit',
  'Artifact generation',
  'Upload',
] as const

const PRODUCTION_CLEANUP_STEPS = [
  'Post-stress recovery',
  'Park/cleanup',
  'Close CM4 session',
  'Restore power state',
  'Linear-stage verdict',
] as const

const CLEANUP_STEPS = [
  'Park/cleanup',
  'Close CM4 session',
  'Restore power state',
  'Linear-stage verdict',
] as const

export const LINEAR_STAGE_MODE_CONFIGS: Record<LinearStageMode, LinearStageModeConfig> = {
  production_full: {
    mode: 'production_full',
    sessionType: LINEAR_STAGE_MODE_SESSION_TYPES.production_full,
    label: 'Production full',
    shortLabel: 'Production',
    profile: 'production',
    testMode: 'full_function',
    uploadScanArtifacts: true,
    suiteMode: 'Production',
    scope: 'Production mechanics, optical displacement, stress, scan audit, artifact generation, and upload.',
    operatorNote: 'Requires CM4 readiness, internet, BioScout API authentication, microscope optics, and clear stage travel.',
    timeoutLabel: '120 min suite budget',
    timeoutMs: 120 * 60 * 1000,
    plannedSteps: [
      ...POWER_AND_SESSION_WITH_UPLOAD,
      ...MECHANICS_STEPS,
      ...PRODUCTION_OPTICS_STEPS,
      ...SCAN_UPLOAD_STEPS,
      ...PRODUCTION_CLEANUP_STEPS,
    ],
  },
  mechanics_only: {
    mode: 'mechanics_only',
    sessionType: LINEAR_STAGE_MODE_SESSION_TYPES.mechanics_only,
    label: 'Mechanics only',
    shortLabel: 'Mechanics',
    profile: 'service',
    testMode: 'mechanics_only',
    uploadScanArtifacts: false,
    suiteMode: 'Service',
    scope: 'Service mechanics run for home switches, hard limits, span, current margin, and cleanup.',
    operatorNote: 'No modem, internet, optical scan, artifact generation, or upload path is used.',
    timeoutLabel: '75 min suite budget',
    timeoutMs: 75 * 60 * 1000,
    plannedSteps: [
      ...POWER_AND_SESSION_MECHANICS,
      ...MECHANICS_STEPS,
      ...CLEANUP_STEPS,
    ],
  },
  optics_only: {
    mode: 'optics_only',
    sessionType: LINEAR_STAGE_MODE_SESSION_TYPES.optics_only,
    label: 'Optics only',
    shortLabel: 'Optics',
    profile: 'production',
    testMode: 'optics_only',
    uploadScanArtifacts: false,
    suiteMode: 'Production',
    scope: 'Production optics run using an already qualified mechanism, including camera preflight and stress recovery.',
    operatorNote: 'Runs camera checks, optical region selection, home-tile capture, focus/displacement checks, stress, and cleanup without the scan upload path.',
    timeoutLabel: '75 min suite budget',
    timeoutMs: 75 * 60 * 1000,
    plannedSteps: [
      ...POWER_AND_SESSION_WITH_CAMERA,
      ...PRODUCTION_OPTICS_STEPS,
      ...PRODUCTION_CLEANUP_STEPS,
    ],
  },
} as const

export const LINEAR_STAGE_MODE_ORDER: readonly LinearStageMode[] = [
  'production_full',
  'mechanics_only',
  'optics_only',
] as const

export function commandForLinearStageMode(mode: LinearStageMode, sessionId = 1): string {
  return buildLinearStageSuiteCommand(mode, sessionId)
}

export function modeForLinearStageCommand(command: string): LinearStageMode | undefined {
  return linearStageModeForCommand(command)
}

export function suiteRequestForLinearStageCommand(command: string) {
  return parseLinearStageSuiteCommand(command)
}

export function plannedStepsForLinearStageMode(mode: LinearStageMode | undefined): readonly string[] {
  return LINEAR_STAGE_MODE_CONFIGS[mode ?? 'production_full'].plannedSteps
}

export function plannedStepNumberForLinearStageMode(stepName: string, mode?: LinearStageMode): number {
  const steps = plannedStepsForLinearStageMode(mode)
  const modeIndex = knownPlannedStepNumberForLinearStageMode(stepName, mode)
  if (modeIndex !== undefined) return modeIndex

  for (const candidate of LINEAR_STAGE_MODE_ORDER) {
    const index = knownPlannedStepNumberForLinearStageMode(stepName, candidate)
    if (index !== undefined) return index
  }

  return steps.length + 1
}

export function knownPlannedStepNumberForLinearStageMode(stepName: string | undefined, mode?: LinearStageMode): number | undefined {
  const normalized = normalizeStepName(stepName)
  if (!normalized) return undefined
  const steps = plannedStepsForLinearStageMode(mode)
  const modeIndex = steps.findIndex((name) => normalizeStepName(name) === normalized)
  return modeIndex === -1 ? undefined : modeIndex + 1
}

export function normalizeLinearStageMode(value: unknown): LinearStageMode | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  const explicitMode = LINEAR_STAGE_MODE_ORDER.find((mode) => mode === normalized)
  if (explicitMode) return explicitMode
  const sessionType = value.trim().toUpperCase()
  return sessionType in LINEAR_STAGE_SESSION_TYPE_MODES
    ? LINEAR_STAGE_SESSION_TYPE_MODES[sessionType as keyof typeof LINEAR_STAGE_SESSION_TYPE_MODES]
    : undefined
}

function normalizeStepName(value: string | undefined): string {
  return (value ?? '').replace(/^\d+\s*\|\s*/, '').trim().toLowerCase()
}
