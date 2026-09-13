import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeWindowsFinalizer,
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

  test('Windows finalizer is transported as a UTF-16LE encoded command', () => {
    const source = windowsFinalizerScript()
    const encoded = encodeWindowsFinalizer(source)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(source)

    const implementation = readFileSyncForTest()
    expect(implementation).toContain("'-EncodedCommand'")
    expect(implementation).not.toContain("'-Command',\n    WINDOWS_FINALIZER")
  })

  test('Windows finalizer verifies deletion, reports failures, and avoids an empty final branch', () => {
    const source = windowsFinalizerScript()
    expect(source).toContain('Test-Path -LiteralPath $executable')
    expect(source).toContain('Test-Path -LiteralPath $dataRoot')
    expect(source).toContain("Join-Path $dataRoot 'uninstall-error.json'")
    expect(source).toContain('JLS could not be fully uninstalled.')
    expect(source).toContain('$successNode = [char]0x25C6')
    expect(source).toContain('$finalBranch = [char]0x2514')
    expect(source).toContain("[Console]::Out.WriteLine($successNode.ToString() + '  Done.')")
    expect(source).not.toContain('[Console]::Out.WriteLine($finalBranch.ToString())')
    expect(source).toContain("[Console]::Error.WriteLine($finalBranch.ToString() + '  ' + $message)")
  })
})

function readFileSyncForTest(): string {
  return require('node:fs').readFileSync(new URL('../src/self-uninstall.ts', import.meta.url), 'utf8')
}
