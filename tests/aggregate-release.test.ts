import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { aggregateRelease } from '../scripts/aggregate-release'
import { expectedSkillNameFromRepository, parseSkillCatalog } from '../src/skill-catalog'
import { TARGET_KEYS, installerAssetName, targetByKey } from '../src/targets'

const repo = resolve(import.meta.dir, '..')

describe('embedded skill catalog', () => {
  test('catalog contains repository pointers only', () => {
    const raw = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8'))
    const repositories = parseSkillCatalog(raw)
    expect(repositories.length).toBeGreaterThan(0)
    for (const repository of repositories) expect(repository).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    expect(expectedSkillNameFromRepository('owner/jls-example')).toBe('example')
    expect(expectedSkillNameFromRepository('someone/curated-skill')).toBeUndefined()
  })

  test('rejects malformed or duplicate repository pointers', () => {
    expect(() => parseSkillCatalog(['not-a-repository'])).toThrow()
    expect(() => parseSkillCatalog(['owner/repo', 'owner/repo'])).toThrow()
  })
})

describe('installer release aggregation', () => {
  test('copies exactly one executable for every supported target', () => {
    const root = join(repo, 'build', 'aggregate-release-test')
    const inputRoot = join(root, 'targets')
    const outputRoot = join(root, 'release')
    rmSync(root, { recursive: true, force: true })

    for (const key of TARGET_KEYS) {
      const name = installerAssetName(targetByKey(key))
      const dir = join(inputRoot, `target-${key}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), key)
    }

    aggregateRelease({ inputRoot, outputRoot })

    const expected = TARGET_KEYS
      .map((key) => installerAssetName(targetByKey(key)))
      .sort()
    expect(readdirSync(outputRoot).sort()).toEqual(expected)

    rmSync(root, { recursive: true, force: true })
  })
})
