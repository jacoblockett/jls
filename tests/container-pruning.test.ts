import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneEmptyContainers } from '../src/container-pruning'

describe('uninstall ownership boundaries', () => {
  test('removes an owned runtime subtree and then its empty JLS root', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    try {
      const runtime = join(root, '.jls', 'map')
      const bin = join(runtime, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'leftover.txt'), 'owned')
      pruneEmptyContainers([join(root, '.jls'), runtime, bin])
      expect(existsSync(join(root, '.jls'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('removes the owned skill subtree without pruning shared .agents containers', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    try {
      const skillRoot = join(root, '.agents', 'skills')
      const skill = join(skillRoot, 'map')
      mkdirSync(skill, { recursive: true })
      writeFileSync(join(skill, 'leftover.txt'), 'owned')
      pruneEmptyContainers([skillRoot, skill])
      expect(existsSync(skill)).toBe(false)
      expect(existsSync(skillRoot)).toBe(true)
      expect(existsSync(join(root, '.agents'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('never prunes harness-owned resource directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    try {
      const codexAgents = join(root, '.codex', 'agents')
      const claudeAgents = join(root, '.claude', 'agents')
      mkdirSync(codexAgents, { recursive: true })
      mkdirSync(claudeAgents, { recursive: true })
      pruneEmptyContainers([codexAgents, claudeAgents])
      expect(existsSync(codexAgents)).toBe(true)
      expect(existsSync(join(root, '.codex'))).toBe(true)
      expect(existsSync(claudeAgents)).toBe(true)
      expect(existsSync(join(root, '.claude'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps the JLS root while another runtime remains', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    try {
      const map = join(root, '.jls', 'map')
      const tasks = join(root, '.jls', 'tasks')
      mkdirSync(map, { recursive: true })
      mkdirSync(tasks, { recursive: true })
      writeFileSync(join(map, 'leftover.txt'), 'owned')
      writeFileSync(join(tasks, 'keep.txt'), 'keep')
      pruneEmptyContainers([join(root, '.jls'), map])
      expect(existsSync(map)).toBe(false)
      expect(existsSync(join(tasks, 'keep.txt'))).toBe(true)
      expect(existsSync(join(root, '.jls'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('never follows or removes a symlink used as an owned-subtree path', () => {
    if (process.platform === 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'jls-prune-'))
    const outside = mkdtempSync(join(tmpdir(), 'jls-prune-outside-'))
    try {
      const skillRoot = join(root, '.agents', 'skills')
      mkdirSync(skillRoot, { recursive: true })
      const link = join(skillRoot, 'map')
      symlinkSync(outside, link)
      pruneEmptyContainers([skillRoot, link])
      expect(existsSync(link)).toBe(true)
      expect(existsSync(outside)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
