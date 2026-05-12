import { describe, expect, it } from 'vitest'
import type { MirroredEventRecord, StoredMirroredEventRecord } from '../../shared/contracts'
import {
  buildCartridgeHistoryRuns,
  cartridgeHistoryResult,
  filterCartridgeHistoryRuns,
  latestRunsByCartridge,
  summarizeCartridgeHistory,
} from './cartridgeHistory'

describe('cartridge history normalization', () => {
  it('groups compact production summaries into visual run data', () => {
    const runs = buildCartridgeHistoryRuns([
      storedEvent({
        id: 'evt-1',
        createdAt: '2026-05-12T03:13:17.636Z',
        appVersion: undefined,
        data: {
          cart: 'SS-SA-007-030-0157',
          run: '1778581035-1778555319856',
          g: 'ACCEPT_SINGLE_PASS',
          status: 'PASS',
          o: { cnt: 30, cv: 0.0107987, max: 14.7537, med: 14.3646, min: 14.048, raw: 14.3368, sd: 0.154838, slpm: 14.3386, q: true, trim_cnt: 24 },
          n: { cnt: 30, cv: 0.00858272, max: 12.6137, med: 12.3676, min: 12.1521, raw: 12.3847, sd: 0.106282, slpm: 12.3832, q: true, trim_cnt: 24 },
          s: { cnt: 30, cv: 0.0262637, max: 2.14233, med: 2.03743, min: 1.96304, raw: 2.04786, sd: 0.05374, slpm: 2.04617, q: true, trim_cnt: 24 },
          r: { so: 0.142704, valid: true },
          fix: 'SS-P-001-010-0085',
          noz: 'NOZL-0001',
          seal: 'SEAL-0001',
          prof_ver: 'phase1-characterization.v2',
        },
      }),
    ])

    expect(runs).toHaveLength(1)
    expect(runs[0].cartridgeSerial).toBe('SS-SA-007-030-0157')
    expect(runs[0].operator).toBe('Harry Blake')
    expect(runs[0].productionBatch).toBe('P1-STAGE-2026-05')
    expect(runs[0].appVersion).toBeUndefined()
    expect(runs[0].sealedOpenRatio).toBeCloseTo(0.142704)
    expect(runs[0].measurements.open?.min_slpm).toBeCloseTo(14.048)
    expect(runs[0].measurements.nozzle?.max_slpm).toBeCloseTo(12.6137)
    expect(runs[0].measurements.sealed?.coefficient_of_variation).toBeCloseTo(0.0262637)
    expect(cartridgeHistoryResult(runs[0])).toBe('accept')
  })

  it('combines expanded step events with a summary event and app version metadata', () => {
    const events = [
      measurementEvent('evt-open', 'run-1', 'open', 14.1, '2026-05-12T04:00:00.000Z'),
      measurementEvent('evt-sealed', 'run-1', 'sealed', 3.6, '2026-05-12T04:00:10.000Z'),
      storedEvent({
        id: 'evt-summary',
        createdAt: '2026-05-12T04:00:11.000Z',
        appVersion: '0.15.0',
        data: {
          run_uid: 'run-1',
          cartridge_serial: 'SS-SA-007-031-0134',
          open_slpm: 14.1,
          sealed_slpm: 3.6,
          sealed_open_ratio: 0.255319,
          sample_quality: 'acceptable',
          guidance: 'RESEAT_AND_REPEAT_BORDERLINE',
        },
      }),
    ]

    const runs = buildCartridgeHistoryRuns(events)

    expect(runs).toHaveLength(1)
    expect(runs[0].eventCount).toBe(3)
    expect(runs[0].appVersion).toBe('0.15.0')
    expect(runs[0].measurements.open?.flow_slpm_samples).toEqual([14, 14.1, 14.2])
    expect(runs[0].sealedOpenRatio).toBeCloseTo(0.255319)
    expect(cartridgeHistoryResult(runs[0])).toBe('borderline')
  })

  it('summarizes latest attempts separately from all attempts', () => {
    const allRuns = buildCartridgeHistoryRuns([
      storedEvent({
        id: 'evt-a1',
        createdAt: '2026-05-12T01:00:00.000Z',
        appVersion: '0.14.0',
        data: { cart: 'SS-SA-007-030-0169', run: 'run-a1', g: 'RESEAT_AND_REPEAT_BORDERLINE', r: { so: 0.271502 }, o: { slpm: 14 }, s: { slpm: 3.801 } },
      }),
      storedEvent({
        id: 'evt-a2',
        createdAt: '2026-05-12T02:00:00.000Z',
        appVersion: '0.15.0',
        data: { cart: 'SS-SA-007-030-0169', run: 'run-a2', g: 'ACCEPT_SINGLE_PASS', r: { so: 0.249 }, o: { slpm: 14 }, s: { slpm: 3.486 } },
      }),
      storedEvent({
        id: 'evt-b1',
        createdAt: '2026-05-12T03:00:00.000Z',
        appVersion: '0.15.0',
        data: { cart: 'SS-SA-007-030-0170', run: 'run-b1', g: 'RESEAT_AND_REPEAT_SUSPECT_FAIL', r: { so: 0.404413 }, o: { slpm: 14 }, s: { slpm: 5.662 } },
      }),
    ])

    const latestRuns = latestRunsByCartridge(allRuns)
    const summary = summarizeCartridgeHistory(latestRuns)

    expect(allRuns.find((run) => run.runUid === 'run-a2')?.attemptIndex).toBe(2)
    expect(allRuns.find((run) => run.runUid === 'run-a2')?.attemptCount).toBe(2)
    expect(latestRuns.map((run) => run.runUid).sort()).toEqual(['run-a2', 'run-b1'])
    expect(summary.uniqueCartridgeCount).toBe(2)
    expect(summary.resultCounts.accept).toBe(1)
    expect(summary.resultCounts.suspect).toBe(1)
    expect(summary.ratioMax).toBeCloseTo(0.404413)
    expect(summary.appVersions).toEqual(['0.15.0'])
  })

  it('filters result after selecting the true latest attempt per cartridge', () => {
    const allRuns = buildCartridgeHistoryRuns([
      storedEvent({
        id: 'evt-old-suspect',
        createdAt: '2026-05-12T01:00:00.000Z',
        data: { cart: 'SS-SA-007-030-0170', run: 'run-old', g: 'RESEAT_AND_REPEAT_SUSPECT_FAIL', r: { so: 0.404 }, o: { slpm: 14 }, s: { slpm: 5.656 } },
      }),
      storedEvent({
        id: 'evt-new-accept',
        createdAt: '2026-05-12T02:00:00.000Z',
        data: { cart: 'SS-SA-007-030-0170', run: 'run-new', g: 'ACCEPT_SINGLE_PASS', r: { so: 0.2 }, o: { slpm: 14 }, s: { slpm: 2.8 } },
      }),
    ])

    expect(filterCartridgeHistoryRuns(allRuns, { attemptView: 'latest', result: 'suspect' })).toEqual([])
    expect(filterCartridgeHistoryRuns(allRuns, { attemptView: 'latest', result: 'accept' }).map((run) => run.runUid)).toEqual(['run-new'])
  })

  it('keeps repeat quality sticky when later events invalidate an earlier acceptable run', () => {
    const runs = buildCartridgeHistoryRuns([
      measurementEvent('evt-open-ok', 'run-repeat', 'open', 14.1, '2026-05-12T04:00:00.000Z'),
      measurementEvent('evt-sealed-repeat', 'run-repeat', 'sealed', 3.0, '2026-05-12T04:00:10.000Z', { quality_ok: false }),
    ])

    expect(runs[0].sampleQuality).toBe('repeat')
    expect(cartridgeHistoryResult(runs[0])).toBe('repeat')
  })

  it('treats compact invalid measurements and invalid ratios as repeat, not accept', () => {
    const runs = buildCartridgeHistoryRuns([
      storedEvent({
        id: 'evt-invalid',
        createdAt: '2026-05-12T05:00:00.000Z',
        workflow: null,
        data: {
          cart: 'SS-SA-007-030-0188',
          run: 'run-invalid',
          g: 'ACCEPT_SINGLE_PASS',
          o: { slpm: 14, valid: false },
          s: { slpm: 2.8 },
          r: { so: 0.2, valid: false },
        },
      }),
    ])

    expect(runs[0].appVersion).toBeUndefined()
    expect(runs[0].sampleQuality).toBe('repeat')
    expect(cartridgeHistoryResult(runs[0])).toBe('repeat')
  })
})

