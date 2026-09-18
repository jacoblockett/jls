import * as prompts from '@clack/prompts'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { styleText } from 'node:util'
import { exclusiveMultiselect, type ExclusiveOption } from './exclusive-multiselect'
import { HARNESS_ADAPTERS, harnessAdapter, type HarnessAdapter } from './harnesses'
import { BACK_SIGNAL, navSelect, type NavOption } from './nav-prompts'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadSkillPackage,
  fetchStableReleaseManifest,
  parseSkillPackageManifest,
  stageInstallerUpdate,
  type DownloadedSkillPackage,
  type ReleaseManifest,
  type SkillPackageManifest,
} from './installer-updater'
import { prepareInstallerReplacement } from './installer-replacement'
import {
  detectGeneratedCleanup,
  removeGeneratedCleanup,
  type DetectedCleanup,
  type RawSkillManifest,
} from './generated-cleanup'
import {
  detectInstallCollisions,
  removeInstallCollisions,
  type InstallCollision,
} from './install-collision-override'
import { displayManagedPath } from './display-path'
import { missingDependenciesText, missingSkillDependencies } from './skill-dependencies'
import { prepareInstallerSelfUninstall } from './self-uninstall'
import { main as lifecycleMain } from './jls-v04-core'
import installerManifest from '../manifest.json'

const VERSION = installerManifest.version
const isWindows = platform() === 'win32'

type Scope = {
  kind: 'user' | 'project'
  origin: 'current' | 'global' | 'custom'
  identity: string
  root: string
}

type InstalledTarget = {
  skill: string
  version: string
  agent: string
  skillPath: string
  instructionPath: string
  instructions: boolean
}

type InstallGroup = {
  key: string
  skill: string
  scope: Scope
  targets: InstalledTarget[]
}

type CleanupGroup = {
  skill: string
  cleanups: DetectedCleanup[]
}

type ChoiceItem = {
  value: string
  label: string
  description?: string
  disabled?: boolean
  disabledSuffix?: string
}

type StepMemory = {
  value?: string
  values?: string[]
  cursor?: string
  text?: string
}

type WizardState = {
  shown: boolean
  steps: Map<string, StepMemory>
}

type NavResult<T> = T | typeof BACK_SIGNAL

type LifecycleAction = 'install' | 'update' | 'uninstall'

const agentCatalog: HarnessAdapter[] = HARNESS_ADAPTERS

function newWizardState(): WizardState {
  return { shown: false, steps: new Map() }
}

function memory(state: WizardState, stepId: string): StepMemory {
  let value = state.steps.get(stepId)
  if (!value) {
    value = {}
    state.steps.set(stepId, value)
  }
  return value
}

function cancel(): never {
  prompts.cancel('Cancelled & exited')
  process.exit(0)
}

function checked<T>(value: T | symbol): T | symbol {
  if (prompts.isCancel(value)) cancel()
  return value
}

function ensureIntro(state: WizardState): void {
  if (state.shown) return
  prompts.intro(`JLS Installer ${styleText('dim', `v${VERSION}`)}`)
  state.shown = true
}

async function chooseOne(
  state: WizardState,
  stepId: string,
  message: string,
  options: NavOption<string>[],
  { allowBack = true, initialValue }: { allowBack?: boolean; initialValue?: string } = {},
): Promise<NavResult<string>> {
  ensureIntro(state)
  const step = memory(state, stepId)
  const enabled = options.filter((option) => !option.disabled)
  const valid = new Set(enabled.map((option) => option.value))
  const remembered = [step.cursor, step.value, initialValue].find((value) => value !== undefined && valid.has(value))
  const result = checked(await navSelect({
    message,
    options,
    allowBack,
    initialValue: remembered,
    onCursor: (value) => { step.cursor = value },
  }))
  if (result === BACK_SIGNAL) return BACK_SIGNAL
  step.value = result as string
  step.cursor = result as string
  return result as string
}

async function chooseMany(
  state: WizardState,
  stepId: string,
  message: string,
  items: ChoiceItem[],
  {
    allowBack = true,
    initialValues = [],
    required = true,
  }: {
    allowBack?: boolean
    initialValues?: string[]
    required?: boolean
  } = {},
): Promise<NavResult<string[]>> {
  ensureIntro(state)
  const selectable = items.filter((item) => !item.disabled).map((item) => item.value)
  const step = memory(state, stepId)
  const startingValues = (step.values ?? initialValues).filter((value) => selectable.includes(value))
  const cursorAt = step.cursor && items.some((item) => item.value === step.cursor && !item.disabled)
    ? step.cursor
    : selectable[0]
  const options: ExclusiveOption<string>[] = items.map((item) => ({ ...item }))
  const result = checked(await exclusiveMultiselect({
    message,
    options,
    initialValues: startingValues,
    cursorAt,
    required,
    allowBack,
    onCursor: (value) => { step.cursor = value },
  }))
  if (result === BACK_SIGNAL) return BACK_SIGNAL
  step.values = [...(result as string[])]
  return result as string[]
}

