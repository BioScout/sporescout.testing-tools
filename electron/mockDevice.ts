import {
  CARTRIDGE_READINESS_COMMAND,
  CARTRIDGE_PROFILE_VERSION,
  LINEAR_STAGE_READINESS_COMMAND,
  linearStageModeForCommand,
  parseLinearStageSuiteCommand,
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
    const testName = typeof result.Name === 'string' ? result.Name : 'LINEAR_STAGE_COMPREHENSIVE'

    for (const [key, value] of Object.entries(detail)) {
      const stepRecord = asRecord(value)
      const stepNumber = parseStepNumber(key)
      const stepName = stripStepNumber(key)
      const expected = stepRecord.Expected
      const measured = stepRecord.Measured
      const resultText = String(stepRecord.Result ?? 'Unknown').toUpperCase()
      const error = typeof stepRecord.Error === 'string' ? stepRecord.Error : undefined

      this.emitLine(`[>> ACTION: ${testName} | Step ${stepNumber} | Action: ${stepName} | Expected: ${formatDetail(expected)}]`)
      await delay(120)
      this.emitLine(`[<< RESULT: ${testName} | Step ${stepNumber} | ${resultText} | Expected: ${formatDetail(expected)} | Measured: ${formatDetail(measured)}${error ? ` | Error: ${error}` : ''}]`)
      this.emitLine(formatGuiEvent(buildMockLinearStageStepEvent(command, response, stepName, stepRecord)))
      await delay(80)
    }

    this.emitLine(`[TEST: ${testName}] [OVERALL RESULT: ${response.ok ? 'PASS' : 'FAIL'}]`)
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
  return parseLinearStageSuiteCommand(command) !== undefined
}

