export const CARTRIDGE_SERIAL_PATTERN = /^SS-SA-007-\d{3}-\d{4}$/

export function isValidCartridgeSerial(value: string): boolean {
  return CARTRIDGE_SERIAL_PATTERN.test(value.trim())
}

export function normalizeCartridgeSerial(value: string): string {
  return value.trim().toUpperCase()
}

export function explainCartridgeSerial(value: string): string | null {
  const normalized = normalizeCartridgeSerial(value)

  if (normalized.length === 0) {
    return 'Scan a cartridge serial.'
  }

  if (!normalized.startsWith('SS-SA-007-')) {
    return 'Cartridge must start with SS-SA-007-.'
  }

  if (!CARTRIDGE_SERIAL_PATTERN.test(normalized)) {
    return 'Expected format SS-SA-007-XXX-YYYY.'
  }

  return null
}
