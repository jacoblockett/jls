import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstallCollisions,
  removeInstallCollisions,
} from '../src/install-collision-override'

function runtimePackage(root = ''): any {
  return {
    manifest: {
      format: 1,
      name: 'map',
      version: '0.4.0',
      min_installer: '0.1.0',
      description: 'test',
      skill_files: ['SKILL.md'],
      runtime: 'rust',
      runtime_cli: 'map',
      runtime_files: ['schema.surql'],
    },
    root,
    cleanup() {},
  }
}

describe('file-granular installation collision contract', () => {
  test('pre-existing runtime directories are containers, not collisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-files-'))
    try {
      mkdirSync(join(root, '.jls', 'map', 'bin'), { recursive: true })
      writeFileSync(join(root, '.jls', 'unrelated.txt'), 'keep')
      const scope = { kind: 'project', origin: 'custom', identity: root, root } as const
      expect(detectInstallCollisions(runtimePackage(), scope, [])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an exact runtime filename collision is detected without condemning its directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-files-'))
    try {
      const bin = join(root, '.jls', 'map', 'bin')
      mkdirSync(bin, { recursive: true })
      const executable = process.platform === 'win32' ? join(bin, 'map.exe') : join(bin, 'map')
      writeFileSync(executable, 'foreign')
      const scope = { kind: 'project', origin: 'custom', identity: root, root } as const
      const collisions = detectInstallCollisions(runtimePackage(), scope, [])
      expect(collisions.map((collision) => collision.path)).toContain(executable)
      expect(collisions.map((collision) => collision.path)).not.toContain(join(root, '.jls'))
      expect(collisions.map((collision) => collision.path)).not.toContain(join(root, '.jls', 'map'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('destructive override removes only the exact collided path and preserves siblings', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-files-'))
    try {
      const bin = join(root, '.jls', 'map', 'bin')
      mkdirSync(bin, { recursive: true })
      const executable = process.platform === 'win32' ? join(bin, 'map.exe') : join(bin, 'map')
      const sibling = join(bin, 'keep.txt')
      writeFileSync(executable, 'foreign')
      writeFileSync(sibling, 'keep')
      const scope = { kind: 'project', origin: 'custom', identity: root, root } as const
      const collisions = detectInstallCollisions(runtimePackage(), scope, [])
      removeInstallCollisions(collisions)
      expect(existsSync(executable)).toBe(false)
      expect(existsSync(sibling)).toBe(true)
      expect(existsSync(bin)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('lifecycle never recursively replaces or removes skill/runtime directories', () => {
    const source = readFileSync(new URL('../src/jls-v04-core.ts', import.meta.url), 'utf8')
    expect(source).toContain('const collisions = detectInstallCollisions(pkg, scope, targets.map((target) => target.agent))')
    expect(source).toContain('removeObsoleteSkillFiles(previous, pkg.manifest, dest)')
    expect(source).toContain('removeSkillFiles(manifest, target.skillPath)')
    expect(source).toContain('for (const path of runtimeFiles(manifest, group.scope)) removeFile(path)')
    expect(source).not.toContain('rmSync(dest, { recursive: true, force: true })')
    expect(source).not.toContain('rmSync(target.skillPath, { recursive: true, force: true })')
    expect(source).not.toContain('rmSync(runtimeRoot, { recursive: true, force: true })')
  })

  test('legacy marker names are validated cleanup-only state and are never written', () => {
    const source = readFileSync(new URL('../src/jls-v04-core.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { removeLegacyOwnershipMarker } from './legacy-ownership'")
    expect(source).toContain("{ kind: 'runtime-root' }")
    expect(source).toContain("{ kind: 'skill-runtime', skill: manifest.name }")
    expect(source).toContain("{ kind: 'generated-data', skill: manifest.name }")
    expect(source).not.toContain('markRuntimeLayout(')
  })

  test('scope-local installed manifest is preferred over global cached fallback', () => {
    const source = readFileSync(new URL('../src/jls-v04-core.ts', import.meta.url), 'utf8')
    const local = source.indexOf('for (const group of discoverInstallations(scope))')
    const fallback = source.indexOf('return cachedPackageManifest(skill)', local)
    expect(local).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(local)
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
