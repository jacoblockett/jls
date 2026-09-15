import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareInstallerSelfUninstall } from '../src/self-uninstall'

describe('cross-platform installer self-uninstall', () => {
  test('POSIX self-uninstall removes the executable and installer data', async () => {
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

  test('Windows self-uninstall survives its Bun parent, completes cleanup, and stays silent on success', async () => {
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
      expect(stdout).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
