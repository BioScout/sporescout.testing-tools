import { describe, expect, it } from 'vitest'
import {
  LINEAR_STAGE_MODE_CONFIGS,
  commandForLinearStageMode,
  modeForLinearStageCommand,
  plannedStepNumberForLinearStageMode,
  plannedStepsForLinearStageMode,
  knownPlannedStepNumberForLinearStageMode,
} from './linearStageWorkflow'

describe('linearStageWorkflow', () => {
  it('maps the three operator modes to explicit firmware commands', () => {
    expect(commandForLinearStageMode('full')).toBe('test linear_stage full')
    expect(commandForLinearStageMode('mechanics')).toBe('test linear_stage mechanics')
    expect(commandForLinearStageMode('optics')).toBe('test linear_stage optics')
    expect(modeForLinearStageCommand('TEST LINEAR_STAGE OPTICS')).toBe('optics')
  })

  it('keeps mechanics-only planned steps free of optics and scan audit checks', () => {
    const steps = plannedStepsForLinearStageMode('mechanics')
    expect(steps.some((step) => /optical|scan audit/i.test(step))).toBe(false)
    expect(steps).toContain('X home switch qualification')
    expect(steps).toContain('Park Steppers')
  })

  it('keeps optics-only planned steps focused on optical artifacts and park', () => {
    const steps = plannedStepsForLinearStageMode('optics')
    expect(steps).toEqual(LINEAR_STAGE_MODE_CONFIGS.optics.plannedSteps)
    expect(steps).toContain('Select optical region')
    expect(steps).toContain('3x3 scan audit')
    expect(steps.some((step) => /span|derated|front-limit|positive boundary/i.test(step))).toBe(false)
  })

  it('uses the active mode first when numbering planned steps', () => {
    expect(plannedStepNumberForLinearStageMode('3x3 scan audit', 'optics')).toBe(5)
    expect(plannedStepNumberForLinearStageMode('3x3 scan audit', 'full')).toBeGreaterThan(15)
    expect(plannedStepNumberForLinearStageMode('Unplanned firmware step', 'mechanics')).toBe(plannedStepsForLinearStageMode('mechanics').length + 1)
  })

  it('returns known planned numbers without shifting synthetic dashboard phases', () => {
    expect(knownPlannedStepNumberForLinearStageMode('CM4 task running', 'mechanics')).toBe(2)
    expect(knownPlannedStepNumberForLinearStageMode('Initialise Steppers', 'mechanics')).toBe(3)
    expect(knownPlannedStepNumberForLinearStageMode('2 | Initialise Steppers', 'mechanics')).toBe(3)
    expect(knownPlannedStepNumberForLinearStageMode('Unplanned firmware step', 'mechanics')).toBeUndefined()
  })
})
