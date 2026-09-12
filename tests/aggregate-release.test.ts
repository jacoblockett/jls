import { describe, expect, test } from 'bun:test'
import { catalogSkillReferences } from '../scripts/aggregate-release'

describe('release catalog projection', () => {
  test('strips installer-UI metadata from release skill references', () => {
    expect(catalogSkillReferences({
      map: {
        manifest_url: 'https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json',
        description: 'UI-only description',
      },
      tasks: {
        manifest_url: 'https://github.com/jacoblockett/jls-tasks/releases/latest/download/manifest.json',
        description: 'Another UI-only description',
      },
    })).toEqual({
      map: {
        manifest_url: 'https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json',
      },
      tasks: {
        manifest_url: 'https://github.com/jacoblockett/jls-tasks/releases/latest/download/manifest.json',
      },
    })
  })

  test('continues to validate release-owned manifest references', () => {
    expect(() => catalogSkillReferences({
      map: { manifest_url: 'http://example.com/manifest.json' },
    })).toThrow('map manifest_url must use HTTPS')
  })
})
