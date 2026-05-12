import type { UpdateCheckResult } from './contracts'

export function formatDisplayVersion(version: string | undefined): string {
  if (!version?.trim()) return 'unknown'

  const match = version.trim().match(/^(\d+)(?:\.(\d+))?/)
  if (!match) return version.trim()

  const major = Number.parseInt(match[1], 10)
  const minorText = (match[2] ?? '0').padEnd(2, '0').slice(0, 2)
  if (!Number.isFinite(major)) return version.trim()

  return `${major}.${minorText}`
}

export function appVersionStatusLabel(appVersion: string | undefined, updateResult: UpdateCheckResult): string {
  const current = `App v${formatDisplayVersion(appVersion)}`
  if (updateResult.status === 'current') return `${current} · latest`
  if (updateResult.status === 'available') return `${current} · update v${formatDisplayVersion(updateResult.version)}`
  if (updateResult.status === 'checking') return `${current} · checking`
  return current
}

export function appVersionStatusColor(updateResult: UpdateCheckResult): 'default' | 'success' | 'warning' {
  if (updateResult.status === 'current') return 'success'
  if (updateResult.status === 'available') return 'warning'
  return 'default'
}
