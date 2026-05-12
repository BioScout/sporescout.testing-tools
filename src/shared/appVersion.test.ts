import { appVersionStatusLabel, formatDisplayVersion } from './appVersion'
import { describe, expect, it } from 'vitest'

describe('app version display', () => {
  it('formats semver as x.xx for operator display', () => {
    expect(formatDisplayVersion('0.1.0')).toBe('0.10')
    expect(formatDisplayVersion('0.11.0')).toBe('0.11')
    expect(formatDisplayVersion('0.12.0')).toBe('0.12')
    expect(formatDisplayVersion('0.13.0')).toBe('0.13')
    expect(formatDisplayVersion('0.14.0')).toBe('0.14')
    expect(formatDisplayVersion('1.2.3')).toBe('1.20')
    expect(formatDisplayVersion('2.12.0')).toBe('2.12')
  })

  it('includes latest/update state in the visible label', () => {
    expect(appVersionStatusLabel('0.1.0', { checked_at: '', status: 'current', version: '0.1.0' })).toBe('App v0.10 · latest')
    expect(appVersionStatusLabel('0.1.0', { checked_at: '', status: 'available', version: '0.2.0' })).toBe('App v0.10 · update v0.20')
    expect(appVersionStatusLabel('0.14.0', { checked_at: '', status: 'failed', version: '0.14.0' })).toBe('App v0.14')
  })
})
