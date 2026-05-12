import type { GuiEventEnvelope, GuiResponseEnvelope, LocalRunContext, MirroredEventRecord, ParsedSerialLine } from './contracts'

const RESPONSE_PREFIX = '@SSGUI:RSP '
const EVENT_PREFIX = '@SSGUI:EVT '

export function formatGuiResponse(envelope: GuiResponseEnvelope): string {
  return `${RESPONSE_PREFIX}${JSON.stringify(envelope)}`
}

export function formatGuiEvent(envelope: GuiEventEnvelope): string {
  return `${EVENT_PREFIX}${JSON.stringify(envelope)}`
}

export function parseSerialLine(line: string): ParsedSerialLine {
  const raw = line.trim()

  if (raw.startsWith(RESPONSE_PREFIX)) {
    return parseJsonEnvelope(raw, RESPONSE_PREFIX, 'gui-response')
  }

  if (raw.startsWith(EVENT_PREFIX)) {
    return parseJsonEnvelope(raw, EVENT_PREFIX, 'gui-event')
  }

  const legacy = parseLegacyCommandResponse(raw)
  if (legacy) {
    return { kind: 'legacy-response', raw, legacy }
  }

  return { kind: 'log', raw }
}

function parseJsonEnvelope(
  raw: string,
  prefix: string,
  kind: 'gui-response' | 'gui-event',
): ParsedSerialLine {
  try {
    const parsed = JSON.parse(raw.slice(prefix.length))
    if (kind === 'gui-response') {
      return { kind, raw, envelope: normalizeResponseEnvelope(parsed) }
    }

    return { kind, raw, envelope: normalizeEventEnvelope(parsed) }
  } catch (error) {
    return {
      kind: 'log',
      raw,
      error: error instanceof Error ? error.message : 'Invalid JSON envelope',
    }
  }
}

function normalizeResponseEnvelope(value: unknown): GuiResponseEnvelope {
  const source = asRecord(value)
  return {
    type: 'response',
    ok: Boolean(source.ok),
    command: String(source.command ?? ''),
    result: source.result,
    error: typeof source.error === 'string' ? source.error : undefined,
    result_omitted: typeof source.result_omitted === 'boolean' ? source.result_omitted : undefined,
    result_json_bytes: asOptionalNumber(source.result_json_bytes),
    message: typeof source.message === 'string' ? source.message : undefined,
    firmware_version: asOptionalNumber(source.firmware_version),
    device_id: asOptionalString(source.device_id),
    product_id: asOptionalNumber(source.product_id),
    timestamp_ms: asOptionalNumber(source.timestamp_ms),
  }
}

function normalizeEventEnvelope(value: unknown): GuiEventEnvelope {
  const source = asRecord(value)
  return {
    type: 'event',
    event_name: String(source.event_name ?? ''),
    data: asRecord(source.data),
    firmware_version: asOptionalNumber(source.firmware_version),
    device_id: asOptionalString(source.device_id),
    product_id: asOptionalNumber(source.product_id),
    timestamp_ms: asOptionalNumber(source.timestamp_ms),
  }
}

export function parseLegacyCommandResponse(line: string): GuiResponseEnvelope | null {
  const match = line.match(/^\[Command:\s*(?<command>[^|]+)\|\s*(?<field>Value|Error):\s*(?<value>.*)\]$/)
  if (!match?.groups) {
    return null
  }

  const ok = match.groups.field === 'Value'
  const value = match.groups.value.trim()
  return {
    type: 'response',
    ok,
    command: match.groups.command.trim(),
    result: ok ? coerceLegacyValue(value) : undefined,
    error: ok ? undefined : value,
  }
}

