import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { catalogSkillReferences } from '../scripts/aggregate-release'

const repo = resolve(import.meta.dir, '..')

describe('release catalog projection', () => {
  test('catalog contains only skill manifest discovery references', () => {
    const catalog = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8'))
    expect(Object.keys(catalog)).toEqual(['skills'])
    expect(catalog).toEqual({
      skills: {
        map: {
          manifest_url: 'https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json',
        },
        tasks: {
          manifest_url: 'https://github.com/jacoblockett/jls-tasks/releases/latest/download/manifest.json',
        },
      },
    })
  })

  test('projects catalog entries down to release-owned manifest references', () => {
    expect(catalogSkillReferences({
      map: {
        manifest_url: 'https://github.com/jacoblockett/jls-map/releases/latest/download/manifest.json',
      },
      tasks: {
        manifest_url: 'https://github.com/jacoblockett/jls-tasks/releases/latest/download/manifest.json',
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
