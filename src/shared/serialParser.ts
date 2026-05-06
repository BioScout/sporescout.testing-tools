import type { GuiEventEnvelope, GuiResponseEnvelope, ParsedSerialLine } from './contracts'

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
): {
  event_name: string
  data: Record<string, unknown>
  raw_line?: string
  local_timestamp: string
  device_id?: string
  product_id?: number
  firmware_version?: number
  run_uid?: string
  cartridge_serial?: string
  upload_status: 'local_only'
} {
  const runUid = asOptionalString(envelope.data.run_uid)
  const cartridgeSerial =
    asOptionalString(envelope.data.cartridge_serial) ??
    asOptionalString(envelope.data.cartridge) ??
    asOptionalString(envelope.data.serial)

  return {
    event_name: envelope.event_name,
    data: envelope.data,
    raw_line: rawLine,
    local_timestamp: new Date().toISOString(),
    device_id: envelope.device_id,
    product_id: envelope.product_id,
    firmware_version: envelope.firmware_version,
    run_uid: runUid,
    cartridge_serial: cartridgeSerial,
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