export function mirroredEventRecordFromEnvelope(
  envelope: GuiEventEnvelope,
  rawLine?: string,
  context?: LocalRunContext,
  appVersion?: string,
): MirroredEventRecord {
  const eventContext = asRecord(envelope.data.context)
  const eventRunUid = asOptionalString(envelope.data.run_uid)
    ?? asOptionalString(envelope.data.run)
    ?? asOptionalString(eventContext.run_uid)
    ?? asOptionalString(eventContext.run)
  const runUid = eventRunUid ?? context?.run_uid
  const linearStageRunId =
    context?.linear_stage_run_id ??
    asOptionalString(envelope.data.linear_stage_run_id) ??
    asOptionalString(envelope.data.linearStageRunId) ??
    asOptionalString(eventContext.linear_stage_run_id) ??
    asOptionalString(eventContext.linearStageRunId)
  const linearStageMode =
    asOptionalLinearStageMode(envelope.data.linear_stage_mode) ??
    asOptionalLinearStageMode(envelope.data.mode) ??
    asOptionalLinearStageMode(eventContext.linear_stage_mode) ??
    asOptionalLinearStageMode(eventContext.mode) ??
    context?.linear_stage_mode
  const allowGenericSerialAsCartridge = context?.workflow === 'cartridge_subassembly' || isCartridgeEvent(envelope)
  const cartridgeSerial =
    asOptionalString(envelope.data.cartridge_serial) ??
    asOptionalString(envelope.data.cartridge) ??
    asOptionalString(envelope.data.cart) ??
    (allowGenericSerialAsCartridge ? asOptionalString(envelope.data.serial) : undefined) ??
    asOptionalString(eventContext.cartridge_serial) ??
    asOptionalString(eventContext.cartridge) ??
    asOptionalString(eventContext.cart) ??
    (allowGenericSerialAsCartridge ? asOptionalString(eventContext.serial) : undefined) ??
    context?.cartridge_serial

  const idempotencyKey = buildIdempotencyKey(envelope, runUid, cartridgeSerial, rawLine)

  return {
    event_id: idempotencyKey,
    idempotency_key: idempotencyKey,
    event_name: envelope.event_name,
    data: envelope.data,
    raw_line: rawLine,
    local_timestamp: new Date().toISOString(),
    device_id: envelope.device_id,
    product_id: envelope.product_id,
    firmware_version: envelope.firmware_version,
    run_uid: runUid,
    firmware_run_uid: eventRunUid && eventRunUid !== context?.run_uid ? eventRunUid : undefined,
    cartridge_serial: cartridgeSerial,
    station_id: context?.station_id,
    operator: context?.operator,
    batch: context?.batch,
    tester_device_serial: context?.tester_device_serial,
    enclosure_base_id: context?.enclosure_base_id,
    nozzle_id: context?.nozzle_id,
    seal_fixture_id: context?.seal_fixture_id,
    workflow: context?.workflow,
    linear_stage_run_id: linearStageRunId,
    linear_stage_mode: linearStageMode,
    app_version: appVersion,
    jsonl_status: 'pending',
    upload_status: 'local_only',
  }
}

function coerceLegacyValue(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  const numeric = Number(value)
  if (!Number.isNaN(numeric) && value !== '') return numeric

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asOptionalLinearStageMode(value: unknown): MirroredEventRecord['linear_stage_mode'] {
  return value === 'full' || value === 'mechanics' || value === 'optics' ? value : undefined
}

function isCartridgeEvent(envelope: GuiEventEnvelope): boolean {
  const text = `${envelope.event_name} ${JSON.stringify(envelope.data)}`.toLowerCase()
  return text.includes('cartridge') || text.includes('air_leak')
}

function buildIdempotencyKey(
  envelope: GuiEventEnvelope,
  runUid?: string,
  cartridgeSerial?: string,
  rawLine?: string,
): string {
  const seed = [
    envelope.event_name,
    envelope.device_id,
    envelope.product_id,
    envelope.firmware_version,
    envelope.timestamp_ms,
    runUid,
    cartridgeSerial,
    asOptionalString(envelope.data.evt_type),
    asOptionalString(envelope.data.step_name),
    asOptionalString(envelope.data.test_name),
    rawLine ?? JSON.stringify(envelope.data),
  ]
    .filter((value) => value !== undefined && value !== '')
    .join('|')

  return `evt_${fnv1a64(seed)}`
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