function buildMockLinearStageResult(command: string): Record<string, unknown> {
  const mode = mockLinearStageMode(command)
  const session = parseLinearStageSuiteCommand(command)
  const sessionType = session?.sessionType ?? 'LINEAR_STAGE_COMPREHENSIVE'
  const sessionId = session?.sessionId ?? 1
  const profile = mode === 'mechanics_only' ? 'service' : 'production'
  const testMode = mode === 'mechanics_only' ? 'mechanics_only' : mode === 'optics_only' ? 'optics_only' : 'full_function'
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

  addStep('Enable 5V AUX rail', { '5V AUX enabled': true }, { Passed: true, '5V Aux Voltage': '5.08 V' })
  addStep('Connect 24V AUX', { Connected: true }, { Passed: true, Connected: true })
  addStep('Enable 24V AUX', { '24V AUX enabled': true }, { Passed: true, '24V Aux Voltage': '24.18 V' })
  if (mode === 'production_full') {
    addStep('Connect modem', { Connected: true }, { Passed: true, Connected: true })
  }
  addStep('Wait for CM4 readiness', { Available: true }, { Passed: true, Available: true })
  if (mode === 'production_full' || mode === 'optics_only') {
    addStep('Check camera connection', { Connected: true }, { Passed: true, Connected: true })
    addStep('Check camera image capture', { 'Image captured': true }, { Passed: true, 'Image captured': true, 'Image path': 'C:\\mock\\linear-stage\\camera_preflight.jpg' })
    addStep('Check camera LED', { 'Illumination detected': true }, { Passed: true, 'Illumination detected': true })
  }
  if (mode === 'production_full') {
    addStep('Wait for internet readiness', { Connected: true }, { Passed: true, Connected: true })
    addStep('Authenticate BioScout API', { Authenticated: true }, { Passed: true, Authenticated: true })
  }
  addStep('Connect steppers', { Connected: true }, { Passed: true, Connected: true })
  addStep('Start CM4 session', { session_type: sessionType }, { session_id: 'mock-cm4-session', planned_steps: mockCm4Steps(mode) })
  addStep('Initialize steppers', { profile, test_mode: testMode }, { Passed: true, initialized: true })

  const axes = [
    { axis: 'X', span: 182.42, delta: 0.08, repeat: 0.012, response: 0.91, focus: 0.44, current: 420 },
    { axis: 'Y', span: 74.96, delta: -0.04, repeat: 0.009, response: 0.88, focus: 0.39, current: 390 },
    { axis: 'Z', span: 38.02, delta: 0.03, repeat: 0.007, response: 0.82, focus: 0.33, current: 360 },
  ]

  if (mode === 'production_full' || mode === 'mechanics_only') {
    for (const item of axes) {
      const homeTolerance = 0.2
      addStep(`${item.axis} home switch`, { 'Home switch tolerance mm': homeTolerance }, {
        Passed: true,
        'Release mm': Number((item.repeat * 5).toFixed(3)),
        'Re-entry mm': Number((item.repeat * 4).toFixed(3)),
        'Repeatability mm': item.repeat,
        'Tolerance mm': homeTolerance,
      })
      addStep(`${item.axis} hard limit`, { 'Boundary event detected': true }, {
        Passed: true,
        detection_source: item.axis === 'X' ? 'front_limit_switch' : 'stallguard',
        stop_reason: item.axis === 'X' ? 'front_limit' : 'hard_limit',
        front_limit_position_mm: item.axis === 'X' ? Number((item.span + 0.12).toFixed(3)) : undefined,
        inferred_contact_position_mm: Number((item.span + 0.08).toFixed(3)),
        search_limit_position_mm: Number((item.span + 1.5).toFixed(3)),
        recovered_to_home: true,
      })
      addStep(`${item.axis} span`, { 'Expected span mm': item.span }, {
        Passed: true,
        'Expected span mm': item.span,
        'Measured span mm': Number((item.span + item.delta).toFixed(3)),
        'Delta mm': item.delta,
        'Within window': true,
        'Repeatability mm': Number((item.repeat * 1.2).toFixed(3)),
      })
      addStep(`${item.axis} current margin`, { 'Derated current run': true, 'Derating factor': 0.5 }, {
        Passed: true,
        'Configured current': item.current,
        'Derated current': Math.round(item.current * 0.5),
        'Derating factor': 0.5,
      })
    }
  }

  if (mode === 'production_full' || mode === 'optics_only') {
    addStep('Optical region selection', { 'Optical region selected': true }, {
      Passed: true,
      'Selected Y mm': 37.42,
      'Selected Z mm': 19.14,
      'Focus score': 0.76,
      'Artifact scan id': 'mock-scan-electron',
    })
    addStep('Home tile capture', { 'Home tile captured': true }, { Passed: true, 'Image ID': 'mock-home-tile-electron', 'Home tile error': '' })
    addStep('Production workspace stress', { 'Stress path complete': true }, { Passed: true, 'Target count': 12 })
    addStep('X focus', { 'Focus passed': true }, { Passed: true, 'Focus score': 0.81 })
    addStep('Y displacement', { 'Y optical displacement': true }, { Passed: true, 'Mean shift px': 18.4, overlap_correlation: 0.93, overlap_response: 0.86, overlap_matched: true })
    addStep('Z displacement', { 'Z optical displacement': true }, { Passed: true, 'Mean shift px': 16.7, overlap_correlation: 0.91, overlap_response: 0.84, overlap_matched: true })
  }

  if (mode === 'production_full') {
    addStep('Scan capture', { 'Tile count': 9 }, { Passed: true, 'Images captured': 9, scan_path: 'C:\\mock\\linear-stage\\scan' })
    addStep('Scan audit', { 'Trackable motion required': true }, {
      Passed: true,
      'Repeated frames detected': false,
      'Structural passed': true,
      'Monotonic Y passed': true,
      'Monotonic Z passed': true,
      'Trackable motion passed': true,
      'Focus passed': true,
      'Y optical passed': true,
      'Z optical passed': true,
      'Y pair count': 6,
      'Z pair count': 6,
      overlap_correlation: 0.94,
      overlap_response: 0.87,
      overlap_matched: true,
      'Artifact scan id': 'mock-grid-electron',
      'Audit error': '',
    })
    addStep('Artifact generation', { 'Scan folder exists': true }, {
      Passed: true,
      artifact_generation_passed: true,
      scan_artifact_images_captured: 9,
      scan_artifact_uploaded_supporting_files: true,
      scan_artifact_paths: [
        'C:\\mock\\linear-stage\\scan\\supporting_files\\scan_overlap_all_tiles.png',
        'C:\\mock\\linear-stage\\scan\\supporting_files\\scan_overlap_adjacent_pairs.png',
      ],
    })
    addStep('Upload', { 'Upload requested': true }, {
      Passed: true,
      scan_artifact_upload_requested: true,
      scan_artifact_upload_supported: true,
      scan_artifact_upload_attempted: true,
      scan_artifact_upload_passed: true,
      scan_artifact_upload_completed: true,
      scan_artifact_uploaded_images: 9,
      scan_artifact_cloud_scan_id: 'mock-cloud-scan-electron',
      scan_artifact_upload_error: '',
    })
  }

  if (mode === 'production_full' || mode === 'optics_only') {
    addStep('Post-stress recovery', { 'Recovery required': true }, { Passed: true, recovered_to_home: true })
  }

  addStep('Park/cleanup', 'Steppers parked', { Passed: true, parked: true })
  addStep('Close CM4 session', 'CM4 session closed', { Passed: true, closed: true })
  addStep('Restore power state', 'Power state restored', { Passed: true, restored: true })
  addStep('Linear-stage verdict', { overall_passed: true }, {
    overall_passed: true,
    last_step: 'park_steppers',
    last_step_result: 'PASS',
    last_step_safe_to_continue: true,
    last_step_state_uncertain: false,
  })

  return {
    Name: sessionType,
    IotId: 'MOCK-SS-GUI-001',
    SuiteId: sessionId,
    Result: 1,
    mode,
    linear_stage_mode: mode,
    session_type: sessionType,
    profile,
    test_mode: testMode,
    scan_artifact_upload_requested: mode === 'production_full',
    scan_capture_passed: mode === 'production_full' ? true : undefined,
    artifact_generation_passed: mode === 'production_full' ? true : undefined,
    upload_passed: mode === 'production_full' ? true : undefined,
    overall_passed: true,
    last_step: 'park_steppers',
    last_step_result: 'PASS',
    last_step_safe_to_continue: true,
    last_step_state_uncertain: false,
    Profile: profile,
    Detail: detail,
  }
}

