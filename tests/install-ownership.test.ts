import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstallCollisions,
  removeInstallCollisions,
} from '../src/install-collision-override'

function runtimePackage(root = ''): any {
  return {
    manifest: {
      name: 'map',
      version: '0.4.0',
      min_installer: '0.1.0',
      description: 'test',
      skill_files: ['SKILL.md'],
      runtime: 'rust',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/map.exe' },
      runtime_cli: 'map',
      runtime_files: ['schema.surql'],
    },
    root,
    cleanup() {},
  }
}

function multiToolPackage(root = ''): any {
  return {
    manifest: {
      name: 'inspiration',
      version: '1.0.0',
      min_installer: '0.4.1',
      description: 'test',
      skill_files: ['SKILL.md'],
      tools: {
        history: {
          artifacts: { 'windows-x64': 'tools/windows-x64/history.exe' },
          token: 'HISTORY_CLI',
        },
        screenshot: {
          artifacts: { 'windows-x64': 'tools/windows-x64/screenshot.exe' },
          token: 'SCREENSHOT_CLI',
        },
      },
      tool_files: ['browser-support.dat'],
    },
    root,
    cleanup() {},
  }
}

describe('file-granular installation collision behavior', () => {
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

  test('symlinked runtime containers are collisions rather than write-through directories', () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'jls-files-'))
    const outside = mkdtempSync(join(tmpdir(), 'jls-outside-'))
    try {
      symlinkSync(outside, join(root, '.jls'))
      const scope = { kind: 'project', origin: 'custom', identity: root, root } as const
      const collisions = detectInstallCollisions(runtimePackage(), scope, [])
      expect(collisions.map((collision) => collision.path)).toContain(join(root, '.jls'))
      expect(existsSync(join(outside, 'map'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('multiple declared tools are independently collision-checked', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-files-'))
    try {
      const bin = join(root, '.jls', 'inspiration', 'bin')
      mkdirSync(bin, { recursive: true })
      const history = process.platform === 'win32' ? join(bin, 'history.exe') : join(bin, 'history')
      const screenshot = process.platform === 'win32' ? join(bin, 'screenshot.exe') : join(bin, 'screenshot')
      writeFileSync(history, 'foreign')
      writeFileSync(screenshot, 'foreign')
      const scope = { kind: 'project', origin: 'custom', identity: root, root } as const
      const collisions = detectInstallCollisions(multiToolPackage(), scope, [])
      expect(collisions.map((collision) => collision.path)).toContain(history)
      expect(collisions.map((collision) => collision.path)).toContain(screenshot)
      expect(collisions).toHaveLength(2)
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
})
