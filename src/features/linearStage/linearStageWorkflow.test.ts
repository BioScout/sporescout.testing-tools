import { describe, expect, it } from 'vitest'
import {
  LINEAR_STAGE_MODE_CONFIGS,
  commandForLinearStageMode,
  knownPlannedStepNumberForLinearStageMode,
  modeForLinearStageCommand,
  plannedStepNumberForLinearStageMode,
  plannedStepsForLinearStageMode,
} from './linearStageWorkflow'

describe('linearStageWorkflow', () => {
  it('maps operator modes to explicit suite-runner start commands', () => {
    expect(commandForLinearStageMode('production_full', 40226)).toBe('test suite({"sessionId":40226,"sessionType":"LINEAR_STAGE_COMPREHENSIVE","repeats":1})')
    expect(commandForLinearStageMode('mechanics_only', 40226)).toBe('test suite({"sessionId":40226,"sessionType":"LINEAR_STAGE_MECHANICS","repeats":1})')
    expect(commandForLinearStageMode('optics_only', 40226)).toBe('test suite({"sessionId":40226,"sessionType":"LINEAR_STAGE_OPTICS","repeats":1})')
    expect(modeForLinearStageCommand('test suite({"sessionId":40226,"sessionType":"LINEAR_STAGE_OPTICS","repeats":1})')).toBe('optics_only')
  })

  it('keeps production full aligned with the current production qualification suite', () => {
    const steps = plannedStepsForLinearStageMode('production_full')

    expect(steps).toHaveLength(40)
    expect(steps).toContain('Check camera connection')
    expect(steps).toContain('Check camera image capture')
    expect(steps).toContain('Check camera LED')
    expect(steps).toContain('Home tile capture')
    expect(steps).toContain('Production workspace stress')
    expect(steps).toContain('Scan capture')
    expect(steps).toContain('Scan audit')
    expect(steps).toContain('Artifact generation')
    expect(steps).toContain('Upload')
    expect(steps[39]).toBe('Linear-stage verdict')
  })

  it('keeps mechanics-only planned steps free of optics, scan audit, and upload checks', () => {
    const steps = plannedStepsForLinearStageMode('mechanics_only')

    expect(steps).toHaveLength(23)
    expect(steps.some((step) => /optical|scan|upload|modem|internet|authenticate/i.test(step))).toBe(false)
    expect(steps).toContain('X home switch')
    expect(steps).toContain('Park/cleanup')
    expect(steps).toEqual(LINEAR_STAGE_MODE_CONFIGS.mechanics_only.plannedSteps)
  })

  it('keeps optics-only planned steps focused on production optical evidence and cleanup', () => {
    const steps = plannedStepsForLinearStageMode('optics_only')

    expect(steps).toEqual(LINEAR_STAGE_MODE_CONFIGS.optics_only.plannedSteps)
    expect(steps).toHaveLength(21)
    expect(steps).toContain('Check camera connection')
    expect(steps).toContain('Home tile capture')
    expect(steps).toContain('Production workspace stress')
    expect(steps).toContain('Optical region selection')
    expect(steps).toContain('X focus')
    expect(steps).toContain('Y displacement')
    expect(steps).toContain('Z displacement')
    expect(steps.some((step) => /home switch|hard limit|span|current margin|scan|upload/i.test(step))).toBe(false)
  })

  it('uses the active mode first when numbering planned steps', () => {
    expect(plannedStepNumberForLinearStageMode('Scan audit', 'production_full')).toBe(33)
    expect(plannedStepNumberForLinearStageMode('Unplanned firmware step', 'mechanics_only')).toBe(plannedStepsForLinearStageMode('mechanics_only').length + 1)
  })

  it('returns known planned numbers without shifting unknown firmware phases', () => {
    expect(knownPlannedStepNumberForLinearStageMode('Initialize steppers', 'mechanics_only')).toBe(7)
    expect(knownPlannedStepNumberForLinearStageMode('2 | Initialize steppers', 'mechanics_only')).toBe(7)
    expect(knownPlannedStepNumberForLinearStageMode('Unplanned firmware step', 'mechanics_only')).toBeUndefined()
  })
})
