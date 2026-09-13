import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertGeneratedDataOwnership,
  assertRuntimeLayoutAvailable,
  cleanupRuntimeMetaRoot,
  markRuntimeLayout,
  runtimeRootOwned,
  runtimeSkillOwned,
} from '../src/install-ownership'

describe('installation ownership contract', () => {
  test('a pre-existing unowned .jls directory is a collision', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      mkdirSync(join(root, '.jls'))
      expect(() => assertRuntimeLayoutAvailable(root, 'map')).toThrow('not owned by JLS')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('runtime ownership is explicit and removes only an empty JLS meta-directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      assertRuntimeLayoutAvailable(root, 'map')
      markRuntimeLayout(root, 'map')
      expect(runtimeRootOwned(root)).toBe(true)
      expect(runtimeSkillOwned(root, 'map')).toBe(true)

      rmSync(join(root, '.jls', 'map'), { recursive: true, force: true })
      cleanupRuntimeMetaRoot(root)
      expect(existsSync(join(root, '.jls'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an owned runtime meta-directory with unrelated content is retained', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      markRuntimeLayout(root, 'map')
      rmSync(join(root, '.jls', 'map'), { recursive: true, force: true })
      writeFileSync(join(root, '.jls', 'unrelated.txt'), 'keep')
      cleanupRuntimeMetaRoot(root)
      expect(existsSync(join(root, '.jls', 'unrelated.txt'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('generated-data collisions require the manifest-declared marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      mkdirSync(join(root, '.map'))
      const specs = [{ path: '.map', marker: 'project.json' }]
      expect(() => assertGeneratedDataOwnership(root, 'map', specs)).toThrow('not identified as map data')
      writeFileSync(join(root, '.map', 'project.json'), '{}')
      expect(() => assertGeneratedDataOwnership(root, 'map', specs)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