function buildMockLinearStageEvents(command: string, response: GuiResponseEnvelope): GuiEventEnvelope[] {
  const result = buildMockLinearStageResult(command)
  const mode = mockLinearStageMode(command)
  const session = parseLinearStageSuiteCommand(command)
  const sessionType = session?.sessionType ?? 'LINEAR_STAGE_COMPREHENSIVE'
  const sessionId = session?.sessionId ?? 1
  return [
    {
      type: 'event',
      event_name: 'dd_test_session_create',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        session_uid: sessionId,
        session_type: sessionType,
        suite_repeats: session?.repeats ?? 1,
        mode,
        linear_stage_mode: mode,
      },
    },
    {
      type: 'event',
      event_name: 'dd_test_suite_create',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        session_uid: sessionId,
        session_type: sessionType,
        planned_test_names: [sessionType],
        mode,
        linear_stage_mode: mode,
      },
    },
    {
      type: 'event',
      event_name: 'dd_test_item_create',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        session_uid: sessionId,
        session_type: sessionType,
        test_name: sessionType,
        planned_step_names: Object.keys(result.Detail as Record<string, unknown>).map(stripStepNumber),
        mode,
        linear_stage_mode: mode,
      },
    },
    {
      type: 'event',
      event_name: 'dd_test_item_update',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        session_uid: sessionId,
        session_type: sessionType,
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
        session_uid: sessionId,
        session_type: sessionType,
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
    {
      type: 'event',
      event_name: 'dd_test_suite_update',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        session_uid: sessionId,
        session_type: sessionType,
        suite_result: 'Pass',
        failed_tests: [],
        mode,
        linear_stage_mode: mode,
      },
    },
    {
      type: 'event',
      event_name: 'dd_test_session_update',
      firmware_version: response.firmware_version,
      device_id: response.device_id,
      product_id: response.product_id,
      timestamp_ms: Date.now(),
      data: {
        session_uid: sessionId,
        session_type: sessionType,
        session_status: 'Pass',
        mode,
        linear_stage_mode: mode,
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
  const session = parseLinearStageSuiteCommand(command)
  return {
    type: 'event',
    event_name: 'dd_test_step_result',
    firmware_version: response.firmware_version,
    device_id: response.device_id,
    product_id: response.product_id,
    timestamp_ms: Date.now(),
    data: {
      session_uid: session?.sessionId ?? 1,
      session_type: session?.sessionType ?? 'LINEAR_STAGE_COMPREHENSIVE',
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
  if (normalized.includes('mechanics')) return 'mechanics_only'
  if (normalized.includes('optics')) return 'optics_only'
  return 'production_full'
}

function mockCm4Steps(mode: LinearStageMode): string[] {
  const mechanics = [
    'initialize_steppers',
    'x_home_switch',
    'x_hard_limit',
    'x_span',
    'x_current_margin',
    'y_home_switch',
    'y_hard_limit',
    'y_span',
    'y_current_margin',
    'z_home_switch',
    'z_hard_limit',
    'z_span',
    'z_current_margin',
  ]
  if (mode === 'mechanics_only') return [...mechanics, 'park_steppers']
  if (mode === 'optics_only') return ['initialize_steppers', 'select_optical_region', 'home_tile_capture', 'production_workspace_stress', 'x_focus', 'y_displacement', 'z_displacement', 'post_stress_recovery', 'park_steppers']
  const scan = ['scan_capture', 'scan_audit', 'artifact_generation', 'upload']
  return [...mechanics, 'select_optical_region', 'home_tile_capture', 'production_workspace_stress', 'x_focus', 'y_displacement', 'z_displacement', ...scan, 'post_stress_recovery', 'park_steppers']
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
    operator_action: 'Ready to start the production linear-stage suite.',
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
