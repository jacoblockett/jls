import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareInstallerSelfUninstall,
  windowsFinalizerScript,
} from '../src/self-uninstall'

describe('cross-platform installer self-uninstall', () => {
  test('POSIX removal is synchronous and verified before returning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-self-uninstall-'))
    const executable = join(root, 'jls')
    const dataRoot = join(root, 'data')
    writeFileSync(executable, 'portable binary placeholder')
    mkdirSync(dataRoot)
    writeFileSync(join(dataRoot, 'metadata.json'), '{}')

    try {
      expect(await prepareInstallerSelfUninstall(executable, dataRoot, 'linux')).toBe('complete')
      expect(existsSync(executable)).toBe(false)
      expect(existsSync(dataRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Windows finalizer uses process state rather than fixed timing', () => {
    const source = windowsFinalizerScript()
    expect(source).toContain('[System.Diagnostics.Process]::GetProcessById($parentPid)')
    expect(source).toContain('$parent.WaitForExit()')
    expect(source).toContain("[System.IO.File]::WriteAllText($readyFile, 'ready')")
    expect(source.indexOf("WriteAllText($readyFile, 'ready')")).toBeLessThan(source.indexOf('$parent.WaitForExit()'))
    expect(source.toLowerCase()).not.toContain('sleep')
    expect(source.toLowerCase()).not.toContain('ping ')
  })

  test('Windows finalizer verifies deletion and leaves diagnostics on failure', () => {
    const source = windowsFinalizerScript()
    expect(source).toContain('Test-Path -LiteralPath $executable')
    expect(source).toContain('Test-Path -LiteralPath $dataRoot')
    expect(source).toContain("Join-Path $dataRoot 'uninstall-error.json'")
    expect(source).toContain('JLS could not be fully uninstalled.')
    expect(source).toContain("[Console]::Out.WriteLine('◇  Done.')")
    expect(source).toContain("[Console]::Out.WriteLine('└')")
  })
})
