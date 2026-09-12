import * as prompts from '@clack/prompts'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { styleText } from 'node:util'
import { exclusiveMultiselect, type ExclusiveOption } from './exclusive-multiselect'
import {
  HARNESS_ADAPTERS,
  harnessAdapter,
  normalizeHarnessId,
  type HarnessAdapter,
  type HarnessPaths,
} from './harnesses'
import { classifyInstallTargets, type InstallTargetState } from './install-preflight'
import { BACK_SIGNAL, navSelect, navText, type NavOption } from './nav-prompts'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadSkillPackage,
  fetchStableReleaseManifest,
  parseSkillPackageManifest,
  scheduleInstallerReplacement,
  stageInstallerUpdate,
  type DownloadedSkillPackage,
  type ReleaseManifest,
  type SkillPackageManifest,
} from './installer-updater'
import {
  detectGeneratedCleanup,
  removeGeneratedCleanup,
  type DetectedCleanup,
  type RawSkillManifest,
} from './generated-cleanup'
import { renderResource } from './resource-render'
import { compiledTarget } from './targets'
import installerManifest from '../manifest.json'

const VERSION = installerManifest.version
const PROMPTS_VERSION = '1.7.0'
const isWindows = platform() === 'win32'
const HOME = Symbol('jls-home')
const NO_UPDATES = Symbol('jls-no-updates')

type Manifest = SkillPackageManifest

type Scope = {
  kind: 'user' | 'project'
  origin: 'current' | 'global' | 'custom'
  identity: string
  root: string
}

type AgentSpec = HarnessAdapter
type AgentInfo = AgentSpec & { detected: boolean }
type ParsedAction = { skills: string[]; scope?: string; agents: string[]; instructions?: boolean }
type ChoiceItem = { value: string; label: string; disabled?: boolean; disabledSuffix?: string }
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
  description: string
  cleanups: DetectedCleanup[]
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
type InstallResult = NavResult<number> | typeof HOME
type UpdateResult = NavResult<number> | typeof HOME | typeof NO_UPDATES
type InstallTarget = { agent: string; instructions: boolean }
type HarnessResourceTarget = { source: string; destination: string }

const agentCatalog: AgentSpec[] = HARNESS_ADAPTERS

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
  if (!state.shown) {
    prompts.intro(`JLS Installer ${styleText('dim', `v${VERSION}`)}`)
    state.shown = true
  }
}

async function chooseOne(
  state: WizardState,
  stepId: string,
  message: string,
  options: NavOption<string>[],
  {
    allowBack = true,
    initialValue,
  }: { allowBack?: boolean; initialValue?: string } = {},
): Promise<NavResult<string>> {
  ensureIntro(state)
  const step = memory(state, stepId)
  const valid = new Set(options.filter((option) => !option.disabled).map((option) => option.value))
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
  const selected = checked(await exclusiveMultiselect({
    message,
    options,
    initialValues: startingValues,
    cursorAt,
    required,
    allowBack,
    onCursor: (value) => { step.cursor = value },
  }))
  if (selected === BACK_SIGNAL) return BACK_SIGNAL
  step.values = [...(selected as string[])]
  return selected as string[]
}

async function chooseConfirmation(
  state: WizardState,
  stepId: string,
  safeDefault = false,
): Promise<NavResult<boolean>> {
  const step = memory(state, stepId)
  step.value = undefined
  step.cursor = undefined
  const choice = await chooseOne(
    state,
    stepId,
    'Continue?',
    [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    { allowBack: true, initialValue: safeDefault ? 'no' : 'yes' },
  )
  if (choice === BACK_SIGNAL) return BACK_SIGNAL
  return choice === 'yes'
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

function skillMetadataRoot(): string {
  return join(installerDataRoot(), 'skill-manifests')
}

function scopeSkillRoot(scope: Scope, skill: string): string {
  return join(scope.root, '.jls', skill)
}

function resolveScope(raw: string): Scope {
  const value = raw.trim()
  if (value === 'user') return { kind: 'user', origin: 'global', identity: 'user', root: userHome() }
  if (value === 'cwd') {
    const root = canonicalPath(process.cwd())
    return { kind: 'project', origin: 'current', identity: root, root }
  }
  if (!value) throw new Error('empty scope')
  const root = canonicalPath(value)
  if (existsSync(root) && !statSync(root).isDirectory()) throw new Error(`scope path is not a directory: ${root}`)
  return { kind: 'project', origin: 'custom', identity: root, root }
}

async function customScope(state: WizardState, stepId: string): Promise<NavResult<Scope>> {
  const step = memory(state, stepId)
  const rawPath = checked(await navText({
    message: 'Enter a custom path.',
    placeholder: process.cwd(),
    initialValue: step.text,
    allowBack: true,
    validate: (value: string | undefined) => value?.trim() ? undefined : 'Please provide a path.',
    onInput: (value) => { step.text = value },
  }))
  if (rawPath === BACK_SIGNAL) return BACK_SIGNAL
  const path = (rawPath as string).trim()
  step.text = path
  return resolveScope(path)
}

async function chooseScope(
  state: WizardState,
  stepId: string,
  message: string,
  allowBack = true,
): Promise<NavResult<Scope>> {
  while (true) {
    const choice = await chooseOne(
      state,
      stepId,
      message,
      [
        { value: 'cwd', label: 'Current directory' },
        { value: 'user', label: 'User account' },
        { value: 'custom', label: 'Custom path' },
      ],
      { allowBack, initialValue: 'cwd' },
    )
    if (choice === BACK_SIGNAL) return BACK_SIGNAL
    if (choice !== 'custom') return resolveScope(choice)
    const scope = await customScope(state, `${stepId}.custom`)
    if (scope === BACK_SIGNAL) continue
    return scope
  }
}

function scopePhrase(scope: Scope): string {
  if (scope.origin === 'current') return 'on your current path'
  if (scope.origin === 'global') return 'on the global path'
  return `at ${scope.root}`
}

function commandExists(command: string): boolean {
  return spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true }).status === 0
}

