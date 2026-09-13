import { randomUUID } from 'node:crypto'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type SelfUninstallCompletion = 'complete' | 'deferred'

const WINDOWS_FINALIZER = String.raw`
$ErrorActionPreference = 'Stop'
$parentPid = [int]$env:JLS_UNINSTALL_PARENT_PID
$executable = $env:JLS_UNINSTALL_EXECUTABLE
$dataRoot = $env:JLS_UNINSTALL_DATA_ROOT
$readyFile = $env:JLS_UNINSTALL_READY_FILE
$errorFile = $env:JLS_UNINSTALL_ERROR_FILE
$finalizerFile = $env:JLS_UNINSTALL_FINALIZER_FILE
$ready = $false
$failNode = [char]0x2716
$guide = [char]0x2502
$finalBranch = [char]0x2514

function Remove-FinalizerFile {
  try { Remove-Item -LiteralPath $finalizerFile -Force -ErrorAction SilentlyContinue } catch {}
}

function Save-Failure([string]$message) {
  try {
    [System.IO.Directory]::CreateDirectory($dataRoot) | Out-Null
    $diagnostic = [ordered]@{
      executable = $executable
      error = $message
      timestamp = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $dataRoot 'uninstall-error.json'), $diagnostic)
  } catch {}
  try { [System.IO.File]::WriteAllText($errorFile, $message) } catch {}
  if ($ready) {
    [Console]::Error.WriteLine($failNode.ToString() + '  JLS could not be fully uninstalled.')
    [Console]::Error.WriteLine($guide.ToString())
    [Console]::Error.WriteLine($finalBranch.ToString() + '  ' + $message)
  }
}

try {
  # GetProcessById opens the live parent before READY is emitted. Because the parent refuses
  # to exit before READY, the PID cannot be recycled between acquisition and the wait.
  $parent = [System.Diagnostics.Process]::GetProcessById($parentPid)
  [System.IO.File]::WriteAllText($readyFile, 'ready')
  $ready = $true

  # This is a real process-handle wait. There is intentionally no timer or polling loop.
  $parent.WaitForExit()

  try { Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue } catch {}

  Remove-Item -LiteralPath $executable -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $executable) {
    throw "The JLS executable still exists after Windows reported a successful deletion: $executable"
  }

  if (Test-Path -LiteralPath $dataRoot) {
    Remove-Item -LiteralPath $dataRoot -Recurse -Force -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $dataRoot) {
    throw "JLS installer-owned data still exists after cleanup: $dataRoot"
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

function writeDiagnostic(dataRoot: string, executable: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  try {
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(join(dataRoot, 'uninstall-error.json'), `${JSON.stringify({
      executable,
      error: message,
      timestamp: new Date().toISOString(),
    }, null, 2)}\n`)
  } catch {}
}

function assertExecutable(executable: string): void {
  if (!existsSync(executable)) throw new Error(`JLS executable was not found at ${executable}`)
  if (!statSync(executable).isFile()) throw new Error(`JLS executable path is not a file: ${executable}`)
}

export function removeInstallerSynchronously(executable: string, dataRoot: string): void {
  assertExecutable(executable)
  try {
    // POSIX permits unlinking the pathname of the running executable. The current process
    // continues from its already-open image while the filesystem entry disappears.
    rmSync(executable, { force: true })
    if (existsSync(executable)) throw new Error(`JLS executable still exists after deletion: ${executable}`)

    rmSync(dataRoot, { recursive: true, force: true })
    if (existsSync(dataRoot)) throw new Error(`JLS installer-owned data still exists after cleanup: ${dataRoot}`)
  } catch (error) {
    writeDiagnostic(dataRoot, executable, error)
    throw error
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
      else reject(new Error(`self-uninstall bootstrap failed${signal ? ` (${signal})` : ` (exit ${code ?? 1})`}`))
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
        let detail = 'self-uninstall finalizer failed before it was ready'
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

export function windowsFinalizerScript(): string {
  return WINDOWS_FINALIZER
}

export async function armWindowsSelfUninstall(executable: string, dataRoot: string): Promise<void> {
  assertExecutable(executable)
  const token = `${process.pid}-${randomUUID()}`
  const readyFile = join(tmpdir(), `jls-uninstall-${token}.ready`)
  const errorFile = join(tmpdir(), `jls-uninstall-${token}.error`)
  const finalizerFile = join(tmpdir(), `jls-uninstall-${token}.ps1`)

  rmSync(readyFile, { force: true })
  rmSync(errorFile, { force: true })
  rmSync(finalizerFile, { force: true })
  writeFileSync(finalizerFile, WINDOWS_FINALIZER, 'utf8')

  const env = {
    ...process.env,
    JLS_UNINSTALL_PARENT_PID: String(process.pid),
    JLS_UNINSTALL_EXECUTABLE: executable,
    JLS_UNINSTALL_DATA_ROOT: dataRoot,
    JLS_UNINSTALL_READY_FILE: readyFile,
    JLS_UNINSTALL_ERROR_FILE: errorFile,
    JLS_UNINSTALL_FINALIZER_FILE: finalizerFile,
  }

  // Bun's Windows child processes remain in a kill-on-close Job Object, so a directly spawned
  // finalizer is terminated when JLS exits even after unref(). cmd.exe's START creates the
  // breakaway process needed for the PowerShell finalizer to survive the Bun parent. Await the
  // bootstrap itself before trusting READY so START has completed its launch handoff.
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
    throw new Error(detail || (error instanceof Error ? error.message : String(error)))
  }

  // READY is written only after the breakaway PowerShell process has acquired a live handle to
  // this exact JLS process and entered its WaitForExit path. JLS can now terminate safely.
}

export async function prepareInstallerSelfUninstall(
  executable: string,
  dataRoot: string,
  currentPlatform = platform(),
): Promise<SelfUninstallCompletion> {
  if (currentPlatform === 'win32') {
    await armWindowsSelfUninstall(executable, dataRoot)
    return 'deferred'
  }

  removeInstallerSynchronously(executable, dataRoot)
  return 'complete'
}
