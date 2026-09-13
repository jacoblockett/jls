import { randomUUID } from 'node:crypto'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const WINDOWS_REPLACER = String.raw`
$ErrorActionPreference = 'Stop'
$parentPid = [int]$env:JLS_UPDATE_PARENT_PID
$staged = $env:JLS_UPDATE_STAGED
$executable = $env:JLS_UPDATE_EXECUTABLE
$readyFile = $env:JLS_UPDATE_READY_FILE
$errorFile = $env:JLS_UPDATE_ERROR_FILE
$finalizerFile = $env:JLS_UPDATE_FINALIZER_FILE
$ready = $false

function Remove-FinalizerFile {
  try { Remove-Item -LiteralPath $finalizerFile -Force -ErrorAction SilentlyContinue } catch {}
}

function Save-Failure([string]$message) {
  try { [System.IO.File]::WriteAllText($errorFile, $message) } catch {}
  if ($ready) {
    [Console]::Error.WriteLine('JLS could not finish updating the installer: ' + $message)
  }
}

try {
  # Acquire the exact live JLS process before READY. JLS will not exit until READY exists,
  # so the PID cannot be recycled between acquisition and this process-handle wait.
  $parent = [System.Diagnostics.Process]::GetProcessById($parentPid)
  [System.IO.File]::WriteAllText($readyFile, 'ready')
  $ready = $true
  $parent.WaitForExit()

  try { Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue } catch {}

  # MoveFileEx replaces the destination atomically on the same volume and avoids a delete gap.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JlsInstallerUpdateNative {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
}
'@
  $MOVEFILE_REPLACE_EXISTING = 0x1
  $MOVEFILE_WRITE_THROUGH = 0x8
  $flags = $MOVEFILE_REPLACE_EXISTING -bor $MOVEFILE_WRITE_THROUGH
  if (-not [JlsInstallerUpdateNative]::MoveFileEx($staged, $executable, $flags)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Windows could not replace the JLS executable (Win32 error $code)."
  }

  if (-not (Test-Path -LiteralPath $executable)) {
    throw "The replacement JLS executable does not exist after the update: $executable"
  }
  if (Test-Path -LiteralPath $staged) {
    throw "The staged JLS executable still exists after replacement: $staged"
  }

  try { Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue } catch {}
  Remove-FinalizerFile
  exit 0
} catch {
  $message = $_.Exception.Message
  Save-Failure $message
  try { Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue } catch {}
  Remove-FinalizerFile
  exit 1
}
`

function assertReplacementPaths(staged: string, executable: string): void {
  if (!existsSync(staged) || !statSync(staged).isFile()) {
    throw new Error(`staged JLS installer was not found at ${staged}`)
  }
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`JLS executable was not found at ${executable}`)
  }
  if (dirname(staged) !== dirname(executable)) {
    throw new Error('staged JLS installer must be in the same directory as the running executable')
  }
}

async function waitForBootstrap(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      if (code === 0) resolve()
      else reject(new Error(`installer-update bootstrap failed${signal ? ` (${signal})` : ` (exit ${code ?? 1})`}`))
    }
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function waitForReadySignal(readyFile: string, errorFile: string): Promise<void> {
  const directory = dirname(readyFile)
  const readyName = basename(readyFile)
  const errorName = basename(errorFile)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const watcher = watch(directory, (_event, filename) => {
      const name = filename?.toString()
      if (!name || name === readyName || name === errorName) checkSignal()
    })

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      watcher.close()
      if (error) reject(error)
      else resolve()
    }
    const checkSignal = () => {
      if (existsSync(errorFile)) {
        let detail = 'installer-update finalizer failed before it was ready'
        try {
          const saved = readFileSync(errorFile, 'utf8').trim()
          if (saved) detail = saved
        } catch {}
        return finish(new Error(detail))
      }
      if (existsSync(readyFile)) finish()
    }

    checkSignal()
  })
}

export function windowsInstallerReplacementScript(): string {
  return WINDOWS_REPLACER
}

export async function prepareInstallerReplacement(
  staged: string,
  executable: string,
  currentPlatform = platform(),
): Promise<void> {
  assertReplacementPaths(staged, executable)
  if (currentPlatform !== 'win32') {
    renameSync(staged, executable)
    if (!existsSync(executable)) throw new Error(`replacement JLS executable is missing: ${executable}`)
    if (existsSync(staged)) throw new Error(`staged JLS executable still exists after replacement: ${staged}`)
    return
  }

  const token = `${process.pid}-${randomUUID()}`
  const readyFile = join(tmpdir(), `jls-update-${token}.ready`)
  const errorFile = join(tmpdir(), `jls-update-${token}.error`)
  const finalizerFile = join(tmpdir(), `jls-update-${token}.ps1`)

  rmSync(readyFile, { force: true })
  rmSync(errorFile, { force: true })
  rmSync(finalizerFile, { force: true })
  writeFileSync(finalizerFile, WINDOWS_REPLACER, 'utf8')

  const env = {
    ...process.env,
    JLS_UPDATE_PARENT_PID: String(process.pid),
    JLS_UPDATE_STAGED: staged,
    JLS_UPDATE_EXECUTABLE: executable,
    JLS_UPDATE_READY_FILE: readyFile,
    JLS_UPDATE_ERROR_FILE: errorFile,
    JLS_UPDATE_FINALIZER_FILE: finalizerFile,
  }

  // Bun places ordinary Windows children in a kill-on-close Job Object. START /b creates
  // the breakaway PowerShell process that must survive JLS long enough to replace JLS itself.
  const bootstrap = spawn('cmd.exe', [
    '/d',
    '/c',
    'start',
    '',
    '/b',
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    finalizerFile,
  ], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env,
  })

  try {
    await waitForBootstrap(bootstrap)
    await waitForReadySignal(readyFile, errorFile)
  } catch (error) {
    let detail: string | undefined
    try {
      if (existsSync(errorFile)) detail = readFileSync(errorFile, 'utf8').trim()
    } catch {}
    rmSync(readyFile, { force: true })
    rmSync(errorFile, { force: true })
    rmSync(finalizerFile, { force: true })
    rmSync(staged, { force: true })
    throw new Error(detail || (error instanceof Error ? error.message : String(error)))
  }

  // READY means the breakaway finalizer owns a live handle to this exact process and is
  // blocked on WaitForExit(). The caller may now end the JLS session.
}