function normalizeAgents(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeHarnessId))].sort()
}

function harnessDetected(spec: AgentSpec): boolean {
  if (commandExists(spec.command)) return true
  return spec.detectionPaths(userHome()).some(existsSync)
}

function detectedAgents(): AgentInfo[] {
  return agentCatalog.map((agent) => ({ ...agent, detected: harnessDetected(agent) }))
}

function agentLabel(id: string, agents: AgentSpec[] = agentCatalog): string {
  return agents.find((item) => item.id === id)?.label ?? id
}

function agentPaths(agent: string, scope: Scope): HarnessPaths {
  return harnessAdapter(agent).paths(scope, userHome())
}

function atomicWrite(path: string, data: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.jls-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    writeFileSync(tmp, data)
    try { chmodSync(tmp, mode) } catch {}
    if (isWindows && existsSync(path)) rmSync(path, { force: true })
    renameSync(tmp, path)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    throw error
  }
}

function render(text: string, tokens: Record<string, string>): string {
  let result = text
  for (const [from, to] of Object.entries(tokens)) result = result.replaceAll(from, to)
  return result
}

function copyPackageEntry(source: string, destination: string, tokens?: Record<string, string>): void {
  if (!existsSync(source)) throw new Error(`missing package asset ${source}`)
  if (statSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source)) copyPackageEntry(join(source, entry), join(destination, entry), tokens)
    return
  }
  const bytes = readFileSync(source)
  if (!tokens || Object.keys(tokens).length === 0) return atomicWrite(destination, bytes)
  atomicWrite(destination, renderResource(bytes.toString('utf8'), tokens, destination))
}

function managedMarkers(skill: string): { begin: string; end: string } {
  return { begin: `<!-- jls:begin ${skill} -->`, end: `<!-- jls:end ${skill} -->` }
}

function managedBlockPresent(path: string, skill: string): boolean {
  if (!existsSync(path)) return false
  const { begin, end } = managedMarkers(skill)
  const current = readFileSync(path, 'utf8')
  return current.includes(begin) && current.includes(end)
}

function managedBlock(path: string, skill: string, fragment: string): void {
  const { begin, end } = managedMarkers(skill)
  const block = `${begin}\n${fragment.trim()}\n${end}`
  let current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const beginIndex = current.indexOf(begin)
  const endIndex = current.indexOf(end)
  if ((beginIndex >= 0) !== (endIndex >= 0)) throw new Error(`malformed jls block in ${path}`)
  if (beginIndex >= 0) {
    if (current.split(begin).length !== 2 || current.split(end).length !== 2 || endIndex < beginIndex) {
      throw new Error(`ambiguous jls block in ${path}`)
    }
    current = current.slice(0, beginIndex) + block + current.slice(endIndex + end.length)
  } else if (!current.trim()) {
    current = `${block}\n`
  } else {
    current = `${current.replace(/[\r\n]+$/, '')}\n\n${block}\n`
  }
  atomicWrite(path, current)
}

function removeManagedBlock(path: string, skill: string): void {
  if (!existsSync(path)) return
  const { begin, end } = managedMarkers(skill)
  const current = readFileSync(path, 'utf8')
  const beginIndex = current.indexOf(begin)
  const endIndex = current.indexOf(end)
  if (beginIndex < 0 && endIndex < 0) return
  if ((beginIndex >= 0) !== (endIndex >= 0)) throw new Error(`malformed jls block in ${path}`)
  if (current.split(begin).length !== 2 || current.split(end).length !== 2 || endIndex < beginIndex) {
    throw new Error(`ambiguous jls block in ${path}`)
  }
  const before = current.slice(0, beginIndex).replace(/[\r\n]+$/, '')
  const after = current.slice(endIndex + end.length).replace(/^[\r\n]+/, '')
  const next = [before, after].filter((part) => part.length > 0).join('\n\n')
  atomicWrite(path, next.trim() ? `${next.replace(/[\r\n]+$/, '')}\n` : '')
}

function installedPackageManifest(skillPath: string): Manifest | undefined {
  const path = join(skillPath, 'manifest.json')
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  try {
    return parseSkillPackageManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

function rawManifest(path: string): RawSkillManifest | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawSkillManifest
    return raw && typeof raw.name === 'string' ? raw : undefined
  } catch {
    return undefined
  }
}

function cachedManifestPath(name: string): string {
  return join(skillMetadataRoot(), `${name}.json`)
}

function cachePackageManifest(pkg: DownloadedSkillPackage): void {
  atomicWrite(cachedManifestPath(pkg.manifest.name), readFileSync(join(pkg.root, 'manifest.json')))
}

function harnessResourceTargets(manifest: Manifest, agent: string, scope: Scope): HarnessResourceTarget[] {
  const declared = manifest.harness_resources?.[agent] ?? {}
  const roots = agentPaths(agent, scope).resources
  const targets: HarnessResourceTarget[] = []
  for (const [kind, files] of Object.entries(declared)) {
    const root = roots[kind]
    if (!root) throw new Error(`${agent} does not support harness resource type "${kind}"`)
    for (const source of files) targets.push({ source, destination: join(root, basename(source)) })
  }
  return targets
}

