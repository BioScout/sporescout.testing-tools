import {
  CARTRIDGE_READINESS_COMMAND,
  CARTRIDGE_PROFILE_VERSION,
  LINEAR_STAGE_MODE_COMMANDS,
  LINEAR_STAGE_MOTION_COMMANDS,
  LINEAR_STAGE_READINESS_COMMAND,
  linearStageModeForCommand,
  type GuiEventEnvelope,
  type GuiResponseEnvelope,
  type LinearStageMode,
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
    if (isLinearStageTestCommand(command)) {
      return await this.sendLinearStageCommand(command)
    }

    const response = this.buildResponse(command)
    setTimeout(() => this.emitLine(formatGuiResponse(response)), 80)

    for (const event of this.buildEvents(command, response)) {
      setTimeout(() => this.emitLine(formatGuiEvent(event)), 140)
    }

    return response
  }

  private async sendLinearStageCommand(command: string): Promise<GuiResponseEnvelope> {
    const response = this.buildResponse(command)
    const result = asRecord(response.result)
    const detail = asRecord(result.Detail)

    for (const [key, value] of Object.entries(detail)) {
      const stepRecord = asRecord(value)
      const stepNumber = parseStepNumber(key)
      const stepName = stripStepNumber(key)
      const expected = stepRecord.Expected
      const measured = stepRecord.Measured
      const resultText = String(stepRecord.Result ?? 'Unknown').toUpperCase()
      const error = typeof stepRecord.Error === 'string' ? stepRecord.Error : undefined

      this.emitLine(`[>> ACTION: LINEAR_STAGE_TEST | Step ${stepNumber} | Action: ${stepName} | Expected: ${formatDetail(expected)}]`)
      await delay(120)
      this.emitLine(`[<< RESULT: LINEAR_STAGE_TEST | Step ${stepNumber} | ${resultText} | Expected: ${formatDetail(expected)} | Measured: ${formatDetail(measured)}${error ? ` | Error: ${error}` : ''}]`)
      this.emitLine(formatGuiEvent(buildMockLinearStageStepEvent(command, response, stepName, stepRecord)))
      await delay(80)
    }

    this.emitLine(`[TEST: LINEAR_STAGE_TEST] [OVERALL RESULT: ${response.ok ? 'PASS' : 'FAIL'}]`)
    this.emitLine(formatGuiResponse(response))
    for (const event of buildMockLinearStageEvents(command, response)) {
      this.emitLine(formatGuiEvent(event))
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

    if (command === LINEAR_STAGE_READINESS_COMMAND || command === 'test linear_stage readiness' || command === 'test step prepare' || command === 'test step readiness') {
      return { ...base, result: buildLinearStageReadinessResult(this.firmwareVersion) }
    }

    if (command.includes('load_switch_24v_aux_in IsConnected')) {
      return { ...base, result: true }
    }

    if (command.includes('solenoid IsUnlocked')) {
      return { ...base, result: false }
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

    if (isLinearStageTestCommand(command)) {
      return { ...base, result: buildMockLinearStageResult(command) }
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

    if (isLinearStageTestCommand(command)) {
      return buildMockLinearStageEvents(command, response)
    }

    return []
  }

  private measurementEvent(phase: TestPhase, slpm: number): GuiEventEnvelope {
    const samples = buildMockSamples(slpm)
    return {
      type: 'event',
      event_name: 'dd_test_step_result',
      firmware_version: this.firmwareVersion,
      device_id: 'MOCK-SS-GUI-001',
      product_id: 33608,
      timestamp_ms: Date.now(),
      data: {
        step_name: `MEASURE_${phase.toUpperCase()}_INLET`,
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
        artifacts: {
          measurement: {
            valid: true,
            sample_count: 30,
            flow_slpm_mean: slpm,
            flow_slpm_raw_mean: Number((slpm * 1.006).toFixed(3)),
            flow_slpm_median: Number((slpm * 0.998).toFixed(3)),
            flow_slpm_stddev: Number((slpm * 0.018).toFixed(3)),
            flow_slpm_min: Math.min(...samples),
            flow_slpm_max: Math.max(...samples),
            trimmed_sample_count: 24,
            outlier_count: 6,
            coefficient_of_variation: 0.018,
            stability_limit_slpm: Number(Math.max(0.04, slpm * 0.05).toFixed(3)),
            quality_ok: true,
            fan_pwm_pct: 100,
            rpm: 17600,
            pressure_hpa: 1012.4,
            temperature_c: 23.8,
            environment_source: 'MOCK',
            settle_ms: 12000,
            dt_ms: 100,
            flow_slpm_samples: samples,
          },
        },
        settle_ms: 12000,
        dt_ms: 100,
      },
    }
  }
}

function buildMockSamples(slpm: number): number[] {
  return Array.from({ length: 30 }, (_value, index) => {
    const wave = Math.sin(index * 0.9) * slpm * 0.018
    const offset = (index % 5) * slpm * 0.002
    return Number((slpm + wave + offset).toFixed(3))
  })
}

function isLinearStageTestCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  if (/\s(prepare|readiness|status)$/.test(trimmed)) {
    return false
  }
  return LINEAR_STAGE_MOTION_COMMANDS.some((candidate) => candidate.toLowerCase() === trimmed)
}

function buildMockLinearStageResult(command: string): Record<string, unknown> {
  const mode = mockLinearStageMode(command)
  const productionProfile = mode === 'full' || command.toLowerCase().includes('production') || command.toLowerCase().includes('step')
  const deploymentProfile = command.toLowerCase().includes('deployment')
  const profile = deploymentProfile ? 'deployment' : productionProfile ? 'production' : mode
  const includeMechanical = mode === 'full' || mode === 'mechanics'
  const includeOptics = mode === 'full' || mode === 'optics'
  const detail: Record<string, unknown> = {}
  let number = 1

  const addStep = (name: string, expected: unknown, measured: unknown, result: 'Pass' | 'Warn' | 'Fail' = 'Pass') => {
    detail[`${String(number).padStart(2, '0')} | ${name}`] = {
      Expected: expected,
      Measured: measured,
      Result: result,
    }
    number += 1
  }

  addStep(
    'Check dependencies',
    {
      '5V Aux Voltage': '4.75-5.25 V',
      'Pi Available': true,
      '24V Aux Voltage': '23-25 V',
      'Steppers Load Switch': 'Connected',
    },
    {
      '5V Aux Voltage': '5.08 V',
      'Pi Available': true,
      '24V Aux Voltage': '24.18 V',
      'Steppers Load Switch': 'Connected',
    },
  )
  addStep('CM4 task running', { 'CM4 progress event': 'reported' }, {
    Source: 'CM4 task progress',
    Status: 'running',
    Phase: 'cm4_task',
    Mode: mode,
    'Progress sequence': 1,
  }, 'Warn')
  addStep('Initialise Steppers', { Profile: profile, 'Steppers initialised': true }, 'Steppers initialised and enabled')

  const axes = [
    { axis: 'X', span: 182.42, delta: 0.08, repeat: 0.012, response: 0.91, focus: 0.44, current: 420 },
    { axis: 'Y', span: 74.96, delta: -0.04, repeat: 0.009, response: 0.88, focus: 0.39, current: 390 },
    { axis: 'Z', span: 38.02, delta: 0.03, repeat: 0.007, response: 0.82, focus: 0.33, current: 360 },
  ]

  for (const item of axes) {
    if (includeMechanical) {
      addStep(`${item.axis} home switch qualification`, { 'Home switch leave/re-enter': true }, {
        Passed: true,
        'Release mm': Number((item.repeat * 5).toFixed(3)),
        'Re-entry mm': Number((item.repeat * 4).toFixed(3)),
        'Repeatability mm': item.repeat,
      })
      addStep(`${item.axis} positive boundary qualification`, { 'Boundary event detected': true }, {
        Passed: true,
        'Boundary event detected': true,
        'Stop position mm': Number((item.span + 0.12).toFixed(3)),
        'Repeatability mm': Number((item.repeat * 1.5).toFixed(3)),
      })
      addStep(`${item.axis} span qualification`, { 'Within calibrated span window': true, 'Expected span mm': item.span }, {
        Passed: true,
        'Expected span mm': item.span,
        'Measured span mm': Number((item.span + item.delta).toFixed(3)),
        'Delta mm': item.delta,
        'Within window': true,
        'Repeatability mm': Number((item.repeat * 1.2).toFixed(3)),
      })
    }
    if (includeMechanical) {
      addStep(`${item.axis} derated current margin`, { 'Derated current run': true, 'Derating factor': 0.5 }, {
        Passed: true,
        'Configured current': item.current,
        'Derated current': Math.round(item.current * 0.5),
        'Derating factor': 0.5,
      })
      if (item.axis === 'X') {
        addStep('X front-limit diagnosis', { 'Front-limit diagnostic completed': true }, {
          Passed: true,
          'Front-limit edge mm': Number((item.span + 0.08).toFixed(3)),
          'Repeatability mm': Number((item.repeat * 1.4).toFixed(3)),
        })
      }
    }
  }

  if (includeOptics) {
    addStep('Select optical region', { 'Optical region selected': true }, {
      Passed: true,
      'Selected Y mm': 37.42,
      'Selected Z mm': 19.14,
      'Focus score': 0.76,
      'Artifact scan id': 'mock-scan-electron',
    })
    addStep('3x3 scan audit', {
      '3x3 scan audit': true,
      'Repeated frames detected': false,
      'Monotonic Y passed': true,
      'Monotonic Z passed': true,
      'Focus passed': true,
    }, {
      Passed: true,
      'Repeated frames detected': false,
      'Monotonic Y passed': true,
      'Monotonic Z passed': true,
      'Focus passed': true,
      'Frame count': 9,
      'Minimum focus score': 0.73,
      'Artifact scan id': 'mock-grid-electron',
    })
    for (const item of axes) {
      addStep(`${item.axis} optical qualification`, { 'Optical response': true }, {
        Passed: true,
        'Expected step mm': 1.0,
        'Mean shift px': Number((18 + Math.abs(item.delta) * 10).toFixed(2)),
        'Minimum response': item.response,
        'Focus score range': item.focus,
        'Image artifact id': `mock-${item.axis.toLowerCase()}-image-electron`,
      })
    }
  }

  addStep('Park Steppers', 'Steppers parked', 'Parked')

  return {
    Name: `LINEAR_STAGE_${mode.toUpperCase()}_TEST`,
    IotId: 'MOCK-SS-GUI-001',
    SuiteId: 0,
    Result: 1,
    mode,
    linear_stage_mode: mode,
    Profile: profile,
    Detail: detail,
  }
}

function buildMockLinearStageEvents(command: string, response: GuiResponseEnvelope): GuiEventEnvelope[] {
  const result = buildMockLinearStageResult(command)
  const mode = mockLinearStageMode(command)
  return [
    {
      type: 'event',
      event_name: 'dd_test_item_update',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        test_name: result.Name,
        command,
        result: 'Pass',
        mode,
        linear_stage_mode: mode,
        profile: result.Profile,
        detail: result.Detail,
      },
    },
    {
      type: 'event',
      event_name: 'dd_linear_stage_summary',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        test_name: result.Name,
        command,
        result: 'Pass',
        mode,
        linear_stage_mode: mode,
        step_count: Object.keys(result.Detail as Record<string, unknown>).length,
        failed_steps: 0,
        artifacts: {
          scan_id: 'mock-grid-electron',
        },
      },
    },
  ]
}

