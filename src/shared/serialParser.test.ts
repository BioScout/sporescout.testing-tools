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

  it('ignores noisy logs as logs', () => {
    expect(parseSerialLine('normal firmware log line').kind).toBe('log')
  })
})
