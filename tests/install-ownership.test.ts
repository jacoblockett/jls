import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  test('an unowned empty .jls is preserved, while positively identified legacy ownership may be cleaned', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      mkdirSync(join(root, '.jls'))
      cleanupRuntimeMetaRoot(root)
      expect(existsSync(join(root, '.jls'))).toBe(true)
      cleanupRuntimeMetaRoot(root, true)
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

  test('generated-data collisions require the exact manifest-declared JLS ownership contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      const generated = join(root, '.map')
      mkdirSync(generated)
      writeFileSync(join(generated, 'project.json'), '{}')
      const specs = [{
        path: '.map',
        marker: 'project.json',
        ownership_marker: '.jls-owned.json',
      }]

      expect(() => assertGeneratedDataOwnership(root, 'map', specs)).toThrow('does not carry its JLS ownership contract')
      writeFileSync(join(generated, '.jls-owned.json'), JSON.stringify({
        format: 1,
        owner: 'jls',
        kind: 'generated-data',
        skill: 'other',
      }))
      expect(() => assertGeneratedDataOwnership(root, 'map', specs)).toThrow('invalid JLS ownership contract')

      writeFileSync(join(generated, '.jls-owned.json'), JSON.stringify({
        format: 1,
        owner: 'jls',
        kind: 'generated-data',
        skill: 'map',
      }))
      expect(() => assertGeneratedDataOwnership(root, 'map', specs)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('legacy generated-data ownership may bridge a missing new marker but never override an invalid marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-owner-'))
    try {
      const generated = join(root, '.map')
      mkdirSync(generated)
      writeFileSync(join(generated, 'project.json'), '{}')
      const specs = [{
        path: '.map',
        marker: 'project.json',
        ownership_marker: '.jls-owned.json',
      }]

      expect(() => assertGeneratedDataOwnership(root, 'map', specs, () => true)).not.toThrow()
      writeFileSync(join(generated, '.jls-owned.json'), JSON.stringify({
        format: 1,
        owner: 'jls',
        kind: 'generated-data',
        skill: 'other',
      }))
      expect(() => assertGeneratedDataOwnership(root, 'map', specs, () => true)).toThrow('invalid JLS ownership contract')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('lifecycle preflights ownership before destructive replacement and only cleans JLS meta roots', () => {
    const source = readFileSync(new URL('../src/jls-v04-core.ts', import.meta.url), 'utf8')
    const installStart = source.indexOf('function installTargets(')
    const preflight = source.indexOf('assertInstallCollisions(pkg, scope, targets)', installStart)
    const destructiveReplace = source.indexOf('rmSync(dest, { recursive: true, force: true })', installStart)
    expect(preflight).toBeGreaterThan(installStart)
    expect(destructiveReplace).toBeGreaterThan(preflight)
    expect(source).toContain('assertVacantOrOwned(dest, previous?.name === skill')
    expect(source).toContain('legacyGeneratedDataOwned(scope, skill, target)')
    expect(source).toContain('cleanupRuntimeMetaRoot(group.scope.root, hadRuntime)')
    expect(source).not.toContain('rmSync(paths.skillRoot')
    expect(source).not.toContain('rmSync(parent)')
  })

  test('same-directory atomic writes do not delete the destination before rename', () => {
    const source = readFileSync(new URL('../src/jls-v04-core.ts', import.meta.url), 'utf8')
    expect(source).toContain('renameSync(tmp, path)')
    expect(source).not.toContain("if (isWindows && existsSync(path)) rmSync(path, { force: true })")
  })

  test('agent equals parsing closes both nested calls before the next branch', () => {
    const source = readFileSync(new URL('../src/jls-v04-core.ts', import.meta.url), 'utf8')
    expect(source).toContain("out.agents.push(arg.slice('--agent='.length))")
    expect(source).not.toContain("out.agents.push(arg.slice('--agent='.length)\n")
  })
})