async function chooseYesNo(
  state: WizardState,
  stepId: string,
  message: string,
  safeDefault = false,
): Promise<true | typeof BACK_SIGNAL> {
  const step = memory(state, stepId)
  step.value = undefined
  step.cursor = undefined
  const choice = await chooseOne(
    state,
    stepId,
    message,
    [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    { allowBack: true, initialValue: safeDefault ? 'no' : 'yes' },
  )
  if (choice === BACK_SIGNAL || choice === 'no') return BACK_SIGNAL
  return true
}

function rawUserHome(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

function expandPath(raw: string): string {
  let value = raw.trim()
  value = value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
  value = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
    const name = braced || plain
    return process.env[name] ?? whole
  })
  if (value === '~') return rawUserHome()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(rawUserHome(), value.slice(2))
  return value
}

function normalizedPath(path: string): string {
  const normalized = normalize(path)
  if (!isWindows) return normalized
  return normalized.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
}

function canonicalPath(raw: string): string {
  const absolute = resolve(expandPath(raw))
  if (existsSync(absolute)) {
    try {
      return normalizedPath(realpathSync.native(absolute))
    } catch {}
  }
  if (isWindows) {
    let existing = absolute
    const missing: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) break
      missing.unshift(basename(existing))
      existing = parent
    }
    if (existsSync(existing)) {
      try {
        return normalizedPath(join(realpathSync.native(existing), ...missing))
      } catch {}
    }
  }
  return normalizedPath(absolute)
}

function userHome(): string {
  return canonicalPath(rawUserHome())
}

function installerDataRoot(): string {
  if (isWindows) {
    const local = process.env.LOCALAPPDATA || join(userHome(), 'AppData', 'Local')
    return canonicalPath(join(local, 'JLS'))
  }
  const data = process.env.XDG_DATA_HOME || join(userHome(), '.local', 'share')
  return canonicalPath(join(data, 'JLS'))
}

function cachedManifestPath(name: string): string {
  return join(installerDataRoot(), 'skill-manifests', `${name}.json`)
}

function resolveScope(raw: 'cwd' | 'user'): Scope {
  if (raw === 'user') return { kind: 'user', origin: 'global', identity: 'user', root: userHome() }
  const root = canonicalPath(process.cwd())
  return { kind: 'project', origin: 'current', identity: root, root }
}

export function validateCustomPath(value: string | undefined): string | undefined {
  if (!value?.trim()) return 'Please provide a path.'
  const root = canonicalPath(value)
  if (!existsSync(root)) return 'That path does not exist.'
  if (!statSync(root).isDirectory()) return 'That path is not a directory.'
  return undefined
}

async function customScope(state: WizardState, stepId: string): Promise<NavResult<Scope>> {
  const step = memory(state, stepId)
  const raw = checked(await prompts.path({
    message: 'Select a custom path.',
    root: process.cwd(),
    directory: true,
    initialValue: step.text ?? process.cwd(),
    validate: validateCustomPath,
  }))
  const root = canonicalPath(raw as string)
  step.text = root
  return { kind: 'project', origin: 'custom', identity: root, root }
}

function scopeArg(scope: Scope): string {
  if (scope.origin === 'current') return 'cwd'
  if (scope.origin === 'global') return 'user'
  return scope.root
}

function commandExists(command: string): boolean {
  return spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true }).status === 0
}

function detectedAgents(): HarnessAdapter[] {
  return agentCatalog.filter((agent) => (
    commandExists(agent.command) || agent.detectionPaths(userHome()).some(existsSync)
  ))
}

function agentLabel(id: string): string {
  return agentCatalog.find((agent) => agent.id === id)?.label ?? id
}

function agentPaths(agent: string, scope: Scope) {
  return harnessAdapter(agent).paths(scope, userHome())
}

function installedPackageManifest(path: string): SkillPackageManifest | undefined {
  const manifestPath = join(path, 'manifest.json')
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) return undefined
  try {
    return parseSkillPackageManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch {
    return undefined
  }
}

function skillFilesPresent(skillPath: string, manifest: SkillPackageManifest): boolean {
  return manifest.skill_files.every((rel) => {
    const path = join(skillPath, rel)
    return existsSync(path) && statSync(path).isFile()
  })
}

function harnessResourcesPresent(manifest: SkillPackageManifest, agent: string, scope: Scope): boolean {
  const declared = manifest.harness_resources?.[agent] ?? {}
  const roots = agentPaths(agent, scope).resources
  for (const [kind, files] of Object.entries(declared)) {
    const root = roots[kind]
    if (!root) return false
    for (const source of files) {
      const destination = join(root, basename(source))
      if (!existsSync(destination) || !statSync(destination).isFile()) return false
    }
  }
  return true
}