function harnessResourcesPresent(skillPath: string, agent: string, scope: Scope): boolean {
  const manifest = installedPackageManifest(skillPath)
  if (!manifest) return true
  return harnessResourceTargets(manifest, agent, scope).every(({ destination }) => existsSync(destination))
}

function removeHarnessResources(manifest: Manifest, agent: string, scope: Scope): void {
  for (const { destination } of harnessResourceTargets(manifest, agent, scope)) rmSync(destination, { force: true })
}

function installHarnessResources(
  pkg: DownloadedSkillPackage,
  agent: string,
  scope: Scope,
  tokens: Record<string, string>,
): void {
  for (const { source, destination } of harnessResourceTargets(pkg.manifest, agent, scope)) {
    copyPackageEntry(join(pkg.root, source), destination, tokens)
  }
}

function discoverInstallations(scope: Scope): InstallGroup[] {
  const groups = new Map<string, InstallGroup>()
  for (const agent of agentCatalog) {
    const paths = agentPaths(agent.id, scope)
    if (!existsSync(paths.skillRoot) || !statSync(paths.skillRoot).isDirectory()) continue
    for (const entry of readdirSync(paths.skillRoot).sort()) {
      const skillPath = join(paths.skillRoot, entry)
      if (!statSync(skillPath).isDirectory()) continue
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

function groupForSkill(scope: Scope, skill: string): InstallGroup | undefined {
  return discoverInstallations(scope).find((group) => group.skill === skill)
}

function targetInstalled(scope: Scope, skill: string, agent: string): boolean {
  return !!groupForSkill(scope, skill)?.targets.some((target) => target.agent === agent)
}

function matchingGroups(parsed: ParsedAction, scope: Scope): InstallGroup[] {
  const requestedAgents = normalizeAgents(parsed.agents)
  return discoverInstallations(scope).map((group) => ({
    ...group,
    targets: requestedAgents.length > 0
      ? group.targets.filter((target) => requestedAgents.includes(target.agent))
      : group.targets,
  })).filter((group) => {
    if (parsed.skills.length > 0 && !parsed.skills.includes(group.skill)) return false
    return group.targets.length > 0
  })
}

function installedVersions(group: InstallGroup): string[] {
  return [...new Set(group.targets.map((target) => target.version))].sort()
}

function stableVersions(release: ReleaseManifest): Record<string, string> {
  return Object.fromEntries(Object.entries(release.skills).map(([name, skill]) => [name, skill.version]))
}

function updateAvailable(group: InstallGroup, available: Record<string, string>): boolean {
  const version = available[group.skill]
  if (!version) return false
  return installedVersions(group).some((installed) => {
    try {
      return compareVersions(installed, version) < 0
    } catch {
      return installed !== version
    }
  })
}

function updateStatus(group: InstallGroup, available: Record<string, string>): string {
  const version = available[group.skill]
  if (!version) throw new Error(`stable release does not contain ${group.skill}`)
  return `${installedVersions(group).join(' / ')} -> ${version}`
}

function runtimeRoot(manifest: Manifest, scope: Scope): string {
  return scopeSkillRoot(scope, manifest.name)
}

function runtimeCliPath(manifest: Manifest, scope: Scope): string {
  if (!manifest.runtime_cli) throw new Error(`${manifest.name} manifest is missing runtime_cli`)
  return join(runtimeRoot(manifest, scope), 'bin', `${manifest.runtime_cli}${compiledTarget().executableSuffix}`)
}

function renderInstructionFragment(pkg: DownloadedSkillPackage, cli?: string): string {
  const manifest = pkg.manifest
  if (!manifest.instruction_fragment) return ''
  const tokenName = manifest.cli_token || 'JL_SKILL_CLI'
  const tokens = cli ? { [`{{${tokenName}}}`]: normalize(cli) } : {}
  return render(readFileSync(join(pkg.root, manifest.instruction_fragment), 'utf8'), tokens)
}

function provisionRuntime(pkg: DownloadedSkillPackage, scope: Scope): { cli?: string } {
  const manifest = pkg.manifest
  if (!manifest.runtime) return {}
  if (manifest.runtime !== 'rust') throw new Error(`unsupported runtime "${manifest.runtime}"`)
  if (!manifest.runtime_cli) throw new Error(`${manifest.name} manifest is missing runtime_cli`)
  const target = compiledTarget().key
  const artifact = manifest.runtime_artifacts?.[target]
  if (!artifact) throw new Error(`${manifest.name} has no bundled runtime for ${target}`)
  const root = runtimeRoot(manifest, scope)
  mkdirSync(root, { recursive: true })
  const cli = runtimeCliPath(manifest, scope)
  copyPackageEntry(join(pkg.root, artifact), cli)
  try { chmodSync(cli, 0o755) } catch {}
  for (const rel of manifest.runtime_files ?? []) copyPackageEntry(join(pkg.root, rel), join(root, rel))
  return { cli }
}

function installTargets(
  pkg: DownloadedSkillPackage,
  scope: Scope,
  targets: InstallTarget[],
  interactive: boolean,
  action: 'install' | 'update',
): void {
  cachePackageManifest(pkg)
  if (scope.kind === 'project') mkdirSync(scope.root, { recursive: true })
  const runtime = provisionRuntime(pkg, scope)
  const tokenName = pkg.manifest.cli_token || 'JL_SKILL_CLI'
  const tokens = runtime.cli ? { [`{{${tokenName}}}`]: normalize(runtime.cli) } : {}
  const fragment = renderInstructionFragment(pkg, runtime.cli)

  for (const target of targets) {
    const paths = agentPaths(target.agent, scope)
    const dest = join(paths.skillRoot, pkg.manifest.name)
    const previous = installedPackageManifest(dest)
    if (previous) removeHarnessResources(previous, target.agent, scope)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const rel of pkg.manifest.skill_files) copyPackageEntry(join(pkg.root, rel), join(dest, rel), tokens)
    copyPackageEntry(join(pkg.root, 'manifest.json'), join(dest, 'manifest.json'))
    installHarnessResources(pkg, target.agent, scope, tokens)
    if (target.instructions && fragment) managedBlock(paths.instruction, pkg.manifest.name, fragment)
    else removeManagedBlock(paths.instruction, pkg.manifest.name)

    const verb = action === 'update' ? 'Updated' : 'Installed'
    if (interactive) prompts.log.step(`${verb} ${displaySkillName(pkg.manifest.name)} ${pkg.manifest.version} for ${agentLabel(target.agent)}`)
    else console.log(`${verb} ${pkg.manifest.name} ${pkg.manifest.version} for ${target.agent} at ${dest}`)
  }
}

function configureInstruction(
  pkg: DownloadedSkillPackage,
  scope: Scope,
  target: InstallTargetState,
  interactive: boolean,
): void {
  const paths = agentPaths(target.agent, scope)
  if (target.requestedInstructions) {
    const cli = pkg.manifest.runtime ? runtimeCliPath(pkg.manifest, scope) : undefined
    const fragment = renderInstructionFragment(pkg, cli)
    if (!fragment) throw new Error(`${pkg.manifest.name} does not provide managed instructions`)
    managedBlock(paths.instruction, pkg.manifest.name, fragment)
  } else {
    removeManagedBlock(paths.instruction, pkg.manifest.name)
  }
  if (interactive) prompts.log.step(`Configured ${displaySkillName(pkg.manifest.name)} for ${agentLabel(target.agent)}`)
}

function uninstallGroup(group: InstallGroup, interactive: boolean): void {
  for (const target of group.targets) {
    const manifest = installedPackageManifest(target.skillPath)
    if (manifest) removeHarnessResources(manifest, target.agent, group.scope)
    rmSync(target.skillPath, { recursive: true, force: true })
    removeManagedBlock(target.instructionPath, group.skill)
    if (interactive) prompts.log.step(`Uninstalled ${displaySkillName(group.skill)} from ${agentLabel(target.agent)}`)
    else console.log(`Uninstalled ${group.skill} for ${target.agent} from ${group.scope.identity}`)
  }
  if (!discoverInstallations(group.scope).some((candidate) => candidate.skill === group.skill)) {
    rmSync(scopeSkillRoot(group.scope, group.skill), { recursive: true, force: true })
  }
}

function parseAction(args: string[], command: 'install' | 'update' | 'uninstall'): ParsedAction {
  const out: ParsedAction = { skills: [], agents: [] }
  const body = args[0] === command ? args.slice(1) : args
  for (let i = 0; i < body.length; i++) {
    const arg = body[i]
    if (arg === '--scope') {
      if (i + 1 >= body.length) throw new Error('--scope requires user, cwd, or a path')
      out.scope = body[++i]
    } else if (arg.startsWith('--scope=')) out.scope = arg.slice('--scope='.length)
    else if (arg === '--agent') {
      if (i + 1 >= body.length) throw new Error('--agent requires a harness name')
      out.agents.push(body[++i])
    } else if (arg.startsWith('--agent=')) out.agents.push(arg.slice('--agent='.length))
    else if (arg === '--instructions') {
      if (command === 'uninstall') throw new Error('--instructions is not valid for uninstall')
      out.instructions = true
    } else if (arg === '--no-instructions') {
      if (command === 'uninstall') throw new Error('--no-instructions is not valid for uninstall')
      out.instructions = false
    } else if (arg.startsWith('-')) throw new Error(`unknown ${command} option ${arg}`)
    else out.skills.push(arg)
  }
  return out
}

function displaySkillName(name: string): string {
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : name
}

function humanList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function requireRelease(release: ReleaseManifest | null): ReleaseManifest {
  if (!release) throw new Error('no stable jls release is currently available')
  return release
}

async function fetchAvailableSkills(state: WizardState): Promise<ReleaseManifest> {
  if (!process.stdin.isTTY) return requireRelease(await fetchStableReleaseManifest())
  ensureIntro(state)
  const spinner = prompts.spinner({ withGuide: false })
  spinner.start('Checking available skills')
  try {
    return requireRelease(await fetchStableReleaseManifest())
  } finally {
    spinner.clear()
  }
}

function requireReleasedSkills(release: ReleaseManifest, names: string[]): void {
  for (const name of names) if (!release.skills[name]) throw new Error(`stable release does not contain ${name}`)
}

async function ensureSkillCompatibility(
  release: ReleaseManifest,
  skills: string[],
  state: WizardState,
): Promise<boolean> {
  const incompatible = skills.filter((name) => compareVersions(VERSION, release.skills[name].min_installer) < 0)
  if (incompatible.length === 0) return true
  const latestSatisfies = incompatible.every((name) => compareVersions(release.installer.version, release.skills[name].min_installer) >= 0)
  const lines = incompatible.map((name) => `${displaySkillName(name)} ${release.skills[name].version} requires JLS ${release.skills[name].min_installer} or newer; running ${VERSION}.`)
  if (!process.stdin.isTTY) throw new Error(lines.join(' '))
  for (const line of lines) prompts.log.warn(line)
  if (!latestSatisfies) {
    prompts.log.warn('No compatible stable installer is currently available.')
    return false
  }
  prompts.log.info(`JLS ${release.installer.version} is available and satisfies the requirement.`)
  await updateInstallerWizard(state)
  return false
}

async function preparePackages(
  release: ReleaseManifest,
  skills: string[],
  state: WizardState,
): Promise<Map<string, DownloadedSkillPackage>> {
  const packages = new Map<string, DownloadedSkillPackage>()
  const spinner = process.stdin.isTTY ? prompts.spinner({ withGuide: false }) : undefined
  spinner?.start('Preparing selected skills')
  try {
    for (const skill of skills) packages.set(skill, await downloadSkillPackage(skill, release.skills[skill]))
    return packages
  } catch (error) {
    for (const pkg of packages.values()) pkg.cleanup()
    throw error
  } finally {
    spinner?.clear()
    void state
  }
}

function cleanupPackages(packages: Map<string, DownloadedSkillPackage>): void {
  for (const pkg of packages.values()) pkg.cleanup()
}

function instructionFiles(agents: string[], scope: Scope): string[] {
  return [...new Set(agents.map((agent) => basename(agentPaths(agent, scope).instruction)))]
}

function instructionExplanation(agents: string[], scope: Scope): string {
  const files = instructionFiles(agents, scope)
  const names = humanList(files)
  return files.length === 1
    ? `The ${names} file contains general instructions that your selected AI tool reads automatically. JLS can add managed skill-specific sections without changing unrelated content.`
    : `${names} files contain general instructions that your selected AI tools read automatically. JLS can add managed skill-specific sections without changing unrelated content.`
}

function installSummary(scope: Scope, skills: string[]): string {
  return [`JLS Installer will install the following skills ${scopePhrase(scope)}:`, ...skills.map((skill) => `- ${displaySkillName(skill)}`)].join('\n')
}

function updateSummary(scope: Scope, groups: InstallGroup[], available: Record<string, string>): string {
  return [
    `JLS Installer will update the following skills ${scopePhrase(scope)}:`,
    ...groups.map((group) => `- ${displaySkillName(group.skill)} (${updateStatus(group, available)})`),
  ].join('\n')
}

function uninstallSummary(scope: Scope, groups: InstallGroup[], removeData: Set<string>, cleanupGroups: CleanupGroup[]): string {
  const cleanupSkills = new Set(cleanupGroups.map((group) => group.skill))
  const lines = [`JLS Installer will uninstall the following skills ${scopePhrase(scope)}:`]
  for (const group of groups) {
    lines.push(`- ${displaySkillName(group.skill)}`)
    lines.push('  - Skill/agent files: Remove')
    if (cleanupSkills.has(group.skill)) lines.push(`  - Generated data: ${removeData.has(group.skill) ? 'Remove' : 'Keep'}`)
  }
  return lines.join('\n')
}

function installPreflight(
  scope: Scope,
  skills: string[],
  agents: string[],
  injectedSkills: string[],
  availableVersions: Record<string, string>,
): InstallTargetState[] {
  const requestedInstructions = Object.fromEntries(skills.map((skill) => [skill, injectedSkills.includes(skill)]))
  const installedTargets = discoverInstallations(scope).flatMap((group) => group.targets
    .filter((target) => harnessResourcesPresent(target.skillPath, target.agent, scope))
    .map((target) => ({ skill: group.skill, agent: target.agent, version: target.version, instructions: target.instructions })))
  return classifyInstallTargets(skills, agents, availableVersions, requestedInstructions, installedTargets)
}

async function chooseInstallSkills(
  release: ReleaseManifest,
  scope: Scope,
  agents: string[],
  state: WizardState,
  stepId: string,
  allowBack: boolean,
): Promise<NavResult<string[]>> {
  const items = Object.keys(release.skills).sort().map((name) => ({
    value: name,
    label: displaySkillName(name),
    disabled: agents.length > 0 && agents.every((agent) => targetInstalled(scope, name, agent)),
  }))
  if (!items.some((item) => !item.disabled)) {
    prompts.log.info('All available skills are already installed for every detected AI harness.')
    return BACK_SIGNAL
  }
  return chooseMany(state, stepId, 'Which skills would you like to install?', items, { allowBack })
}

async function chooseInstallAgents(
  explicit: string[],
  scope: Scope,
  skills: string[],
  state: WizardState,
  stepId: string,
): Promise<NavResult<{ values: string[]; all: AgentInfo[] }>> {
  const all = detectedAgents()
  if (explicit.length > 0) return { values: normalizeAgents(explicit), all }
  const detected = all.filter((agent) => agent.detected)
  if (!process.stdin.isTTY) {
    if (detected.length === 0) throw new Error('no supported AI harness detected; specify --agent')
    return { values: detected.map((agent) => agent.id), all }
  }
  if (detected.length === 0) {
    prompts.log.warn('No supported AI harnesses were detected.')
    return BACK_SIGNAL
  }
  const items = detected.map((agent) => ({
    value: agent.id,
    label: agent.label,
    disabled: skills.every((skill) => targetInstalled(scope, skill, agent.id)),
  }))
  if (!items.some((item) => !item.disabled)) return BACK_SIGNAL
  const values = await chooseMany(state, stepId, 'Which AI harnesses should receive these skills?', items, { allowBack: true })
  if (values === BACK_SIGNAL) return BACK_SIGNAL
  return { values: normalizeAgents(values), all }
}

async function chooseInstructionInjection(
  state: WizardState,
  stepId: string,
  agents: string[],
  scope: Scope,
  packages: Map<string, DownloadedSkillPackage>,
): Promise<NavResult<string[]>> {
  const capable = [...packages.entries()].filter(([, pkg]) => !!pkg.manifest.instruction_fragment).map(([skill]) => skill)
  if (capable.length === 0) return []
  prompts.note(instructionExplanation(agents, scope), 'About AI Instruction Files')
  const files = humanList(instructionFiles(agents, scope))
  return chooseMany(
    state,
    stepId,
    `Which skills would you like to add to ${files}?`,
    capable.map((skill) => ({ value: skill, label: displaySkillName(skill) })),
    { allowBack: true, required: false, initialValues: capable },
  )
}

async function installAtScope(
  scope: Scope,
  requestedSkills: string[],
  explicitAgents: string[],
  instructionOverride: boolean | undefined,
  state: WizardState,
  stepPrefix: string,
  allowBack = true,
): Promise<InstallResult> {
  const release = await fetchAvailableSkills(state)
  const availableVersions = stableVersions(release)
  let selectedSkills = [...requestedSkills]

  skillStep:
  while (true) {
    const initialAgentIds = explicitAgents.length > 0
      ? normalizeAgents(explicitAgents)
      : detectedAgents().filter((agent) => agent.detected).map((agent) => agent.id)

    if (selectedSkills.length === 0) {
      if (!process.stdin.isTTY) throw new Error('no skills selected')
      const chosen = await chooseInstallSkills(release, scope, initialAgentIds, state, `${stepPrefix}.skills`, allowBack)
      if (chosen === BACK_SIGNAL) return BACK_SIGNAL
      selectedSkills = chosen
    }
    requireReleasedSkills(release, selectedSkills)
    if (!await ensureSkillCompatibility(release, selectedSkills, state)) return HOME

    agentStep:
    while (true) {
      const agentChoice = await chooseInstallAgents(explicitAgents, scope, selectedSkills, state, `${stepPrefix}.harnesses`)
      if (agentChoice === BACK_SIGNAL) {
        if (requestedSkills.length > 0) return BACK_SIGNAL
        selectedSkills = []
        continue skillStep
      }

      const packages = await preparePackages(release, selectedSkills, state)
      try {
        instructionStep:
        while (true) {
          let injectedSkills: string[]
          if (instructionOverride === true) {
            injectedSkills = selectedSkills.filter((skill) => !!packages.get(skill)?.manifest.instruction_fragment)
          } else if (instructionOverride === false || !process.stdin.isTTY) {
            injectedSkills = []
          } else {
            const choice = await chooseInstructionInjection(
              state,
              `${stepPrefix}.instructions`,
              agentChoice.values,
              scope,
              packages,
            )
            if (choice === BACK_SIGNAL) continue agentStep
            injectedSkills = choice
          }

          if (process.stdin.isTTY) {
            prompts.note(installSummary(scope, selectedSkills))
            const proceed = await chooseConfirmation(state, `${stepPrefix}.confirm`)
            if (proceed === BACK_SIGNAL || !proceed) continue instructionStep
          }

          const planned = installPreflight(scope, selectedSkills, agentChoice.values, injectedSkills, availableVersions)
          const actionable = planned.filter((target) => target.state === 'missing' || target.state === 'configure')
          if (actionable.length === 0) {
            if (process.stdin.isTTY) prompts.log.info('There is nothing to install.')
            return HOME
          }

          for (const skill of selectedSkills) {
            const pkg = packages.get(skill)!
            const states = actionable.filter((target) => target.skill === skill)
            const missing = states.filter((target) => target.state === 'missing').map((target) => target.agent)
            const configure = states.filter((target) => target.state === 'configure')
            if (missing.length > 0) {
              installTargets(
                pkg,
                scope,
                missing.map((agent) => ({ agent, instructions: injectedSkills.includes(skill) })),
                !!process.stdin.isTTY,
                'install',
              )
            }
            for (const target of configure) configureInstruction(pkg, scope, target, !!process.stdin.isTTY)
          }
          return 0
        }
      } finally {
        cleanupPackages(packages)
      }
    }
  }
}

async function updateAtScope(
  scope: Scope,
  requestedSkills: string[],
  explicitAgents: string[],
  instructionOverride: boolean | undefined,
  state: WizardState,
  stepPrefix: string,
): Promise<UpdateResult> {
  const spinner = process.stdin.isTTY ? prompts.spinner({ withGuide: false }) : undefined
  spinner?.start('Checking for updates')
  let release: ReleaseManifest
  try {
    release = requireRelease(await fetchStableReleaseManifest())
  } finally {
    spinner?.clear()
  }
  const availableVersions = stableVersions(release)
  const parsed: ParsedAction = { skills: requestedSkills, agents: explicitAgents, scope: scope.identity, instructions: instructionOverride }
  const installed = matchingGroups({ ...parsed, skills: [] }, scope)
  if (installed.length === 0) return HOME

  let available = installed.filter((group) => updateAvailable(group, availableVersions))
  if (requestedSkills.length > 0) available = available.filter((group) => requestedSkills.includes(group.skill))
  if (available.length === 0) return NO_UPDATES

  let groups = available
  if (requestedSkills.length === 0 && process.stdin.isTTY) {
    const width = Math.max(...available.map((group) => displaySkillName(group.skill).length))
    const selected = await chooseMany(
      state,
      `${stepPrefix}.skills`,
      'The following updates are available. Please select which you would like to install.',
      available.map((group) => ({
        value: group.skill,
        label: `${displaySkillName(group.skill).padEnd(width)}  ${updateStatus(group, availableVersions)}`,
      })),
      { allowBack: true },
    )
    if (selected === BACK_SIGNAL) return BACK_SIGNAL
    groups = available.filter((group) => selected.includes(group.skill))
  }

  requireReleasedSkills(release, groups.map((group) => group.skill))
  if (!await ensureSkillCompatibility(release, groups.map((group) => group.skill), state)) return HOME

  if (process.stdin.isTTY) {
    prompts.note(updateSummary(scope, groups, availableVersions))
    const proceed = await chooseConfirmation(state, `${stepPrefix}.confirm`)
    if (proceed === BACK_SIGNAL || !proceed) return BACK_SIGNAL
  }

  for (const group of groups) {
    const pkg = await downloadSkillPackage(group.skill, release.skills[group.skill])
    try {
      installTargets(
        pkg,
        group.scope,
        group.targets.map((target) => ({ agent: target.agent, instructions: instructionOverride ?? target.instructions })),
        !!process.stdin.isTTY,
        'update',
      )
    } finally {
      pkg.cleanup()
    }
  }
  return 0
}

function rawManifestForGroup(group: InstallGroup): RawSkillManifest | undefined {
  for (const target of group.targets) {
    const raw = rawManifest(join(target.skillPath, 'manifest.json'))
    if (raw?.name === group.skill) return raw
  }
  const cached = rawManifest(cachedManifestPath(group.skill))
  return cached?.name === group.skill ? cached : undefined
}

function cleanupGroupsFor(scope: Scope, groups: InstallGroup[]): CleanupGroup[] {
  const result: CleanupGroup[] = []
  for (const group of groups) {
    const manifest = rawManifestForGroup(group)
    if (!manifest) continue
    const detected = detectGeneratedCleanup(scope.root, manifest)
    if (detected.length === 0) continue
    result.push({
      skill: group.skill,
      description: [...new Set(detected.map((cleanup) => cleanup.description))].join('; '),
      cleanups: detected,
    })
  }
  return result
}

async function uninstallAtScope(
  scope: Scope,
  requestedSkills: string[],
  explicitAgents: string[],
  state: WizardState,
  stepPrefix: string,
  offerGeneratedData: boolean,
): Promise<NavResult<number>> {
  const parsed: ParsedAction = { skills: requestedSkills, agents: explicitAgents, scope: scope.identity }
  let groups = matchingGroups(parsed, scope)
  if (requestedSkills.length === 0) {
    if (!process.stdin.isTTY) throw new Error('no skills selected for uninstall')
    const available = discoverInstallations(scope)
    if (available.length === 0) return HOME
    const selected = await chooseMany(
      state,
      `${stepPrefix}.skills`,
      'Which skills would you like to uninstall?',
      available.map((group) => ({ value: group.skill, label: displaySkillName(group.skill) })),
      { allowBack: true },
    )
    if (selected === BACK_SIGNAL) return BACK_SIGNAL
    groups = available.filter((group) => selected.includes(group.skill))
  }
  if (groups.length === 0) throw new Error('no installations match uninstall filters')

  let cleanupGroups: CleanupGroup[] = []
  let removeData = new Set<string>()
  if (offerGeneratedData && process.stdin.isTTY) {
    cleanupGroups = cleanupGroupsFor(scope, groups)
    if (cleanupGroups.length > 0) {
      const selected = await chooseMany(
        state,
        `${stepPrefix}.generated-data`,
        'The following selected skills have generated data that can also be removed.',
        cleanupGroups.map((group) => ({
          value: group.skill,
          label: `${displaySkillName(group.skill)} ${styleText('dim', `(${group.description})`)}`,
        })),
        { allowBack: true, required: false, initialValues: cleanupGroups.map((group) => group.skill) },
      )
      if (selected === BACK_SIGNAL) return BACK_SIGNAL
      removeData = new Set(selected)
    }
  }

  if (process.stdin.isTTY) {
    prompts.note(uninstallSummary(scope, groups, removeData, cleanupGroups))
    const proceed = await chooseConfirmation(state, `${stepPrefix}.confirm`, true)
    if (proceed === BACK_SIGNAL || !proceed) return BACK_SIGNAL
  }

  for (const cleanupGroup of cleanupGroups) {
    if (!removeData.has(cleanupGroup.skill)) continue
    for (const cleanup of cleanupGroup.cleanups) removeGeneratedCleanup(scope.root, cleanup)
    if (process.stdin.isTTY) prompts.log.step(`Removed ${displaySkillName(cleanupGroup.skill)} generated data`)
  }
  for (const group of groups) uninstallGroup(group, !!process.stdin.isTTY)
  return 0
}

function installerExecutable(): string {
  if (!Bun.isStandaloneExecutable) throw new Error('installer management is only available from the compiled JLS executable')
  return canonicalPath(process.execPath)
}

function scheduleInstallerUninstall(executable: string, dataRoot: string): void {
  if (isWindows) {
    const escapedExecutable = executable.replaceAll('"', '""')
    const escapedDataRoot = dataRoot.replaceAll('"', '""')
    const command = [
      'ping 127.0.0.1 -n 2 >nul',
      `if exist "${escapedDataRoot}" rmdir /s /q "${escapedDataRoot}"`,
      `del /f /q "${escapedExecutable}"`,
    ].join(' & ')
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return
  }
  const child = spawn('/bin/sh', [
    '-c',
    'sleep 1; rm -rf -- "$1"; rm -f -- "$2"',
    'jls-uninstall',
    dataRoot,
    executable,
  ], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function updateInstallerWizard(state: WizardState): Promise<UpdateResult> {
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
    prompts.log.info('Up to date.')
    return HOME
  }
  prompts.note(`An update is available: v${VERSION} -> v${update.version}.\n\nUpdating will end this session. You must relaunch JLS afterward.`)
  const proceed = await chooseConfirmation(state, 'installer-update.confirm')
  if (proceed === BACK_SIGNAL || !proceed) return BACK_SIGNAL
  const staged = await stageInstallerUpdate(executable, update)
  scheduleInstallerReplacement(staged, executable)
  return 0
}

async function uninstallInstallerWizard(state: WizardState): Promise<NavResult<number>> {
  ensureIntro(state)
  const executable = installerExecutable()
  prompts.note('This will uninstall the JLS installer and its installer-owned metadata and tooling. It will not remove installed skills, skill instruction integrations, skill runtimes, or skill-generated data.')
  const proceed = await chooseConfirmation(state, 'installer-uninstall.confirm', true)
  if (proceed === BACK_SIGNAL || !proceed) return BACK_SIGNAL
  scheduleInstallerUninstall(executable, installerDataRoot())
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
      if (result === 0) return 0
      continue
    }
    const result = await uninstallInstallerWizard(state)
    if (result === BACK_SIGNAL) continue
    return result
  }
}

async function manageScopeWizard(scope: Scope, state: WizardState): Promise<NavResult<number>> {
  const prefix = `manage.${scope.origin}:${scope.identity}`
  while (true) {
    const hasInstalled = discoverInstallations(scope).length > 0
    const choice = await chooseOne(
      state,
      `${prefix}.action`,
      'What would you like to do?',
      [
        { value: 'install', label: 'Install new skills' },
        { value: 'update', label: 'Check for updates', disabled: !hasInstalled },
        { value: 'uninstall', label: 'Uninstall existing skills', disabled: !hasInstalled },
      ],
      { allowBack: true, initialValue: 'install' },
    )
    if (choice === BACK_SIGNAL) return BACK_SIGNAL

    if (choice === 'install') {
      const result = await installAtScope(scope, [], [], undefined, state, `${prefix}.install`, true)
      if (result === BACK_SIGNAL || result === HOME) continue
      return result
    }
    if (choice === 'update') {
      const result = await updateAtScope(scope, [], [], undefined, state, `${prefix}.update`)
      if (result === NO_UPDATES) {
        prompts.log.info('No updates were found.')
        continue
      }
      if (result === BACK_SIGNAL || result === HOME) continue
      return result
    }

    const result = await uninstallAtScope(scope, [], [], state, `${prefix}.uninstall`, true)
    if (result === BACK_SIGNAL || result === HOME) continue
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

async function installWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'install')
  const state = newWizardState()
  if (parsed.scope) {
    const result = await installAtScope(resolveScope(parsed.scope), parsed.skills, parsed.agents, parsed.instructions, state, `install.${parsed.scope}`, false)
    if (result === BACK_SIGNAL) cancel()
    return result === HOME ? 0 : result
  }
  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const scope = await chooseScope(state, 'install.scope', 'Where would you like to install skills?', false)
    if (scope === BACK_SIGNAL) cancel()
    const result = await installAtScope(scope, parsed.skills, parsed.agents, parsed.instructions, state, `install.${scope.identity}`, true)
    if (result === BACK_SIGNAL) continue
    return result === HOME ? 0 : result
  }
}

