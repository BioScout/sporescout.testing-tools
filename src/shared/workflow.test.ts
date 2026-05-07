import { describe, expect, it } from 'vitest'
import type { GuiResponseEnvelope } from './contracts'
import {
  buildCartridgeOpenCommand,
  buildCartridgePhaseCommand,
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
})