function discoverInstallations(scope: Scope): InstallGroup[] {
  const groups = new Map<string, InstallGroup>()
  for (const agent of agentCatalog) {
    const paths = agentPaths(agent.id, scope)
    if (!existsSync(paths.skillRoot) || !statSync(paths.skillRoot).isDirectory()) continue
    for (const entry of readdirSync(paths.skillRoot).sort()) {
      const skillPath = join(paths.skillRoot, entry)
      if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) continue
      const manifest = installedPackageManifest(skillPath)
      if (!manifest || manifest.name !== entry) continue
      const key = `${manifest.name}\u0000${scope.identity}`
      const group = groups.get(key) ?? { key, skill: manifest.name, scope, targets: [] }
      group.targets.push({
        skill: manifest.name,
        version: manifest.version,
        agent: agent.id,
        skillPath,
        instructionPath: paths.instruction,
        instructions: managedBlockPresent(paths.instruction, manifest.name),
      })
      groups.set(key, group)
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, targets: group.targets.sort((a, b) => a.agent.localeCompare(b.agent)) }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function managedBlockPresent(path: string, skill: string): boolean {
  if (!existsSync(path) || !statSync(path).isFile()) return false
  const current = readFileSync(path, 'utf8')
  return current.includes(`<!-- jls:begin ${skill} -->`) && current.includes(`<!-- jls:end ${skill} -->`)
}

function targetInstalled(scope: Scope, skill: string, agent: string): boolean {
  const paths = agentPaths(agent, scope)
  const skillPath = join(paths.skillRoot, skill)
  const manifest = installedPackageManifest(skillPath)
  if (!manifest || manifest.name !== skill) return false
  return skillFilesPresent(skillPath, manifest) && harnessResourcesPresent(manifest, agent, scope)
}

function displaySkillName(name: string): string {
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : name
}

function humanList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

async function fetchRelease(state: WizardState, message: string): Promise<ReleaseManifest> {
  ensureIntro(state)
  const spinner = prompts.spinner({ withGuide: false })
  spinner.start(message)
  try {
    const release = await fetchStableReleaseManifest()
    if (!release) throw new Error('no stable JLS release is currently available')
    return release
  } finally {
    spinner.clear()
  }
}

async function acknowledgeMissingDependencies(
  state: WizardState,
  stepId: string,
  release: ReleaseManifest,
  skills: string[],
  scope: Scope,
): Promise<true | typeof BACK_SIGNAL> {
  const missing = missingSkillDependencies(skills, release.skills, scope.root)
  if (missing.length === 0) return true
  prompts.note(missingDependenciesText(missing), 'Missing dependencies')
  return chooseYesNo(state, stepId, 'Continue?')
}

function instructionFiles(agents: string[], scope: Scope): string[] {
  return [...new Set(agents.map((agent) => basename(agentPaths(agent, scope).instruction)))]
}

function instructionTarget(agents: string[], scope: Scope): { names: string; noun: string } {
  const files = instructionFiles(agents, scope)
  return {
    names: files.length === 2 ? files.join('/') : humanList(files),
    noun: files.length === 1 ? 'file' : 'files',
  }
}

function instructionExplanation(agents: string[], scope: Scope): string {
  const sentences = agents.map((agent) => `${agentLabel(agent)} uses ${basename(agentPaths(agent, scope).instruction)}.`)
  return `AI tools can use instruction files to receive extra directions about how they should work in a project. ${sentences.join(' ')} JLS can add instructions for a skill to the appropriate file without replacing unrelated instructions that are already there.`
}

function instructionQuestion(agents: string[], scope: Scope): string {
  const { names, noun } = instructionTarget(agents, scope)
  return `The following skills have instructions to inject into your ${names} ${noun}. Deselect any of these you wish not to be injected. See above for more information.`
}

function singleInstructionQuestion(skill: string, agents: string[], scope: Scope): string {
  const { names, noun } = instructionTarget(agents, scope)
  return `The ${displaySkillName(skill)} skill has instructions to inject into your ${names} ${noun}. Would you like them to be injected? See above for more information.`
}

function noteBullet(text: string, indent = ''): string {
  return `${indent}${styleText('dim', '•')} ${text}`
}

function summaryPath(scope: Scope): string {
  return styleText('dim', displayManagedPath(scope.root, scope.root))
}

function installSummary(scope: Scope, skills: string[]): string {
  return [
    summaryPath(scope),
    '',
    ...skills.map((skill) => noteBullet(displaySkillName(skill))),
  ].join('\n')
}

function updateSummary(scope: Scope, groups: InstallGroup[], available: Record<string, string>): string {
  return [
    summaryPath(scope),
    '',
    ...groups.map((group) => noteBullet(`${displaySkillName(group.skill)} (${updateStatus(group, available)})`)),
  ].join('\n')
}

function uninstallSummary(
  scope: Scope,
  groups: InstallGroup[],
  removeData: Set<string>,
): string {
  const showGeneratedDetail = removeData.size > 0
  return [
    summaryPath(scope),
    '',
    ...groups.map((group) => {
      const name = displaySkillName(group.skill)
      if (!showGeneratedDetail) return noteBullet(name)
      const detail = removeData.has(group.skill) ? 'installed files, generated data' : 'installed files'
      return noteBullet(`${name} (${detail})`)
    }),
  ].join('\n')
}

function collisionSummary(scope: Scope, collisions: InstallCollision[]): string {
  return [
    'The following existing paths conflict with files JLS needs to write. Continuing will remove or overwrite those exact paths and could cause permanent loss of data.',
    '',
    ...collisions.map((collision) => noteBullet(displayManagedPath(scope.root, collision.path))),
  ].join('\n')
}

function installedVersions(group: InstallGroup): string[] {
  return [...new Set(group.targets.map((target) => target.version))].sort()
}

function updateAvailable(group: InstallGroup, available: Record<string, string>): boolean {
  const version = available[group.skill]
  if (!version) return false
  return installedVersions(group).some((installed) => {
    try {
      return compareVersions(installed, version) < 0
    } catch {
      return false
    }
  })
}

function updateStatus(group: InstallGroup, available: Record<string, string>): string {
  const version = available[group.skill]
  if (!version) throw new Error(`stable release does not contain ${group.skill}`)
  const stale = installedVersions(group).filter((installed) => {
    try {
      return compareVersions(installed, version) < 0
    } catch {
      return false
    }
  })
  return `${stale.join(' / ')} -> ${version}`
}

function rawManifest(path: string): RawSkillManifest | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RawSkillManifest
    return parsed && typeof parsed.name === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function rawManifestForGroup(group: InstallGroup): RawSkillManifest | undefined {
  for (const target of group.targets) {
    const manifest = rawManifest(join(target.skillPath, 'manifest.json'))
    if (manifest?.name === group.skill) return manifest
  }
  const cached = rawManifest(cachedManifestPath(group.skill))
  return cached?.name === group.skill ? cached : undefined
}

function cleanupGroupsFor(scope: Scope, groups: InstallGroup[]): CleanupGroup[] {
  const result: CleanupGroup[] = []
  for (const group of groups) {
    const manifest = rawManifestForGroup(group)
    if (!manifest) continue
    const cleanups = detectGeneratedCleanup(scope.root, manifest)
    if (cleanups.length === 0) continue
    result.push({ skill: group.skill, cleanups })
  }
  return result
}

function lifecycleArgs(scope: Scope, agents: string[]): string[] {
  return ['--scope', scopeArg(scope), ...agents.flatMap((agent) => ['--agent', agent])]
}

async function runLifecycle(args: string[]): Promise<void> {
  if (!Bun.isStandaloneExecutable) throw new Error('interactive lifecycle execution requires the compiled JLS installer')
  const child = spawn(process.execPath, ['--core', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })

  await new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const detail = (stderr || stdout).trim()
      reject(new Error(detail || `installer operation failed${signal ? ` (${signal})` : ` with exit code ${code ?? 1}`}`))
    })
  })
}

