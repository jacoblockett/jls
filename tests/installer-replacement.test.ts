import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareInstallerReplacement,
  windowsInstallerReplacementScript,
} from '../src/installer-replacement'

describe('cross-platform installer replacement', () => {
  test('POSIX replacement is synchronous and verified', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-update-'))
    const executable = join(root, 'jls')
    const staged = join(root, '.jls.update')
    writeFileSync(executable, 'old')
    writeFileSync(staged, 'new')

    try {
      await prepareInstallerReplacement(staged, executable, 'linux')
      expect(readFileSync(executable, 'utf8')).toBe('new')
      expect(existsSync(staged)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Windows replacement waits on exact process state and uses atomic native replacement', () => {
    const source = windowsInstallerReplacementScript()
    expect(source).toContain('[System.Diagnostics.Process]::GetProcessById($parentPid)')
    expect(source).toContain('$parent.WaitForExit()')
    expect(source).toContain("[System.IO.File]::WriteAllText($readyFile, 'ready')")
    expect(source.indexOf("WriteAllText($readyFile, 'ready')")).toBeLessThan(source.indexOf('$parent.WaitForExit()'))
    expect(source).toContain('MoveFileEx')
    expect(source).toContain('$MOVEFILE_REPLACE_EXISTING')
    expect(source).toContain('$MOVEFILE_WRITE_THROUGH')
    expect(source.toLowerCase()).not.toContain('sleep')
    expect(source.toLowerCase()).not.toContain('ping ')
  })

  test('Windows replacement escapes the Bun job through cmd START', () => {
    const implementation = readFileSync(new URL('../src/installer-replacement.ts', import.meta.url), 'utf8')
    expect(implementation).toContain("spawn('cmd.exe', [")
    expect(implementation).toContain("'start',")
    expect(implementation).toContain("'/b',")
    expect(implementation).toContain("'powershell.exe',")
    expect(implementation).toContain("'-File',")
    expect(implementation).toContain('await waitForBootstrap(bootstrap)')
    expect(implementation).toContain('await waitForReadySignal(readyFile, errorFile)')
    expect(implementation).not.toContain('detached: true')
  })

  test('legacy timer-based installer replacement is no longer part of the updater', () => {
    const updater = readFileSync(new URL('../src/installer-updater.ts', import.meta.url), 'utf8')
    expect(updater).not.toContain('windowsReplacementCommand')
    expect(updater).not.toContain('scheduleInstallerReplacement')
    expect(updater).not.toContain('ping 127.0.0.1')
    expect(updater).not.toContain('detached: true')
  })

  test('Windows finalizer survives its Bun parent and replaces the installer', async () => {
    if (process.platform !== 'win32') return

    const root = mkdtempSync(join(tmpdir(), 'jls-update-win-'))
    const executable = join(root, 'jls-copy.exe')
    const staged = join(root, '.jls-copy.update.exe')
    const helper = join(root, 'replace.ts')
    writeFileSync(executable, 'old installer')
    writeFileSync(staged, 'new installer')

    const moduleUrl = new URL('../src/installer-replacement.ts', import.meta.url).href
    writeFileSync(helper, [
      `import { prepareInstallerReplacement } from ${JSON.stringify(moduleUrl)}`,
      'await prepareInstallerReplacement(process.argv[2]!, process.argv[3]!)',
    ].join('\n'))

    try {
      const child = spawn(process.execPath, [helper, staged, executable], {
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
        throw new Error(`Windows installer-update helper exited ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      }

      const deadline = Date.now() + 5000
      while ((existsSync(staged) || readFileSync(executable, 'utf8') !== 'new installer') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (existsSync(staged) || readFileSync(executable, 'utf8') !== 'new installer') {
        throw new Error([
          'Windows installer replacement did not complete after its Bun parent exited',
          `stagedExists=${String(existsSync(staged))}`,
          `executable=${JSON.stringify(readFileSync(executable, 'utf8'))}`,
          `stdout:\n${stdout}`,
          `stderr:\n${stderr}`,
        ].join('\n'))
      }
      expect(readFileSync(executable, 'utf8')).toBe('new installer')
      expect(existsSync(staged)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
