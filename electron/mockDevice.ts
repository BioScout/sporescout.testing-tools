import {
  CARTRIDGE_READINESS_COMMAND,
  CARTRIDGE_PROFILE_VERSION,
  type GuiEventEnvelope,
  type GuiResponseEnvelope,
  type TestPhase,
} from '../src/shared/contracts'
import { formatGuiEvent, formatGuiResponse } from '../src/shared/serialParser'

type EmitLine = (line: string) => void

export class MockSerialDevice {
  private runCounter = 0
  private readonly firmwareVersion = 5383001
  private activeRunUid?: string
  private activeCartridge?: string

  constructor(private readonly emitLine: EmitLine) {}

  async send(command: string): Promise<GuiResponseEnvelope> {
    const response = this.buildResponse(command)
    setTimeout(() => this.emitLine(formatGuiResponse(response)), 80)

    for (const event of this.buildEvents(command, response)) {
      setTimeout(() => this.emitLine(formatGuiEvent(event)), 140)
    }

    return response
  }

  private buildResponse(command: string): GuiResponseEnvelope {
    const timestamp_ms = Date.now()
    const base = {
      type: 'response' as const,
      ok: true,
      command,
      firmware_version: this.firmwareVersion,
      device_id: 'MOCK-SS-GUI-001',
      product_id: 33608,
      timestamp_ms,
    }

    if (command === 'system GetFirmwareVersion') {
      return { ...base, result: this.firmwareVersion }
    }

    if (command === CARTRIDGE_READINESS_COMMAND) {
      return { ...base, result: buildReadinessResult(this.firmwareVersion) }
    }

    if (command.includes('load_switch_24v_aux_in IsConnected')) {
      return { ...base, result: true }
    }

    if (command.includes('solenoid IsLocked')) {
      return { ...base, result: true }
    }

    if (command.includes('GetIdleState')) {
      return { ...base, result: 'idle' }
    }

    if (command.includes('self_check')) {
      return { ...base, result: { passed: true } }
    }

    if (command.startsWith('solenoid Unlock')) {
      return { ...base, result: { locked: false } }
    }

    if (command.startsWith('solenoid Lock')) {
      return { ...base, result: { locked: true } }
    }

    if (command.startsWith('test cartridge_leak open ')) {
      const parts = command.split(/\s+/)
      this.runCounter += 1
      this.activeCartridge = parts[3]
      this.activeRunUid = `mock-run-${String(this.runCounter).padStart(4, '0')}`
      return {
        ...base,
        result: {
          run_uid: this.activeRunUid,
          cartridge_serial: this.activeCartridge,
          profile_version: CARTRIDGE_PROFILE_VERSION,
        },
      }
    }

    if (command.startsWith('test cartridge_leak nozzle ')) {
      return { ...base, result: { run_uid: this.activeRunUid, phase: 'nozzle' } }
    }

    if (command.startsWith('test cartridge_leak sealed ')) {
      return { ...base, result: { run_uid: this.activeRunUid, phase: 'sealed' } }
    }

    if (command.startsWith('test cartridge_leak cancel ')) {
      return { ...base, result: { run_uid: this.activeRunUid, cancelled: true } }
    }

    return { ...base, result: 'ok' }
  }

  private buildEvents(command: string, response: GuiResponseEnvelope): GuiEventEnvelope[] {
    if (command.startsWith('test cartridge_leak open ')) {
      return [this.measurementEvent('open', 2.68)]
    }

    if (command.startsWith('test cartridge_leak nozzle ')) {
      return [this.measurementEvent('nozzle', 2.54)]
    }

    if (command.startsWith('test cartridge_leak sealed ')) {
      return [
        this.measurementEvent('sealed', 0.34),
        {
          type: 'event',
          event_name: 'dd_cartridge_air_leak_summary',
          firmware_version: this.firmwareVersion,
          device_id: response.device_id,
          product_id: response.product_id,
          timestamp_ms: Date.now(),
          data: {
            run_uid: this.activeRunUid,
            cartridge_serial: this.activeCartridge,
            profile_version: CARTRIDGE_PROFILE_VERSION,
            open_slpm: 2.68,
            nozzle_slpm: 2.54,
            sealed_slpm: 0.34,
            sealed_open_ratio: 0.127,
            sample_quality: 'acceptable',
            guidance: 'ACCEPT_SINGLE_PASS',
          },
        },
      ]
    }

    return []
  }

  private measurementEvent(phase: TestPhase, slpm: number): GuiEventEnvelope {
    return {
      type: 'event',
      event_name: `dd_test_cartridge_air_leak_${phase}`,
      firmware_version: this.firmwareVersion,
      device_id: 'MOCK-SS-GUI-001',
      product_id: 33608,
      timestamp_ms: Date.now(),
      data: {
        run_uid: this.activeRunUid,
        cartridge_serial: this.activeCartridge,
        phase,
        profile_version: CARTRIDGE_PROFILE_VERSION,
        slpm,
        raw_mean_slpm: Number((slpm * 1.006).toFixed(3)),
        median_slpm: Number((slpm * 0.998).toFixed(3)),
        stddev_slpm: Number((slpm * 0.018).toFixed(3)),
        min_slpm: Number((slpm * 0.953).toFixed(3)),
        max_slpm: Number((slpm * 1.046).toFixed(3)),
        trimmed_count: 24,
        outlier_count: 6,
        coefficient_of_variation: 0.018,
        sample_quality: 'acceptable',
        settle_ms: 12000,
        dt_ms: 100,
      },
    }
  }
}

function buildReadinessResult(firmwareVersion: number) {
  return {
    command: 'cartridge_leak readiness',
    firmware_version: firmwareVersion,
    hardware_version: 'mock',
    ready: true,
    status: 'READY',
    operator_action: 'Ready to start: test cartridge_leak open <cartridge_serial> <fixture_id> phase1-characterization',
    checks: {
      active_run_clear: { ok: true, skipped: false, message: 'no active cartridge_leak run' },
      idle_state: { ok: true, skipped: false, message: 'firmware state is Idle', detail: { current_state: 'Idle' } },
      station_self_check: { ok: true, skipped: false, message: 'station dependencies ok' },
      tester_power: { ok: true, skipped: false, message: '24V Aux is in range', detail: { aux24_v: 24.1 } },
      cm4_ready: {
        ok: true,
        skipped: false,
        message: 'CM4 is available',
        detail: { available: true, cm4_state: 'Available', aux_5v_rail_state: 'Enabled', aux5_v: 5.1 },
      },
      solenoid_locked: { ok: true, skipped: false, message: 'solenoid reports locked', detail: { is_unlocked: false } },
    },
  }
}