async function runLifecycleItem(
  action: LifecycleAction,
  skill: string,
  args: string[],
  before?: () => void,
): Promise<boolean> {
  const name = displaySkillName(skill)
  const words = action === 'install'
    ? { progress: 'Installing', success: 'Installed', verb: 'install' }
    : action === 'update'
      ? { progress: 'Updating', success: 'Updated', verb: 'update' }
      : { progress: 'Uninstalling', success: 'Uninstalled', verb: 'uninstall' }
  const spinner = prompts.spinner({ withGuide: false })
  spinner.start(`${words.progress} ${name}`)
  try {
    before?.()
    await runLifecycle(args)
    spinner.clear()
    prompts.log.info(`${words.success} ${name}`)
    return true
  } catch (error) {
    spinner.clear()
    const detail = error instanceof Error ? error.message.trim() : String(error).trim()
    prompts.log.error(`Failed to ${words.verb} ${name}${detail ? `: ${detail}` : '.'}`)
    return false
  }
}

async function installAtScope(
  scope: Scope,
  state: WizardState,
  prefix: string,
  noSkillsDetected = false,
): Promise<NavResult<number>> {
  const detected = detectedAgents()
  if (detected.length === 0) {
    prompts.log.warn('No supported AI harnesses were detected.')
    return BACK_SIGNAL
  }
  const release = await fetchRelease(state, 'Checking available skills')

  skillStep:
  while (true) {
    const skillItems: ChoiceItem[] = Object.keys(release.skills).sort().map((skill) => {
      const installedEverywhere = detected.every((agent) => targetInstalled(scope, skill, agent.id))
      return {
        value: skill,
        label: displaySkillName(skill),
        description: release.skills[skill]?.description,
        disabled: installedEverywhere,
        disabledSuffix: installedEverywhere ? ' (installed)' : undefined,
      }
    })
    const selectableSkills = skillItems.filter((item) => !item.disabled)
    if (skillItems.length === 0) {
      prompts.log.warn(
        Object.keys(release.incompatibleSkills).length > 0
          ? 'No skills compatible with this JLS installer are currently available.'
          : 'No skills are currently available to install.',
      )
      return BACK_SIGNAL
    }
    if (selectableSkills.length === 0) {
      prompts.log.warn('All compatible skills are already installed.')
      return BACK_SIGNAL
    }

    const selectedSkills = await chooseMany(
      state,
      `${prefix}.skills`,
      noSkillsDetected ? 'No skills detected. Which skills would you like to install?' : 'Which skills would you like to install?',
      skillItems,
      { allowBack: true, initialValues: [] },
    )
    if (selectedSkills === BACK_SIGNAL) return BACK_SIGNAL

    harnessStep:
    while (true) {
      const harnessItems: ChoiceItem[] = detected.map((agent) => {
        const alreadyInstalled = selectedSkills.every((skill) => targetInstalled(scope, skill, agent.id))
        return {
          value: agent.id,
          label: agent.label,
          disabled: alreadyInstalled,
          disabledSuffix: alreadyInstalled ? ' (already installed)' : undefined,
        }
      })
      const enabledHarnesses = harnessItems.filter((item) => !item.disabled).map((item) => item.value)
      if (enabledHarnesses.length === 0) continue skillStep

      const harnessWasPrompted = detected.length > 1
      let selectedAgents: string[]
      if (harnessWasPrompted) {
        const selected = await chooseMany(
          state,
          `${prefix}.harnesses`,
          "For which of the following AI harnesses would you like to install your selected skills? If you don't see your desired harness here, it is either undetected or unsupported.",
          harnessItems,
          { allowBack: true, initialValues: enabledHarnesses },
        )
        if (selected === BACK_SIGNAL) continue skillStep
        selectedAgents = selected
      } else {
        selectedAgents = enabledHarnesses
      }

      const dependenciesAccepted = await acknowledgeMissingDependencies(
        state,
        `${prefix}.dependencies`,
        release,
        selectedSkills,
        scope,
      )
      if (dependenciesAccepted === BACK_SIGNAL) {
        if (harnessWasPrompted) continue harnessStep
        continue skillStep
      }

      const packages = new Map<string, DownloadedSkillPackage>()
      const spinner = prompts.spinner({ withGuide: false })
      spinner.start('Preparing selected skills')
      try {
        for (const skill of selectedSkills) packages.set(skill, await downloadSkillPackage(skill, release.skills[skill]))
      } finally {
        spinner.clear()
      }

      try {
        const capable = selectedSkills.filter((skill) => !!packages.get(skill)?.manifest.instruction_fragment)

        instructionStep:
        while (true) {
          let injectedSkills: string[] = []
          if (capable.length > 0) {
            prompts.note(instructionExplanation(selectedAgents, scope), 'About AI Instruction Files')
            if (capable.length === 1) {
              const skill = capable[0]
              const selected = await chooseOne(
                state,
                `${prefix}.instructions.single`,
                singleInstructionQuestion(skill, selectedAgents, scope),
                [
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ],
                { allowBack: true, initialValue: 'yes' },
              )
              if (selected === BACK_SIGNAL) {
                if (harnessWasPrompted) continue harnessStep
                continue skillStep
              }
              if (selected === 'yes') injectedSkills = [skill]
            } else {
              const selected = await chooseMany(
                state,
                `${prefix}.instructions`,
                instructionQuestion(selectedAgents, scope),
                capable.map((skill) => ({
                  value: skill,
                  label: displaySkillName(skill),
                  description: release.skills[skill]?.description,
                })),
                { allowBack: true, required: false, initialValues: capable },
              )
              if (selected === BACK_SIGNAL) {
                if (harnessWasPrompted) continue harnessStep
                continue skillStep
              }
              injectedSkills = selected
            }
          }

          prompts.note(installSummary(scope, selectedSkills), 'The following skills will be installed:')
          const proceed = await chooseYesNo(state, `${prefix}.confirm`, 'Continue?')
          if (proceed === BACK_SIGNAL) {
            if (capable.length > 0) continue instructionStep
            if (harnessWasPrompted) continue harnessStep
            continue skillStep
          }

          const collisionMap = new Map<string, InstallCollision>()
          for (const skill of selectedSkills) {
            const pkg = packages.get(skill)
            if (!pkg) continue
            for (const collision of detectInstallCollisions(pkg, scope, selectedAgents)) {
              collisionMap.set(normalizedPath(collision.path), collision)
            }
          }
          const collisions = [...collisionMap.values()]
          if (collisions.length > 0) {
            prompts.note(collisionSummary(scope, collisions), 'Collisions detected')
            const destructiveProceed = await chooseYesNo(
              state,
              `${prefix}.collision-confirm`,
              'Would you like to continue and remove or overwrite these colliding paths?',
              true,
            )
            if (destructiveProceed === BACK_SIGNAL) continue instructionStep
            removeInstallCollisions(collisions)
          }

          for (const skill of selectedSkills) {
            const success = await runLifecycleItem('install', skill, [
              skill,
              ...lifecycleArgs(scope, selectedAgents),
              injectedSkills.includes(skill) ? '--instructions' : '--no-instructions',
            ])
            if (!success) return 1
          }
          prompts.log.success('Done.')
          return 0
        }
      } finally {
        for (const pkg of packages.values()) pkg.cleanup()
      }
    }
  }
}

