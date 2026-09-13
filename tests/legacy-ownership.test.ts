import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeLegacyOwnershipMarker } from '../src/legacy-ownership'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'jls-legacy-marker-'))
}

describe('legacy ownership marker migration', () => {
  test('removes only an exact old runtime-root marker', () => {
    const root = scratch()
    try {
      const marker = join(root, '.jls-owned.json')
      writeFileSync(marker, JSON.stringify({ format: 1, owner: 'jls', kind: 'runtime-root' }))
      expect(removeLegacyOwnershipMarker(marker, { kind: 'runtime-root' })).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preserves coincidentally named foreign and malformed files', () => {
    const root = scratch()
    try {
      const marker = join(root, '.jls-owned.json')
      const foreign = JSON.stringify({ format: 1, owner: 'someone-else', kind: 'runtime-root' })
      writeFileSync(marker, foreign)
      expect(removeLegacyOwnershipMarker(marker, { kind: 'runtime-root' })).toBe(false)
      expect(readFileSync(marker, 'utf8')).toBe(foreign)

      writeFileSync(marker, '{not json')
      expect(removeLegacyOwnershipMarker(marker, { kind: 'runtime-root' })).toBe(false)
      expect(readFileSync(marker, 'utf8')).toBe('{not json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preserves near-matches with extra fields or the wrong skill', () => {
    const root = scratch()
    try {
      const marker = join(root, '.jls-owned.json')
      const extra = JSON.stringify({
        format: 1,
        owner: 'jls',
        kind: 'generated-data',
        skill: 'map',
        note: 'foreign extension',
      })
      writeFileSync(marker, extra)
      expect(removeLegacyOwnershipMarker(marker, { kind: 'generated-data', skill: 'map' })).toBe(false)
      expect(readFileSync(marker, 'utf8')).toBe(extra)

      const wrongSkill = JSON.stringify({ format: 1, owner: 'jls', kind: 'generated-data', skill: 'tasks' })
      writeFileSync(marker, wrongSkill)
      expect(removeLegacyOwnershipMarker(marker, { kind: 'generated-data', skill: 'map' })).toBe(false)
      expect(readFileSync(marker, 'utf8')).toBe(wrongSkill)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('never treats a directory as a marker file', () => {
    const root = scratch()
    try {
      const marker = join(root, '.jls-owned.json')
      mkdirSync(marker)
      expect(removeLegacyOwnershipMarker(marker, { kind: 'runtime-root' })).toBe(false)
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