function buildMockLinearStageStepEvent(
  command: string,
  response: GuiResponseEnvelope,
  stepName: string,
  stepRecord: Record<string, unknown>,
): GuiEventEnvelope {
  const result = buildMockLinearStageResult(command)
  const mode = mockLinearStageMode(command)
  return {
    type: 'event',
    event_name: 'dd_test_step_result',
    firmware_version: response.firmware_version,
    device_id: response.device_id,
    product_id: response.product_id,
    timestamp_ms: Date.now(),
    data: {
      test_name: result.Name,
      step_name: stepName,
      result: stepRecord.Result ?? 'Unknown',
      expected: stepRecord.Expected,
      measured: stepRecord.Measured,
      error: stepRecord.Error,
      mode,
      linear_stage_mode: mode,
      profile: result.Profile,
    },
  }
}

function mockLinearStageMode(command: string): LinearStageMode {
  const canonical = linearStageModeForCommand(command)
  if (canonical) return canonical
  const normalized = command.trim().toLowerCase()
  if (normalized === LINEAR_STAGE_MODE_COMMANDS.mechanics || normalized.includes('mechanics')) return 'mechanics'
  if (normalized === LINEAR_STAGE_MODE_COMMANDS.optics || normalized.includes('optics')) return 'optics'
  return 'full'
}