function measurementEvent(
  id: string,
  runUid: string,
  phase: 'open' | 'sealed',
  slpm: number,
  createdAt: string,
  measurementOverrides: Record<string, unknown> = {},
): StoredMirroredEventRecord {
  return storedEvent({
    id,
    createdAt,
    appVersion: '0.15.0',
    eventName: 'dd_test_step_result',
    data: {
      step_name: `MEASURE_${phase.toUpperCase()}_INLET`,
      run_uid: runUid,
      cartridge_serial: 'SS-SA-007-031-0134',
      phase,
      artifacts: {
        measurement: {
          valid: true,
          sample_count: 3,
          flow_slpm_mean: slpm,
          flow_slpm_raw_mean: slpm + 0.01,
          flow_slpm_median: slpm,
          flow_slpm_stddev: 0.1,
          flow_slpm_min: slpm - 0.1,
          flow_slpm_max: slpm + 0.1,
          trimmed_sample_count: 3,
          outlier_count: 0,
          coefficient_of_variation: 0.01,
          quality_ok: true,
          ...measurementOverrides,
          settle_ms: 12000,
          dt_ms: 100,
          flow_slpm_samples: [slpm - 0.1, slpm, slpm + 0.1],
        },
      },
    },
  })
}

function storedEvent(input: {
  id: string
  createdAt: string
  data: Record<string, unknown>
  appVersion?: string
  eventName?: string
  workflow?: string | null
}): StoredMirroredEventRecord {
  const runUid = typeof input.data.run === 'string' ? input.data.run : typeof input.data.run_uid === 'string' ? input.data.run_uid : undefined
  const cartridgeSerial = typeof input.data.cart === 'string'
    ? input.data.cart
    : typeof input.data.cartridge_serial === 'string'
      ? input.data.cartridge_serial
      : undefined
  const record: MirroredEventRecord = {
    event_id: input.id,
    idempotency_key: input.id,
    event_name: input.eventName ?? 'dd_cartridge_air_leak_summary',
    data: input.data,
    local_timestamp: input.createdAt,
    run_uid: runUid,
    cartridge_serial: cartridgeSerial,
    station_id: 'STATION-001',
    operator: 'Harry Blake',
    batch: 'P1-STAGE-2026-05',
    tester_device_serial: 'SS-A-001-101A-0122',
    enclosure_base_id: 'SS-P-001-010-0085',
    nozzle_id: 'NOZL-0001',
    seal_fixture_id: 'SEAL-0001',
    workflow: input.workflow === null ? undefined : input.workflow ?? 'cartridge_subassembly',
    app_version: input.appVersion,
    upload_status: 'local_only',
  }
  return {
    id: input.id,
    event_name: record.event_name,
    record,
    run_uid: runUid,
    cartridge_serial: cartridgeSerial,
    workflow: input.workflow === null ? undefined : input.workflow ?? 'cartridge_subassembly',
    created_at: input.createdAt,
    upload_status: 'local_only',
    app_version: input.appVersion,
  }
}
