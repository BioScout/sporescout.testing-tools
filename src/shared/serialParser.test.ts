import { describe, expect, it } from 'vitest'
import { formatGuiEvent, formatGuiResponse, mirroredEventRecordFromEnvelope, parseSerialLine } from './serialParser'
import type { GuiEventEnvelope, GuiResponseEnvelope } from './contracts'

describe('serial parser', () => {
  it('parses GUI response envelopes', () => {
    const response: GuiResponseEnvelope = {
      type: 'response',
      ok: true,
      command: 'system GetFirmwareVersion',
      result: 5383001,
    }

    const parsed = parseSerialLine(formatGuiResponse(response))

    expect(parsed.kind).toBe('gui-response')
    expect(parsed.envelope).toMatchObject({
      type: 'response',
      ok: true,
      command: 'system GetFirmwareVersion',
      result: 5383001,
    })
  })

  it('keeps oversized-response metadata from compact GUI envelopes', () => {
    const response: GuiResponseEnvelope = {
      type: 'response',
      ok: true,
      command: 'test linear_stage',
      result_omitted: true,
      result_json_bytes: 5698,
      message: 'Full result is available in the legacy Command line.',
      firmware_version: 5383001,
    }

    const parsed = parseSerialLine(formatGuiResponse(response))

    expect(parsed.kind).toBe('gui-response')
    expect(parsed.envelope).toMatchObject({
      command: 'test linear_stage',
      result_omitted: true,
      result_json_bytes: 5698,
      message: 'Full result is available in the legacy Command line.',
      firmware_version: 5383001,
    })
  })

  it('parses GUI event envelopes for local replay storage', () => {
    const event: GuiEventEnvelope = {
      type: 'event',
      event_name: 'dd_cartridge_air_leak_summary',
      device_id: 'device-1',
      product_id: 33608,
      firmware_version: 5383001,
      data: {
        run_uid: 'run-1',
        cartridge_serial: 'SS-SA-007-031-0134',
        sealed_open_ratio: 0.127,
      },
    }

    const line = formatGuiEvent(event)
    const parsed = parseSerialLine(line)
    const record = mirroredEventRecordFromEnvelope(parsed.envelope as GuiEventEnvelope, line)

    expect(parsed.kind).toBe('gui-event')
    expect(record).toMatchObject({
      event_name: 'dd_cartridge_air_leak_summary',
      device_id: 'device-1',
      product_id: 33608,
      firmware_version: 5383001,
      run_uid: 'run-1',
      cartridge_serial: 'SS-SA-007-031-0134',
      upload_status: 'local_only',
    })
  })

  it('parses legacy command response text without losing manual command compatibility', () => {
    const parsed = parseSerialLine('[Command: bmp ReadPressure_hPa | Value: 1012.4]')

    expect(parsed.kind).toBe('legacy-response')
    expect(parsed.legacy).toMatchObject({
      command: 'bmp ReadPressure_hPa',
      ok: true,
      result: 1012.4,
    })
  })

  it('indexes compact summary metadata for replay storage', () => {
    const record = mirroredEventRecordFromEnvelope({
      type: 'event',
      event_name: 'dd_cartridge_air_leak_summary',
      data: {
        run: 'compact-run-1',
        cart: 'SS-SA-007-031-0134',
      },
    })

    expect(record.run_uid).toBe('compact-run-1')
    expect(record.cartridge_serial).toBe('SS-SA-007-031-0134')
  })

  it('indexes run context nested inside mirrored event payloads', () => {
    const record = mirroredEventRecordFromEnvelope({
      type: 'event',
      event_name: 'dd_test_step_result',
      data: {
        context: {
          run_uid: 'nested-run-1',
          cartridge_serial: 'SS-SA-007-031-0134',
        },
      },
    })

    expect(record.run_uid).toBe('nested-run-1')
    expect(record.cartridge_serial).toBe('SS-SA-007-031-0134')
  })

  it('indexes compact nested run context aliases', () => {
    const record = mirroredEventRecordFromEnvelope({
      type: 'event',
      event_name: 'dd_test_step_result',
      data: {
        context: {
          run: 'nested-compact-run-1',
        },
      },
    })

    expect(record.run_uid).toBe('nested-compact-run-1')
  })

  it('indexes linear-stage run id and mode without treating generic serial as cartridge serial', () => {
    const record = mirroredEventRecordFromEnvelope({
      type: 'event',
      event_name: 'dd_linear_stage_summary',
      data: {
        serial: 'SS-A-001-101A-0013',
        linear_stage_run_id: 'linear-1',
        linear_stage_mode: 'mechanics',
        result: 'Pass',
      },
    }, undefined, {
      workflow: 'linear_stage',
      tester_device_serial: 'SS-A-001-101A-0013',
      linear_stage_run_id: 'linear-1',
      linear_stage_mode: 'mechanics',
    })

    expect(record.linear_stage_run_id).toBe('linear-1')
    expect(record.linear_stage_mode).toBe('mechanics')
    expect(record.tester_device_serial).toBe('SS-A-001-101A-0013')
    expect(record.cartridge_serial).toBeUndefined()
  })

  it('keeps the station linear-stage run id when firmware emits its own run uid', () => {
    const record = mirroredEventRecordFromEnvelope({
      type: 'event',
      event_name: 'dd_linear_stage_summary',
      data: {
        run_uid: 'firmware-run-1',
        linear_stage_run_id: 'firmware-run-1',
        linear_stage_mode: 'optics',
      },
    }, undefined, {
      workflow: 'linear_stage',
      linear_stage_run_id: 'linear-local-1',
      linear_stage_mode: 'optics',
    })

    expect(record.run_uid).toBe('firmware-run-1')
    expect(record.firmware_run_uid).toBe('firmware-run-1')
    expect(record.linear_stage_run_id).toBe('linear-local-1')
  })

  it('ignores noisy logs as logs', () => {
    expect(parseSerialLine('normal firmware log line').kind).toBe('log')
  })
})
