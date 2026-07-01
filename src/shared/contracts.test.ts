import { describe, expect, it } from 'vitest'
import {
  LINEAR_STAGE_MODE_COMMANDS,
  LINEAR_STAGE_MOTION_COMMANDS,
  buildLinearStageSuiteCommand,
  linearStageModeForCommand,
  parseLinearStageSuiteCommand,
  validateGuiCommand,
  type LinearStageMode,
  type LocalRunContext,
} from './contracts'

const cartridgeContext: LocalRunContext = {
  workflow: 'cartridge_subassembly',
  operator: 'Codex QA',
  batch: 'P1-DEV-2026-05',
  station_id: 'station-1',
  tester_device_serial: 'SS-A-001-101A-0013',
  enclosure_base_id: 'SS-P-001-101-0001',
  nozzle_id: 'NOZL-0001',
  seal_fixture_id: 'SEAL-0001',
  cartridge_serial: 'SS-SA-007-031-0134',
  cartridge_phase: 'open',
}

const linearStageContext: LocalRunContext = {
  workflow: 'linear_stage',
  linear_stage_run_id: 'linear-1',
  linear_stage_mode: 'production_full',
  operator: 'Codex QA',
  batch: 'P1-DEV-2026-05',
  tester_device_serial: 'SS-A-001-101A-0013',
  stage_clear_confirmed: true,
  stage_clear_arm_id: 'arm-1',
  stage_clear_armed_at: new Date().toISOString(),
}

describe('GUI command policy', () => {
  it('allows cartridge and readiness commands used by the operator workflow when context matches', () => {
    expect(validateGuiCommand('test cartridge_leak prepare').ok).toBe(true)
    expect(validateGuiCommand('test cartridge_leak open SS-SA-007-031-0134 SS-P-001-101-0001 phase1-characterization', cartridgeContext).ok).toBe(true)
    expect(validateGuiCommand('test cartridge_leak nozzle run-1 NOZL-0001', { ...cartridgeContext, cartridge_phase: 'nozzle', run_uid: 'run-1' }).ok).toBe(true)
    expect(validateGuiCommand('test cartridge_leak sealed run-1 SEAL-0001', { ...cartridgeContext, cartridge_phase: 'sealed', run_uid: 'run-1' }).ok).toBe(true)
    expect(validateGuiCommand('test linear_stage prepare').ok).toBe(true)
  })

  it('blocks cartridge phases when active context is missing or mismatched', () => {
    expect(validateGuiCommand('test cartridge_leak nozzle run-1 NOZL-0001').ok).toBe(false)
    expect(validateGuiCommand('test cartridge_leak sealed run-1 SEAL-0001', { ...cartridgeContext, cartridge_phase: 'nozzle', run_uid: 'run-1' }).ok).toBe(false)
    expect(validateGuiCommand('test cartridge_leak nozzle run-2 NOZL-0001', { ...cartridgeContext, cartridge_phase: 'nozzle', run_uid: 'run-1' }).ok).toBe(false)
  })

  it('blocks linear-stage suite start until stage-clear context is armed', () => {
    const command = buildLinearStageSuiteCommand('production_full', 101)

    expect(validateGuiCommand(command).ok).toBe(false)
    expect(validateGuiCommand(command, linearStageContext).ok).toBe(false)

    const allowed = validateGuiCommand(command, linearStageContext, { allowLinearStageMotion: true })
    expect(allowed.ok).toBe(true)
    expect(allowed.ok && allowed.consumesLinearStageArm).toBe(true)
  })

  it('allows canonical linear-stage suite commands only when the armed mode matches', () => {
    const mismatch: Record<LinearStageMode, LinearStageMode> = {
      production_full: 'mechanics_only',
      mechanics_only: 'production_full',
      optics_only: 'production_full',
    }

    for (const [mode, command] of Object.entries(LINEAR_STAGE_MODE_COMMANDS) as Array<[LinearStageMode, string]>) {
      expect(validateGuiCommand(command, { ...linearStageContext, linear_stage_mode: mode }).ok).toBe(false)

      const allowed = validateGuiCommand(command, { ...linearStageContext, linear_stage_mode: mode }, { allowLinearStageMotion: true })
      expect(allowed.ok, command).toBe(true)
      expect(allowed.ok && allowed.consumesLinearStageArm).toBe(true)

      expect(validateGuiCommand(command, { ...linearStageContext, linear_stage_mode: mismatch[mode] }, { allowLinearStageMotion: true }).ok).toBe(false)
      expect(linearStageModeForCommand(command)).toBe(mode)
    }
  })

  it('parses explicit suite runner requests without preserving legacy command aliases', () => {
    const command = buildLinearStageSuiteCommand('optics_only', 40226, 2)

    expect(parseLinearStageSuiteCommand(command)).toEqual({
      mode: 'optics_only',
      sessionId: 40226,
      sessionType: 'LINEAR_STAGE_OPTICS',
      repeats: 2,
    })
    expect(linearStageModeForCommand('test linear_stage full')).toBeUndefined()
    expect(linearStageModeForCommand('test step_mechanics')).toBeUndefined()
    expect(linearStageModeForCommand('test suite({"sessionId":40226,"sessionType":"LINEAR_STAGE_PRODUCTION_FULL","repeats":1})')).toBeUndefined()
    expect(validateGuiCommand('test step_mechanics', linearStageContext, { allowLinearStageMotion: true, allowEngineeringLinearStageMotion: true }).ok).toBe(false)
  })

  it('expires stale linear-stage stage-clear confirmations', () => {
    const staleContext: LocalRunContext = {
      ...linearStageContext,
      stage_clear_armed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }

    const result = validateGuiCommand(buildLinearStageSuiteCommand('production_full', 101), staleContext, { allowLinearStageMotion: true })
    expect(result.ok).toBe(false)
    if (!('error' in result)) throw new Error('Expected stale stage-clear validation to fail.')
    expect(result.error).toContain('expired')
  })

  it('matches linear-stage suite commands exactly without trailing arguments', () => {
    for (const command of LINEAR_STAGE_MOTION_COMMANDS) {
      expect(validateGuiCommand(`${command} extra`, linearStageContext, { allowLinearStageMotion: true }).ok).toBe(false)
    }
  })

  it('requires the timed removal control for solenoid unlock', () => {
    expect(validateGuiCommand('solenoid Unlock').ok).toBe(false)
    expect(validateGuiCommand('solenoid Unlock', undefined, { allowSolenoidUnlock: true }).ok).toBe(true)
  })

  it('rejects unrelated raw commands from the renderer bridge', () => {
    expect(validateGuiCommand('cm4 RunBashCommandTask reboot').ok).toBe(false)
    expect(validateGuiCommand('particle flash anything').ok).toBe(false)
  })
})
