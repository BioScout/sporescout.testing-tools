import { describe, expect, it } from 'vitest'
import type { GuiResponseEnvelope } from './contracts'
import {
  applyCartridgeReadinessResult,
  buildCartridgeOpenCommand,
  buildCartridgePhaseCommand,
  buildReadinessItems,
  extractRunUid,
  progressLabel,
} from './workflow'

describe('cartridge workflow helpers', () => {
  it('builds the strict manual firmware commands', () => {
    expect(buildCartridgeOpenCommand('SS-SA-007-031-0134', 'SS-P-001-101-0001')).toBe(
      'test cartridge_leak open SS-SA-007-031-0134 SS-P-001-101-0001 phase1-characterization',
    )
    expect(buildCartridgePhaseCommand('nozzle', 'run-1', 'NOZL-0001')).toBe(
      'test cartridge_leak nozzle run-1 NOZL-0001',
    )
    expect(buildCartridgePhaseCommand('sealed', 'run-1', 'SEAL-0001')).toBe(
      'test cartridge_leak sealed run-1 SEAL-0001',
    )
  })

  it('uses only the firmware-generated run_uid returned by open', () => {
    const response: GuiResponseEnvelope = {
      type: 'response',
      ok: true,
      command: 'test cartridge_leak open SS-SA-007-031-0134 SS-P-001-101-0001 phase1-characterization',
      result: { run_uid: 'firmware-run-42' },
    }

    expect(extractRunUid(response)).toBe('firmware-run-42')
  })

  it('labels settle and sample progress for the v2 measurement method', () => {
    expect(progressLabel('open', 3000)).toBe('Open settling, 9s')
    expect(progressLabel('sealed', 12600)).toBe('Sealed sampling 6/30')
  })

  it('maps composite cartridge readiness checks onto operator steps', () => {
    const result = applyCartridgeReadinessResult(buildReadinessItems(), {
      firmware_version: 5383001,
      hardware_version: '101A',
      ready: false,
      status: 'NOT_READY',
      operator_action: 'Enable 5V Aux and wait for the CM4 availability pin before checking or moving solenoids.',
      checks: {
        active_run_clear: { ok: true, message: 'no active cartridge_leak run' },
        idle_state: { ok: true, message: 'firmware state is Idle' },
        station_self_check: { ok: true, message: 'station dependencies ok' },
        tester_power: { ok: true, message: '24V Aux is in range' },
        cm4_ready: { ok: false, message: 'CM4 is not available; solenoid state cannot be trusted yet' },
        solenoid_locked: { ok: false, skipped: true, message: 'skipped until CM4 is available' },
      },
    })

    expect(result.ready).toBe(false)
    expect(result.operatorAction).toContain('Enable 5V Aux')
    expect(result.items.find((item) => item.id === 'firmware')?.detail).toBe('firmware 5383001, 101A')
    expect(result.items.find((item) => item.id === 'cm4_ready')?.status).toBe('failed')
    expect(result.items.find((item) => item.id === 'solenoid_locked')?.status).toBe('pending')
  })
})