function buildReadinessResult(firmwareVersion: number) {
  return {
    command: 'cartridge_leak prepare',
    readiness_mode: 'prepare',
    firmware_version: firmwareVersion,
    hardware_version: 'mock',
    ready: true,
    status: 'READY',
    operator_action: 'Ready to start: test cartridge_leak open <cartridge_serial> <fixture_id> phase1-characterization',
    solenoid_lock_check_deferred: 0,
    checks: {
      active_run_clear: { ok: true, skipped: false, message: 'no active cartridge_leak run' },
      idle_state: { ok: true, skipped: false, message: 'firmware state is Idle', detail: { current_state: 'Idle' } },
      station_self_check: { ok: true, skipped: false, message: 'station self-check passed' },
      tester_power: { ok: true, skipped: false, message: '24V Aux is in range', detail: { aux24_v: 24.1 } },
      cm4_power: { ok: true, skipped: false, message: 'tester computer power is ready' },
      cm4_ready: {
        ok: true,
        skipped: false,
        message: 'tester computer is ready',
        detail: { available: true, cm4_state: 'Available', aux_5v_rail_state: 'Enabled', aux5_v: 5.1 },
      },
      solenoid_locked: { ok: true, skipped: false, message: 'locked' },
    },
  }
}

function buildLinearStageReadinessResult(firmwareVersion: number) {
  return {
    command: 'linear_stage prepare',
    readiness_mode: 'prepare',
    firmware_version: firmwareVersion,
    hardware_version: 'mock',
    ready: 1,
    status: 'READY',
    operator_action: 'Ready to start: test linear_stage full',
    check_idle_state: 1,
    check_station_boot_ready: 1,
    check_cm4_power: 1,
    cm4_power_enable_attempted: false,
    check_cm4_ready: 1,
    cm4_enable_requested: false,
    check_tester_power: 1,
    tester_power_enable_attempted: false,
    check_steppers_power: 1,
    steppers_power_enable_attempted: false,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function parseStepNumber(name: string): number {
  const match = name.match(/^(\d+)\s*\|/)
  return match ? Number(match[1]) : 0
}

function stripStepNumber(name: string): string {
  return name.replace(/^\d+\s*\|\s*/, '')
}

function formatDetail(value: unknown): string {
  if (value === undefined) return '-'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
