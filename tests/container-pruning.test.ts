import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneEmptyContainers } from '../src/container-pruning'

describe('empty container pruning', () => {
  test('prunes known empty containers leaf-to-root', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    try {
      const bin = join(root, '.jls', 'map', 'bin')
      mkdirSync(bin, { recursive: true })
      pruneEmptyContainers([join(root, '.jls'), join(root, '.jls', 'map'), bin])
      expect(existsSync(join(root, '.jls'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('preserves non-empty containers and their ancestors', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    try {
      const bin = join(root, '.jls', 'map', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'keep.txt'), 'keep')
      pruneEmptyContainers([join(root, '.jls'), join(root, '.jls', 'map'), bin])
      expect(existsSync(join(bin, 'keep.txt'))).toBe(true)
      expect(existsSync(join(root, '.jls'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('never follows or removes symlink containers', () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    const outside = mkdtempSync(join(tmpdir(), 'jls-prune-outside-'))
    try {
      const link = join(root, '.jls')
      symlinkSync(outside, link)
      pruneEmptyContainers([link])
      expect(existsSync(link)).toBe(true)
      expect(existsSync(outside)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
