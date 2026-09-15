import { describe, expect, test } from 'bun:test'
import {
  TARGET_KEYS,
  TARGETS,
  installerAssetName,
  targetByKey,
} from '../src/targets'

describe('distribution targets', () => {
  test('locks the required public target set', () => {
    expect(TARGET_KEYS).toEqual([
      'windows-x64',
      'windows-arm64',
      'macos-x64',
      'macos-arm64',
      'linux-x64-gnu',
      'linux-arm64-gnu',
      'linux-x64-musl',
      'linux-arm64-musl',
    ])
    expect(Object.keys(TARGETS)).toEqual([...TARGET_KEYS])
  })

  test('owns installer compiler facts for every target', () => {
    for (const key of TARGET_KEYS) {
      const target = targetByKey(key)
      expect(target.key).toBe(key)
      expect(['windows', 'macos', 'linux']).toContain(target.os)
      expect(['x64', 'arm64']).toContain(target.arch)
      expect(['msvc', 'darwin', 'gnu', 'musl']).toContain(target.abi)
      expect(target.bunCompileTarget.startsWith('bun-')).toBe(true)
      expect(target.executableSuffix).toBe(target.os === 'windows' ? '.exe' : '')
      expect(installerAssetName(target)).toBe(`jls-${key}${target.executableSuffix}`)
    }
  })

  test('uses the intended Bun targets', () => {
    expect(TARGETS['windows-x64'].bunCompileTarget).toBe('bun-windows-x64-baseline')
    expect(TARGETS['windows-arm64'].bunCompileTarget).toBe('bun-windows-arm64')
    expect(TARGETS['macos-x64'].bunCompileTarget).toBe('bun-darwin-x64-baseline')
    expect(TARGETS['macos-arm64'].bunCompileTarget).toBe('bun-darwin-arm64')
    expect(TARGETS['linux-x64-gnu'].bunCompileTarget).toBe('bun-linux-x64-baseline')
    expect(TARGETS['linux-arm64-gnu'].bunCompileTarget).toBe('bun-linux-arm64')
    expect(TARGETS['linux-x64-musl'].bunCompileTarget).toBe('bun-linux-x64-musl')
    expect(TARGETS['linux-arm64-musl'].bunCompileTarget).toBe('bun-linux-arm64-musl')
  })

  test('rejects unknown targets', () => {
    expect(() => targetByKey('linux-x64')).toThrow()
  })
})
