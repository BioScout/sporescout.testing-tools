import {
  LINEAR_STAGE_MODE_COMMANDS,
  linearStageModeForCommand,
  type LinearStageMode,
} from '../../shared/contracts'

export interface LinearStageModeConfig {
  mode: LinearStageMode
  label: string
  shortLabel: string
  command: string
  scope: string
  operatorNote: string
  plannedSteps: readonly string[]
}

const MECHANICAL_AXIS_STEPS = [
  'X home switch qualification',
  'X positive boundary qualification',
  'X span qualification',
  'X derated current margin',
  'X front-limit diagnosis',
  'Y home switch qualification',
  'Y positive boundary qualification',
  'Y span qualification',
  'Y derated current margin',
  'Z home switch qualification',
  'Z positive boundary qualification',
  'Z span qualification',
  'Z derated current margin',
] as const

const OPTICAL_AXIS_STEPS = [
  'X optical qualification',
  'Y optical qualification',
  'Z optical qualification',
] as const

export const LINEAR_STAGE_MODE_CONFIGS: Record<LinearStageMode, LinearStageModeConfig> = {
  full: {
    mode: 'full',
    label: 'Full test',
    shortLabel: 'Full',
    command: LINEAR_STAGE_MODE_COMMANDS.full,
    scope: 'Complete mechanical, optical, and scan-audit validation.',
    operatorNote: 'Uses the stage and microscope.',
    plannedSteps: [
      'Check dependencies',
      'CM4 task running',
      'Initialise Steppers',
      ...MECHANICAL_AXIS_STEPS,
      'Select optical region',
      '3x3 scan audit',
      ...OPTICAL_AXIS_STEPS,
      'Park Steppers',
    ],
  },
  mechanics: {
    mode: 'mechanics',
    label: 'Mechanics-only / no optics',
    shortLabel: 'Mechanics',
    command: LINEAR_STAGE_MODE_COMMANDS.mechanics,
    scope: 'Linear-stage checks that do not require microscope or optical artifacts.',
    operatorNote: 'Moves the stage without microscope-dependent checks.',
    plannedSteps: [
      'Check dependencies',
      'CM4 task running',
      'Initialise Steppers',
      ...MECHANICAL_AXIS_STEPS,
      'Park Steppers',
    ],
  },
  optics: {
    mode: 'optics',
    label: 'Optics-only',
    shortLabel: 'Optics',
    command: LINEAR_STAGE_MODE_COMMANDS.optics,
    scope: 'Microscope and scan checks using an already validated linear stage.',
    operatorNote: 'Still homes, moves, scans, and parks the stage.',
    plannedSteps: [
      'Check dependencies',
      'CM4 task running',
      'Initialise Steppers',
      'Select optical region',
      '3x3 scan audit',
      ...OPTICAL_AXIS_STEPS,
      'Park Steppers',
    ],
  },
} as const

export const LINEAR_STAGE_MODE_ORDER: readonly LinearStageMode[] = ['full', 'mechanics', 'optics'] as const

export function commandForLinearStageMode(mode: LinearStageMode): string {
  return LINEAR_STAGE_MODE_CONFIGS[mode].command
}

export function modeForLinearStageCommand(command: string): LinearStageMode | undefined {
  return linearStageModeForCommand(command)
}

export function plannedStepsForLinearStageMode(mode: LinearStageMode | undefined): readonly string[] {
  return LINEAR_STAGE_MODE_CONFIGS[mode ?? 'full'].plannedSteps
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
  const normalized = value.trim().toLowerCase()
  return LINEAR_STAGE_MODE_ORDER.find((mode) => mode === normalized)
}

function normalizeStepName(value: string | undefined): string {
  return (value ?? '').replace(/^\d+\s*\|\s*/, '').trim().toLowerCase()
}
