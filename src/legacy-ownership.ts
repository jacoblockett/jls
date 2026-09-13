import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'

type LegacyOwnershipExpectation =
  | { kind: 'runtime-root' }
  | { kind: 'skill-runtime' | 'generated-data'; skill: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function matchesLegacyOwnershipMarker(value: unknown, expected: LegacyOwnershipExpectation): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  if (marker.format !== 1 || marker.owner !== 'jls' || marker.kind !== expected.kind) return false

  if (expected.kind === 'runtime-root') {
    return hasExactKeys(marker, ['format', 'owner', 'kind'])
  }

  return marker.skill === expected.skill
    && hasExactKeys(marker, ['format', 'owner', 'kind', 'skill'])
}

export function removeLegacyOwnershipMarker(
  path: string,
  expected: LegacyOwnershipExpectation,
): boolean {
  if (!existsSync(path) || !lstatSync(path).isFile()) return false
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!matchesLegacyOwnershipMarker(value, expected)) return false
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}