async function updateAtScope(scope: Scope, state: WizardState, prefix: string): Promise<NavResult<number>> {
  const release = await fetchRelease(state, 'Checking for updates')
  const availableVersions = Object.fromEntries(
    Object.entries(release.skills).map(([name, skill]) => [name, skill.version]),
  )
  const installed = discoverInstallations(scope)
  const available = installed.filter((group) => updateAvailable(group, availableVersions))
  if (available.length === 0) {
    prompts.log.info('No compatible updates were found.')
    return BACK_SIGNAL
  }

  const applyUpdates = async (
    groups: InstallGroup[],
    confirmationStep: string,
    confirmationMessage = 'Continue?',
  ): Promise<NavResult<number>> => {
    const dependenciesAccepted = await acknowledgeMissingDependencies(
      state,
      `${confirmationStep}.dependencies`,
      release,
      groups.map((group) => group.skill),
      scope,
    )
    if (dependenciesAccepted === BACK_SIGNAL) return BACK_SIGNAL

    const targets = groups.map((group) => {
      const version = availableVersions[group.skill]
      if (!version) throw new Error(`stable release does not contain ${group.skill}`)
      return {
        group,
        agents: group.targets
          .filter((target) => {
            try {
              return compareVersions(target.version, version) < 0
            } catch {
              return false
            }
          })
          .map((target) => target.agent),
      }
    }).filter((target) => target.agents.length > 0)

    const packages = new Map<string, Awaited<ReturnType<typeof import('./installer-updater')['downloadSkillPackage']>>>()
    const spinner = prompts.spinner({ withGuide: false })
    spinner.start('Preparing selected updates')
    try {
      for (const { group } of targets) {
        packages.set(group.skill, await downloadSkillPackage(group.skill, release.skills[group.skill]))
      }
    } catch (error) {
      for (const pkg of packages.values()) pkg.cleanup()
      throw error
    } finally {
      spinner.clear()
    }

    try {
      prompts.note(updateSummary(scope, groups, availableVersions), 'The following skills will be updated:')
      const proceed = await chooseYesNo(state, confirmationStep, confirmationMessage)
      if (proceed === BACK_SIGNAL) return BACK_SIGNAL

      const collisionMap = new Map<string, InstallCollision>()
      for (const { group, agents } of targets) {
        const pkg = packages.get(group.skill)
        if (!pkg) continue
        for (const collision of detectInstallCollisions(pkg, scope, agents)) {
          collisionMap.set(normalizedPath(collision.path), collision)
        }
      }
      const collisions = [...collisionMap.values()]
      if (collisions.length > 0) {
        prompts.note(collisionSummary(scope, collisions), 'Collisions detected')
        const destructiveProceed = await chooseYesNo(
          state,
          `${confirmationStep}.collision-confirm`,
          'Would you like to continue and remove or overwrite these colliding paths?',
          true,
        )
        if (destructiveProceed === BACK_SIGNAL) return BACK_SIGNAL
        removeInstallCollisions(collisions)
      }

      for (const { group, agents } of targets) {
        const success = await runLifecycleItem('update', group.skill, [
          'update',
          group.skill,
          ...lifecycleArgs(scope, agents),
        ])
        if (!success) return 1
      }
      prompts.log.success('Done.')
      return 0
    } finally {
      for (const pkg of packages.values()) pkg.cleanup()
    }
  }

  if (available.length === 1) {
    const group = available[0]
    return applyUpdates(
      [group],
      `${prefix}.single-confirm`,
      `Would you like to update the ${displaySkillName(group.skill)} skill (${updateStatus(group, availableVersions)})?`,
    )
  }

  selectionStep:
  while (true) {
    const width = Math.max(...available.map((group) => displaySkillName(group.skill).length))
    const selected = await chooseMany(
      state,
      `${prefix}.skills`,
      'The following updates are available. Please select which you would like to update.',
      available.map((group) => ({
        value: group.skill,
        label: `${displaySkillName(group.skill).padEnd(width)}  ${updateStatus(group, availableVersions)}`,
      })),
      { allowBack: true, initialValues: [] },
    )
    if (selected === BACK_SIGNAL) return BACK_SIGNAL
    const groups = available.filter((group) => selected.includes(group.skill))

    const result = await applyUpdates(groups, `${prefix}.confirm`)
    if (result === BACK_SIGNAL) continue selectionStep
    return result
  }
}
async function uninstallAtScope(scope: Scope, state: WizardState, prefix: string): Promise<NavResult<number>> {
  const available = discoverInstallations(scope)
  if (available.length === 0) {
    prompts.log.warn('No installed skills were found.')
    return BACK_SIGNAL
  }

  skillStep:
  while (true) {
    let groups: InstallGroup[]
    if (available.length === 1) {
      const group = available[0]
      const selected = await chooseYesNo(
        state,
        `${prefix}.single-confirm`,
        `Would you like to uninstall the ${displaySkillName(group.skill)} skill?`,
        true,
      )
      if (selected === BACK_SIGNAL) return BACK_SIGNAL
      groups = [group]
    } else {
      const selected = await chooseMany(
        state,
        `${prefix}.skills`,
        'Which skills would you like to uninstall?',
        available.map((group) => ({ value: group.skill, label: displaySkillName(group.skill) })),
        { allowBack: true, initialValues: [] },
      )
      if (selected === BACK_SIGNAL) return BACK_SIGNAL
      groups = available.filter((group) => selected.includes(group.skill))
    }

    const cleanupGroups = cleanupGroupsFor(scope, groups)

    cleanupStep:
    while (true) {
      let removeData = new Set<string>()
      if (cleanupGroups.length === 1) {
        const cleanupGroup = cleanupGroups[0]
        const dataSelection = await chooseOne(
          state,
          `${prefix}.generated-data.single`,
          `The ${displaySkillName(cleanupGroup.skill)} skill has generated data separate from any skill or agent files that were installed. Would you like to also remove this data?`,
          [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
          { allowBack: true, initialValue: 'yes' },
        )
        if (dataSelection === BACK_SIGNAL) continue skillStep
        if (dataSelection === 'yes') removeData.add(cleanupGroup.skill)
      } else if (cleanupGroups.length > 1) {
        const dataSelection = await chooseMany(
          state,
          `${prefix}.generated-data`,
          'The following skills have generated data separate from any skill or agent files that were installed. Select which, if any, of this data you would also like to remove.',
          cleanupGroups.map((group) => ({
            value: group.skill,
            label: displaySkillName(group.skill),
          })),
          { allowBack: true, required: false, initialValues: cleanupGroups.map((group) => group.skill) },
        )
        if (dataSelection === BACK_SIGNAL) continue skillStep
        removeData = new Set(dataSelection)
      }

      prompts.note(uninstallSummary(scope, groups, removeData), 'The following skills will be uninstalled:')
      const proceed = await chooseYesNo(state, `${prefix}.confirm`, 'Continue?', true)
      if (proceed === BACK_SIGNAL) {
        if (cleanupGroups.length > 0) continue cleanupStep
        continue skillStep
      }

      for (const group of groups) {
        const cleanupGroup = cleanupGroups.find((candidate) => candidate.skill === group.skill)
        const before = cleanupGroup && removeData.has(group.skill)
          ? () => {
              for (const cleanup of cleanupGroup.cleanups) removeGeneratedCleanup(scope.root, cleanup)
            }
          : undefined
        const success = await runLifecycleItem(
          'uninstall',
          group.skill,
          ['uninstall', group.skill, '--scope', scopeArg(scope)],
          before,
        )
        if (!success) return 1
      }
      prompts.log.success('Done.')
      return 0
    }
  }
}

async function manageScopeWizard(scope: Scope, state: WizardState): Promise<NavResult<number>> {
  const prefix = `manage.${scope.origin}:${scope.identity}`
  while (true) {
    const hasInstalled = discoverInstallations(scope).length > 0
    if (!hasInstalled) {
      const result = await installAtScope(scope, state, `${prefix}.install`, true)
      if (result === BACK_SIGNAL) return BACK_SIGNAL
      return result
    }

    const choice = await chooseOne(
      state,
      `${prefix}.action`,
      'What would you like to do?',
      [
        { value: 'install', label: 'Install new skills' },
        { value: 'update', label: 'Check for updates' },
        { value: 'uninstall', label: 'Uninstall existing skills' },
      ],
      { allowBack: true, initialValue: 'install' },
    )
    if (choice === BACK_SIGNAL) return BACK_SIGNAL

    if (choice === 'install') {
      const result = await installAtScope(scope, state, `${prefix}.install`)
      if (result === BACK_SIGNAL) continue
      return result
    }
    if (choice === 'update') {
      const result = await updateAtScope(scope, state, `${prefix}.update`)
      if (result === BACK_SIGNAL) continue
      return result
    }
    const result = await uninstallAtScope(scope, state, `${prefix}.uninstall`)
    if (result === BACK_SIGNAL) continue
    return result
  }
}

function installerExecutable(): string {
  if (!Bun.isStandaloneExecutable) throw new Error('installer management is only available from the compiled JLS executable')
  return canonicalPath(process.execPath)
}

async function updateInstallerWizard(state: WizardState): Promise<NavResult<number>> {
  ensureIntro(state)
  const executable = installerExecutable()
  const spinner = prompts.spinner({ withGuide: false })
  spinner.start('Checking for updates')
  let update
  try {
    update = await checkInstallerUpdate(VERSION)
  } finally {
    spinner.clear()
  }
  if (!update) {
    prompts.log.info('No updates were found.')
    return BACK_SIGNAL
  }
  prompts.note(`An update from v${VERSION} to v${update.version} is available. Updating will end the current session, and you must relaunch the installer afterward.`)
  const proceed = await chooseYesNo(
    state,
    'installer-update.confirm',
    `Would you like to update JLS to v${update.version}?`,
  )
  if (proceed === BACK_SIGNAL) return BACK_SIGNAL
  const staged = await stageInstallerUpdate(executable, update)
  await prepareInstallerReplacement(staged, executable)
  return 0
}

async function uninstallInstallerWizard(state: WizardState): Promise<NavResult<number>> {
  ensureIntro(state)
  const executable = installerExecutable()
  prompts.note('This will uninstall the current installer binary file from the location you launched it from and remove installer-owned metadata and tooling. Doing so will immediately end the current session. It will not, however, remove or uninstall any currently installed skills, agent files, agent instruction injections, skill runtimes, or generated data from skills.')
  const proceed = await chooseYesNo(state, 'installer-uninstall.confirm', 'Continue?', true)
  if (proceed === BACK_SIGNAL) return BACK_SIGNAL

  const spinner = prompts.spinner({ withGuide: false })
  spinner.start('Uninstalling JLS')
  try {
    await prepareInstallerSelfUninstall(executable, installerDataRoot())
  } finally {
    spinner.clear()
  }
  return 0
}

async function manageInstallerWizard(state: WizardState): Promise<NavResult<number>> {
  while (true) {
    const choice = await chooseOne(
      state,
      'installer.action',
      'What would you like to do?',
      [
        { value: 'update', label: 'Check for updates' },
        { value: 'uninstall', label: 'Uninstall this installer' },
      ],
      { allowBack: true, initialValue: 'update' },
    )
    if (choice === BACK_SIGNAL) return BACK_SIGNAL
    if (choice === 'update') {
      const result = await updateInstallerWizard(state)
      if (result === BACK_SIGNAL) continue
      return result
    }
    const result = await uninstallInstallerWizard(state)
    if (result === BACK_SIGNAL) continue
    return result
  }
}

async function bareWizard(): Promise<number> {
  if (!process.stdin.isTTY) throw new Error('no command supplied')
  const state = newWizardState()
  ensureIntro(state)

  while (true) {
    const choice = await chooseOne(
      state,
      'home.action',
      'What would you like to do?',
      [
        { value: 'current', label: 'Manage skills on the current path' },
        { value: 'global', label: 'Manage skills on the global path' },
        { value: 'custom', label: 'Manage skills on a custom path' },
        { value: 'installer', label: 'Manage installer' },
      ],
      { allowBack: false, initialValue: 'current' },
    )

    if (choice === 'installer') {
      const result = await manageInstallerWizard(state)
      if (result === BACK_SIGNAL) continue
      return result
    }

    let scope: Scope
    if (choice === 'current') scope = resolveScope('cwd')
    else if (choice === 'global') scope = resolveScope('user')
    else {
      const custom = await customScope(state, 'home.custom')
      if (custom === BACK_SIGNAL) continue
      scope = custom
    }

    const result = await manageScopeWizard(scope, state)
    if (result === BACK_SIGNAL) continue
    return result
  }
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args[0] === '--core') {
    process.argv.splice(2, 1)
    return lifecycleMain()
  }
  if (args.length > 0) return lifecycleMain()
  return bareWizard()
}

