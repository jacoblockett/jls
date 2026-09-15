import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { catalogSkillReferences } from '../scripts/aggregate-release'

const repo = resolve(import.meta.dir, '..')

describe('release catalog projection', () => {
  test('catalog exposes usable skill release discovery references', () => {
    const catalog = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8')) as Record<string, any>
    expect(catalog.skills && typeof catalog.skills === 'object' && !Array.isArray(catalog.skills)).toBe(true)

    const entries = Object.entries(catalog.skills as Record<string, any>)
    expect(entries.length).toBeGreaterThan(0)
    for (const [name, reference] of entries) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(reference && typeof reference === 'object' && !Array.isArray(reference)).toBe(true)
      expect(typeof reference.manifest_url).toBe('string')
      expect(reference.manifest_url.trim().length).toBeGreaterThan(0)
      expect(new URL(reference.manifest_url).protocol).toBe('https:')
    }
  })

  test('projects catalog entries into release-owned manifest references', () => {
    const references = {
      alpha: { manifest_url: 'https://fixture.invalid/alpha/manifest.json' },
      beta: { manifest_url: 'https://fixture.invalid/beta/manifest.json' },
    }
    expect(catalogSkillReferences(references)).toEqual(references)
  })

  test('rejects unusable release-owned manifest references', () => {
    expect(() => catalogSkillReferences({
      alpha: { manifest_url: 'http://example.com/manifest.json' },
    })).toThrow()
  })
})
