import { describe, expect, it } from 'vitest'
import { explainCartridgeSerial, isValidCartridgeSerial, normalizeCartridgeSerial } from './cartridgeSerial'

describe('cartridge serial validation', () => {
  it('accepts the expected scanned cartridge format', () => {
    expect(isValidCartridgeSerial('SS-SA-007-031-0134')).toBe(true)
  })

  it('normalizes scanner input before validation', () => {
    expect(normalizeCartridgeSerial(' ss-sa-007-031-0134 ')).toBe('SS-SA-007-031-0134')
  })

  it('rejects non-cartridge hardware ID values', () => {
    expect(isValidCartridgeSerial('NOZL-0001')).toBe(false)
    expect(explainCartridgeSerial('NOZL-0001')).toBe('Cartridge must start with SS-SA-007-.')
  })
})
