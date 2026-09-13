import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

    const implementation = readFileSync(new URL('../src/self-uninstall.ts', import.meta.url), 'utf8')
    expect(implementation).toContain("'-EncodedCommand'")
    expect(implementation).not.toContain("'-Command',\n    WINDOWS_FINALIZER")
  })

  test('Windows encoded finalizer reaches READY and completes after its parent exits', async () => {
    if (process.platform !== 'win32') return

    const root = mkdtempSync(join(tmpdir(), 'jls-self-uninstall-win-'))
    const executable = join(root, 'jls-copy.exe')
    const dataRoot = join(root, 'data')
    const helper = join(root, 'arm.ts')
    writeFileSync(executable, 'portable binary placeholder')
    mkdirSync(dataRoot)
    writeFileSync(join(dataRoot, 'metadata.json'), '{}')

    const moduleUrl = new URL('../src/self-uninstall.ts', import.meta.url).href
    writeFileSync(helper, [
      `import { armWindowsSelfUninstall } from ${JSON.stringify(moduleUrl)}`,
      'await armWindowsSelfUninstall(process.argv[2]!, process.argv[3]!)',
    ].join('\n'))

    try {
      const child = spawn(process.execPath, [helper, executable, dataRoot], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolve(code))
      })
      if (exitCode !== 0) {
        throw new Error(`Windows self-uninstall helper exited ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      }

      const deadline = Date.now() + 5000
      while ((existsSync(executable) || existsSync(dataRoot)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(existsSync(executable)).toBe(false)
      expect(existsSync(dataRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
