import { describe, expect, it } from 'vitest'
import type { GuiResponseEnvelope } from './contracts'
import {
  applyCartridgeReadinessResult,
  buildCartridgeOpenCommand,
  buildCartridgePhaseCommand,
  buildReadinessItems,
  deriveGuidanceFromMeasurements,
  extractGuidance,
  extractMeasurement,
  extractRunUid,
  isReadinessAutoRetryable,
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
        cm4_power: { ok: true, message: 'tester computer power is ready' },
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

  it('maps current compact readiness fields and detects CM4 boot retry state', () => {
    const notReady = {
      firmware_version: 5383001,
      hardware_version: '101A',
      ready: 0,
      status: 'NOT_READY',
      operator_action: 'Wait for tester boot to finish, then rerun readiness.',
      check_active_run_clear: 1,
      check_idle_state: 1,
      check_station_boot_ready: -1,
      check_station_self_check: -1,
      check_tester_power: 1,
      check_cm4_power: 1,
      check_cm4_ready: 0,
      check_solenoid_locked: -1,
    }

    const result = applyCartridgeReadinessResult(buildReadinessItems(), notReady)
    expect(result.ready).toBe(false)
    expect(isReadinessAutoRetryable(notReady)).toBe(true)
    expect(result.items.find((item) => item.id === 'station_self_check')?.status).toBe('pending')
    expect(result.items.find((item) => item.id === 'cm4_ready')?.status).toBe('failed')
    expect(result.items.find((item) => item.id === 'solenoid_locked')?.status).toBe('pending')
  })

  it('maps firmware-included solenoid lock readiness as ready', () => {
    const result = applyCartridgeReadinessResult(buildReadinessItems(), {
      firmware_version: 5383001,
      hardware_version: '101A',
      ready: 1,
      status: 'READY',
      check_active_run_clear: 1,
      check_idle_state: 1,
      check_station_boot_ready: 1,
      check_station_self_check: -1,
      check_tester_power: 1,
      check_cm4_power: 1,
      check_cm4_ready: 1,
      check_solenoid_locked: 1,
    })

    expect(result.ready).toBe(true)
    expect(isReadinessAutoRetryable({ ready: 1, status: 'READY' })).toBe(false)
    expect(result.items.find((item) => item.id === 'solenoid_locked')?.status).toBe('passed')
  })

  it('extracts full measurement artifacts from dd_test_step_result payloads', () => {
    const measurement = extractMeasurement({
      type: 'event',
      event_name: 'dd_test_step_result',
      data: {
        step_name: 'MEASURE_SEALED_INLET',
        context: { m: { slpm: 0.34, raw: 0.35, cv: 0.02, q: true } },
        artifacts: {
          measurement: {
            flow_slpm_mean: 0.34,
            flow_slpm_raw_mean: 0.35,
            flow_slpm_median: 0.341,
            flow_slpm_stddev: 0.007,
            flow_slpm_min: 0.329,
            flow_slpm_max: 0.352,
            trimmed_sample_count: 24,
            outlier_count: 6,
            coefficient_of_variation: 0.02,
            stability_limit_slpm: 0.04,
            quality_ok: true,
            fan_pwm_pct: 100,
            rpm: 17600,
            flow_slpm_samples: [0.33, 0.34, 0.35],
          },
        },
      },
    })

    expect(measurement?.phase).toBe('sealed')
    expect(measurement?.slpm).toBe(0.34)
    expect(measurement?.flow_slpm_samples).toEqual([0.33, 0.34, 0.35])
    expect(measurement?.sample_quality).toBe('acceptable')
  })

  it('extracts compact summary guidance and quality', () => {
    const guidance = extractGuidance({
      type: 'event',
      event_name: 'dd_cartridge_air_leak_summary',
      data: {
        g: 'ACCEPT_SINGLE_PASS',
        r: { so: 0.127 },
        s: { q: true },
      },
    })

    expect(guidance.guidance).toBe('ACCEPT_SINGLE_PASS')
    expect(guidance.sealedOpenRatio).toBe(0.127)
    expect(guidance.sampleQuality).toBe('acceptable')
  })

  it('extracts sealed command response guidance before summary event arrives', () => {
    const guidance = extractGuidance({
      type: 'event',
      event_name: 'sealed_command_response',
      data: {
        phase1_guidance: 'RESEAT_AND_REPEAT_SUSPECT_FAIL',
        ratios: { so: 1.002 },
        sealed: { q: true },
      },
    })

    expect(guidance.guidance).toBe('RESEAT_AND_REPEAT_SUSPECT_FAIL')
    expect(guidance.sealedOpenRatio).toBe(1.002)
    expect(guidance.sampleQuality).toBe('acceptable')
  })

  it('extracts guidance from evaluation step result context', () => {
    const guidance = extractGuidance({
      type: 'event',
      event_name: 'dd_test_step_result',
      data: {
        step_name: 'EVALUATE_SEALED_LEAK',
        context: {
          g: 'RESEAT_AND_REPEAT_SUSPECT_FAIL',
          r: { so: 1.002 },
        },
      },
    })

    expect(guidance.guidance).toBe('RESEAT_AND_REPEAT_SUSPECT_FAIL')
    expect(guidance.sealedOpenRatio).toBe(1.002)
  })

  it('derives immediate operator guidance from open and sealed measurements', () => {
    const guidance = deriveGuidanceFromMeasurements({
      open: {
        phase: 'open',
        sample_count: 30,
        slpm: 10,
        raw_mean_slpm: 10,
        median_slpm: 10,
        stddev_slpm: 0.1,
        min_slpm: 9.8,
        max_slpm: 10.2,
        trimmed_count: 24,
        outlier_count: 0,
        coefficient_of_variation: 0.01,
        sample_quality: 'acceptable',
        settle_ms: 12000,
        dt_ms: 100,
        flow_slpm_samples: [],
      },
      sealed: {
        phase: 'sealed',
        sample_count: 30,
        slpm: 10,
        raw_mean_slpm: 10,
        median_slpm: 10,
        stddev_slpm: 0.1,
        min_slpm: 9.8,
        max_slpm: 10.2,
        trimmed_count: 24,
        outlier_count: 0,
        coefficient_of_variation: 0.01,
        sample_quality: 'acceptable',
        settle_ms: 12000,
        dt_ms: 100,
        flow_slpm_samples: [],
      },
    })

    expect(guidance.sealedOpenRatio).toBe(1)
    expect(guidance.guidance).toBe('RESEAT_AND_REPEAT_SUSPECT_FAIL')
  })
})
