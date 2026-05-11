import { describe, expect, it } from 'vitest'
import {
  LINEAR_STAGE_COMMAND_MODE_ALIASES,
  LINEAR_STAGE_MODE_COMMANDS,
  LINEAR_STAGE_MOTION_COMMANDS,
  linearStageModeForCommand,
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

  it('blocks linear-stage motion until stage-clear context is armed', () => {
    expect(validateGuiCommand('test linear_stage full').ok).toBe(false)

    const allowed = validateGuiCommand('test step', {
      workflow: 'linear_stage',
      linear_stage_run_id: 'linear-1',
      linear_stage_mode: 'full',
      operator: 'Codex QA',
      batch: 'P1-DEV-2026-05',
      tester_device_serial: 'SS-A-001-101A-0013',
      stage_clear_confirmed: true,
      stage_clear_arm_id: 'arm-1',
      stage_clear_armed_at: new Date().toISOString(),
    }, { allowLinearStageMotion: true, allowEngineeringLinearStageMotion: true })

    expect(allowed.ok).toBe(true)
    expect(allowed.ok && allowed.consumesLinearStageArm).toBe(true)
  })

  it('allows canonical split-mode linear-stage commands only when the armed mode matches', () => {
    const baseContext: LocalRunContext = {
      workflow: 'linear_stage',
      linear_stage_run_id: 'linear-1',
      operator: 'Codex QA',
      batch: 'P1-DEV-2026-05',
      tester_device_serial: 'SS-A-001-101A-0013',
      stage_clear_confirmed: true,
      stage_clear_arm_id: 'arm-1',
      stage_clear_armed_at: new Date().toISOString(),
    }

    for (const [mode, command] of Object.entries(LINEAR_STAGE_MODE_COMMANDS) as Array<[LinearStageMode, string]>) {
      expect(validateGuiCommand(command, { ...baseContext, linear_stage_mode: mode }).ok).toBe(false)

      const allowed = validateGuiCommand(command, { ...baseContext, linear_stage_mode: mode }, { allowLinearStageMotion: true })
      expect(allowed.ok, command).toBe(true)
      expect(allowed.ok && allowed.consumesLinearStageArm).toBe(true)

      expect(validateGuiCommand(command, { ...baseContext, linear_stage_mode: 'full' === mode ? 'mechanics' : 'full' }, { allowLinearStageMotion: true }).ok).toBe(false)
      expect(linearStageModeForCommand(command)).toBe(mode)
    }
  })

  it('maps engineering aliases to modes but keeps them out of normal operator dispatch', () => {
    const baseContext: LocalRunContext = {
      workflow: 'linear_stage',
      linear_stage_run_id: 'linear-1',
      linear_stage_mode: 'mechanics',
      operator: 'Codex QA',
      batch: 'P1-DEV-2026-05',
      tester_device_serial: 'SS-A-001-101A-0013',
      stage_clear_confirmed: true,
      stage_clear_arm_id: 'arm-1',
      stage_clear_armed_at: new Date().toISOString(),
    }

    expect(linearStageModeForCommand('test step_mechanics')).toBe('mechanics')
    expect(LINEAR_STAGE_COMMAND_MODE_ALIASES['test step_optics']).toBe('optics')
    expect(validateGuiCommand('test step_mechanics', baseContext, { allowLinearStageMotion: true }).ok).toBe(false)
    expect(validateGuiCommand('test step_mechanics', baseContext, { allowLinearStageMotion: true, allowEngineeringLinearStageMotion: true }).ok).toBe(true)
  })

  it('expires stale linear-stage stage-clear confirmations', () => {
    const staleContext: LocalRunContext = {
      workflow: 'linear_stage',
      linear_stage_run_id: 'linear-1',
      linear_stage_mode: 'full',
      operator: 'Codex QA',
      batch: 'P1-DEV-2026-05',
      tester_device_serial: 'SS-A-001-101A-0013',
      stage_clear_confirmed: true,
      stage_clear_arm_id: 'arm-1',
      stage_clear_armed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }

    const result = validateGuiCommand('test linear_stage full', staleContext, { allowLinearStageMotion: true })
    expect(result.ok).toBe(false)
    if (!('error' in result)) throw new Error('Expected stale stage-clear validation to fail.')
    expect(result.error).toContain('expired')
  })

  it('matches linear-stage motion commands exactly without trailing arguments', () => {
    for (const command of LINEAR_STAGE_MOTION_COMMANDS) {
      expect(validateGuiCommand(`${command} extra`, {
        workflow: 'linear_stage',
        linear_stage_run_id: 'linear-1',
        linear_stage_mode: 'full',
        operator: 'Codex QA',
        batch: 'P1-DEV-2026-05',
        tester_device_serial: 'SS-A-001-101A-0013',
        stage_clear_confirmed: true,
      }).ok).toBe(false)
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
