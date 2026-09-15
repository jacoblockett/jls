import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareInstallerReplacement } from '../src/installer-replacement'

describe('cross-platform installer replacement', () => {
  test('POSIX replacement replaces the executable and removes staging', async () => {
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

  test('Windows replacement survives its Bun parent and replaces the installer', async () => {
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
      expect(existsSync(staged)).toBe(false)
      expect(readFileSync(executable, 'utf8')).toBe('new installer')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