async function updateWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'update')
  const state = newWizardState()
  if (parsed.scope) {
    const result = await updateAtScope(resolveScope(parsed.scope), parsed.skills, parsed.agents, parsed.instructions, state, `update.${parsed.scope}`)
    if (result === BACK_SIGNAL) cancel()
    if (result === NO_UPDATES && process.stdin.isTTY) prompts.log.info('No updates were found.')
    return 0
  }
  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const scope = await chooseScope(state, 'update.scope', 'Where would you like to update skills?', false)
    if (scope === BACK_SIGNAL) cancel()
    const result = await updateAtScope(scope, parsed.skills, parsed.agents, parsed.instructions, state, `update.${scope.identity}`)
    if (result === BACK_SIGNAL || result === HOME || result === NO_UPDATES) {
      if (result === NO_UPDATES) prompts.log.info('No updates were found.')
      continue
    }
    return result
  }
}

async function uninstallWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'uninstall')
  const state = newWizardState()
  if (parsed.scope) {
    const result = await uninstallAtScope(resolveScope(parsed.scope), parsed.skills, parsed.agents, state, `uninstall.${parsed.scope}`, false)
    if (result === BACK_SIGNAL) cancel()
    return result === HOME ? 0 : result
  }
  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const scope = await chooseScope(state, 'uninstall.scope', 'Where would you like to uninstall skills?', false)
    if (scope === BACK_SIGNAL) cancel()
    const result = await uninstallAtScope(scope, parsed.skills, parsed.agents, state, `uninstall.${scope.identity}`, false)
    if (result === BACK_SIGNAL || result === HOME) continue
    return result
  }
}

function printHelp(): void {
  console.log(`jls\n\nUsage:\n  jls install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jls update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jls uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n\nSkill-first invocations continue to mean install. Interactive prompts use @clack/prompts ${PROMPTS_VERSION}.\n`)
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0) return bareWizard()
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jls ${VERSION}`)
    return 0
  }
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateWizard(args)
  if (args[0] === 'uninstall') return uninstallWizard(args)
  return installWizard(args)
}

if (import.meta.main) {
  main()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      console.error(`jls: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
