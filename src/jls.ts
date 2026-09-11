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
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { styleText } from 'node:util'
import { exclusiveMultiselect, type ExclusiveOption } from './exclusive-multiselect'
import {
  HARNESS_ADAPTERS,
  harnessAdapter,
  normalizeHarnessId,
  type HarnessAdapter,
  type HarnessPaths,
} from './harnesses'
import {
  classifyInstallTargets,
  satisfiedSkills,
  staleSkills,
  type InstallTargetState,
} from './install-preflight'
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
  type GeneratedDataSpec,
  type ReleaseManifest,
  type SkillPackageManifest,
} from './installer-updater'
import { renderResource } from './resource-render'
import { compiledTarget } from './targets'
import installerManifest from '../manifest.json'

const VERSION = installerManifest.version
const PROMPTS_VERSION = '1.7.0'
const isWindows = platform() === 'win32'
const HOME = Symbol('jls-home')

type Manifest = SkillPackageManifest

type Scope = {
  kind: 'user' | 'project'
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
type GeneratedDataGroup = {
  skill: string
  paths: string[]
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
type UpdateResult = NavResult<number> | typeof HOME
type AvailableSkillVersions = Record<string, string>
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

function ensureIntro(state: WizardState, title = `JLS Installer ${styleText('dim', `v${VERSION}`)}`): void {
  if (!state.shown) {
    prompts.intro(title)
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
  {
    allowBack = true,
    safeDefault = false,
  }: { allowBack?: boolean; safeDefault?: boolean } = {},
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
    { allowBack, initialValue: safeDefault ? 'no' : 'yes' },
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
  if (value === 'user') return { kind: 'user', identity: 'user', root: userHome() }
  if (value === 'cwd') {
    const root = canonicalPath(process.cwd())
    return { kind: 'project', identity: root, root }
  }
  if (!value) throw new Error('empty scope')
  const root = canonicalPath(value)
  if (existsSync(root) && !statSync(root).isDirectory()) throw new Error(`scope path is not a directory: ${root}`)
  return { kind: 'project', identity: root, root }
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

    const textStep = memory(state, `${stepId}.custom`)
    const rawPath = checked(await navText({
      message: 'Enter a custom path.',
      placeholder: process.cwd(),
      initialValue: textStep.text,
      allowBack: true,
      validate: (value: string | undefined) => value?.trim() ? undefined : 'Please provide a path.',
      onInput: (value) => { textStep.text = value },
    }))
    if (rawPath === BACK_SIGNAL) continue
    const path = (rawPath as string | undefined)?.trim()
    if (!path) continue
    textStep.text = path
    return resolveScope(path)
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true })
  return result.status === 0
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

function validateGeneratedData(manifest: Manifest): void {
  for (const entry of manifest.generated_data ?? []) {
    const parts = entry.path.split(/[\\/]+/)
    if (!entry.path || isAbsolute(entry.path) || parts.includes('..')) {
      throw new Error(`${manifest.name} generated_data path must be relative and contained`)
    }
    if (entry.marker) {
      const markerParts = entry.marker.split(/[\\/]+/)
      if (isAbsolute(entry.marker) || markerParts.includes('..')) {
        throw new Error(`${manifest.name} generated_data marker must be relative and contained`)
      }
    }
  }
}

function validatePackageMetadata(pkg: DownloadedSkillPackage): void {
  const skillFile = pkg.manifest.skill_files.find((rel) => basename(rel).toLowerCase() === 'skill.md')
  if (!skillFile) throw new Error(`${pkg.manifest.name} manifest must include SKILL.md`)
  const skillPath = join(pkg.root, skillFile)
  if (!existsSync(skillPath) || statSync(skillPath).isDirectory()) throw new Error(`${pkg.manifest.name} package has invalid SKILL.md`)
  validateGeneratedData(pkg.manifest)
}

function cachedManifestPath(name: string): string {
  return join(skillMetadataRoot(), `${name}.json`)
}

function cachePackageManifest(pkg: DownloadedSkillPackage): void {
  atomicWrite(cachedManifestPath(pkg.manifest.name), readFileSync(join(pkg.root, 'manifest.json')))
}

function cachedManifests(): Manifest[] {
  const root = skillMetadataRoot()
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const manifests: Manifest[] = []
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry)
    if (!entry.endsWith('.json') || !existsSync(path) || !statSync(path).isFile()) continue
    try {
      manifests.push(parseSkillPackageManifest(JSON.parse(readFileSync(path, 'utf8'))))
    } catch {}
  }
  return manifests
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
  return {
    begin: `<!-- jls:begin ${skill} -->`,
    end: `<!-- jls:end ${skill} -->`,
  }
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
  if (!next.trim()) atomicWrite(path, '')
  else atomicWrite(path, `${next.replace(/[\r\n]+$/, '')}\n`)
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
  for (const { destination } of harnessResourceTargets(manifest, agent, scope)) {
    rmSync(destination, { force: true })
  }
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

function stableVersions(release: ReleaseManifest): AvailableSkillVersions {
  return Object.fromEntries(Object.entries(release.skills).map(([name, skill]) => [name, skill.version]))
}

function updateAvailable(group: InstallGroup, available: AvailableSkillVersions): boolean {
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

function updateStatus(group: InstallGroup, available: AvailableSkillVersions): string {
  const version = available[group.skill]
  if (!version) throw new Error(`stable release does not contain ${group.skill}`)
  return `${installedVersions(group).join(' / ')} → ${version}`
}

function installPreflight(
  scope: Scope,
  skills: string[],
  agents: string[],
  injectedSkills: string[],
  availableVersions: AvailableSkillVersions,
): InstallTargetState[] {
  const requestedInstructions = Object.fromEntries(skills.map((skill) => [skill, injectedSkills.includes(skill)]))
  const installedTargets = discoverInstallations(scope).flatMap((group) => group.targets
    .filter((target) => harnessResourcesPresent(target.skillPath, target.agent, scope))
    .map((target) => ({
      skill: group.skill,
      agent: target.agent,
      version: target.version,
      instructions: target.instructions,
    })))
  return classifyInstallTargets(skills, agents, availableVersions, requestedInstructions, installedTargets)
}

function staleInstallLabel(group: ReturnType<typeof staleSkills>[number]): string {
  return `${displaySkillName(group.skill)}  ${group.installedVersions.join(' / ')} → ${group.availableVersion}`
}

function runtimePlatformKey(): string {
  return compiledTarget().key
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

function provisionRuntime(pkg: DownloadedSkillPackage, scope: Scope): { cli?: string; root?: string } {
  const manifest = pkg.manifest
  if (!manifest.runtime) return {}
  if (manifest.runtime !== 'rust') throw new Error(`unsupported runtime "${manifest.runtime}"`)
  if (!manifest.runtime_cli) throw new Error(`${manifest.name} manifest is missing runtime_cli`)
  const target = runtimePlatformKey()
  const artifact = manifest.runtime_artifacts?.[target]
  if (!artifact) throw new Error(`${manifest.name} has no bundled runtime for ${target}`)
  const root = runtimeRoot(manifest, scope)
  mkdirSync(root, { recursive: true })
  const cli = runtimeCliPath(manifest, scope)
  copyPackageEntry(join(pkg.root, artifact), cli)
  try { chmodSync(cli, 0o755) } catch {}
  for (const rel of manifest.runtime_files ?? []) copyPackageEntry(join(pkg.root, rel), join(root, rel))
  return { cli, root }
}
function installTargets(
  pkg: DownloadedSkillPackage,
  scope: Scope,
  targets: InstallTarget[],
  interactive = false,
  action: 'install' | 'update' = 'install',
): void {
  const manifest = pkg.manifest
  validatePackageMetadata(pkg)
  cachePackageManifest(pkg)
  if (scope.kind === 'project') mkdirSync(scope.root, { recursive: true })
  const runtime = provisionRuntime(pkg, scope)
  const tokenName = manifest.cli_token || 'JL_SKILL_CLI'
  const tokens = runtime.cli ? { [`{{${tokenName}}}`]: normalize(runtime.cli) } : {}
  const fragment = renderInstructionFragment(pkg, runtime.cli)

  for (const target of targets) {
    const paths = agentPaths(target.agent, scope)
    const dest = join(paths.skillRoot, manifest.name)
    const previous = installedPackageManifest(dest)
    if (previous) removeHarnessResources(previous, target.agent, scope)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const rel of manifest.skill_files) copyPackageEntry(join(pkg.root, rel), join(dest, rel), tokens)
    copyPackageEntry(join(pkg.root, 'manifest.json'), join(dest, 'manifest.json'))
    installHarnessResources(pkg, target.agent, scope, tokens)

    if (target.instructions && fragment) managedBlock(paths.instruction, manifest.name, fragment)
    else removeManagedBlock(paths.instruction, manifest.name)

    const verb = action === 'update' ? 'Updated' : 'Installed'
    if (interactive) {
      prompts.log.step(`${verb} ${displaySkillName(manifest.name)} ${manifest.version} for ${agentLabel(target.agent)}`)
    } else {
      console.log(`${verb} ${manifest.name} ${manifest.version} for ${target.agent} at ${dest}`)
    }
  }
}

function configureInstruction(
  pkg: DownloadedSkillPackage,
  scope: Scope,
  agent: string,
  instructions: boolean,
  interactive = false,
): void {
  const manifest = pkg.manifest
  const paths = agentPaths(agent, scope)
  if (instructions) {
    const cli = manifest.runtime ? runtimeCliPath(manifest, scope) : undefined
    const fragment = renderInstructionFragment(pkg, cli)
    if (!fragment) throw new Error(`${manifest.name} does not provide managed instructions`)
    managedBlock(paths.instruction, manifest.name, fragment)
  } else {
    removeManagedBlock(paths.instruction, manifest.name)
  }

  if (interactive) {
    prompts.log.step(`Configured ${displaySkillName(manifest.name)} for ${agentLabel(agent)}`)
  } else {
    console.log(`Configured ${manifest.name} for ${agent} at ${scope.identity}`)
  }
}

function uninstallGroup(group: InstallGroup, interactive = false): void {
  for (const target of group.targets) {
    const manifest = installedPackageManifest(target.skillPath)
    if (manifest) removeHarnessResources(manifest, target.agent, group.scope)
    rmSync(target.skillPath, { recursive: true, force: true })
    removeManagedBlock(target.instructionPath, group.skill)
    if (interactive) {
      prompts.log.step(`Uninstalled ${displaySkillName(group.skill)} from ${agentLabel(target.agent)}`)
    } else {
      console.log(`Uninstalled ${group.skill} for ${target.agent} from ${group.scope.identity}`)
    }
  }

  const stillInstalled = discoverInstallations(group.scope).some((candidate) => candidate.skill === group.skill)
  if (!stillInstalled) rmSync(scopeSkillRoot(group.scope, group.skill), { recursive: true, force: true })
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

function scopeDisplay(scope: Scope): string {
  return scope.kind === 'user' ? 'User account' : scope.identity
}

function humanList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function indentedCommaList(values: string[]): string {
  return `  ${values.join(', ')}`
}

function indentedLineList(values: string[]): string {
  return values.map((value) => `  ${value}`).join('\n')
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
  for (const name of names) {
    if (!release.skills[name]) throw new Error(`stable release does not contain ${name}`)
  }
}

async function ensureSkillCompatibility(
  release: ReleaseManifest,
  skills: string[],
  state: WizardState,
): Promise<boolean> {
  const incompatible = skills.filter((name) => compareVersions(VERSION, release.skills[name].min_installer) < 0)
  if (incompatible.length === 0) return true

  const lines = incompatible.map((name) => (
    `${displaySkillName(name)} ${release.skills[name].version} requires jls ${release.skills[name].min_installer} or newer; running ${VERSION}.`
  ))
  const latestSatisfies = incompatible.every((name) => (
    compareVersions(release.installer.version, release.skills[name].min_installer) >= 0
  ))

  if (!process.stdin.isTTY) {
    const suffix = latestSatisfies
      ? ` jls ${release.installer.version} is available.`
      : ' No compatible stable installer is available.'
    throw new Error(`${lines.join(' ')}${suffix}`)
  }

  for (const line of lines) prompts.log.warn(line)
  if (!latestSatisfies) {
    prompts.log.warn('No compatible stable installer is currently available.')
    return false
  }
  prompts.log.info(`jls ${release.installer.version} is available and satisfies the requirement.`)
  const result = await updateInstallerWizard(state)
  return result === 0 ? false : false
}

async function withSkillPackage<T>(
  release: ReleaseManifest,
  name: string,
  work: (pkg: DownloadedSkillPackage) => Promise<T> | T,
): Promise<T> {
  const released = release.skills[name]
  if (!released) throw new Error(`stable release does not contain ${name}`)
  const pkg = await downloadSkillPackage(name, released)
  try {
    validatePackageMetadata(pkg)
    return await work(pkg)
  } finally {
    pkg.cleanup()
  }
}

async function chooseInstallSkills(
  release: ReleaseManifest,
  scope: Scope,
  state: WizardState,
  stepId: string,
  allowBack = true,
): Promise<NavResult<string[]>> {
  void scope
  return chooseMany(
    state,
    stepId,
    'Select skills to install.',
    Object.keys(release.skills).sort().map((name) => ({
      value: name,
      label: displaySkillName(name),
    })),
    { allowBack },
  )
}

async function chooseAgents(
  explicit: string[],
  state: WizardState,
  stepId: string,
  allowBack = true,
): Promise<NavResult<{ values: string[]; prompted: boolean; all: AgentInfo[] }>> {
  const all = detectedAgents()
  if (explicit.length > 0) return { values: normalizeAgents(explicit), prompted: false, all }

  if (!process.stdin.isTTY) {
    const detected = all.filter((item) => item.detected).map((item) => item.id)
    if (detected.length === 0) throw new Error('no supported harness detected; specify --agent')
    return { values: detected, prompted: false, all }
  }

  const values = await chooseMany(
    state,
    stepId,
    'Which AI harnesses should receive these skills?',
    all.map((item) => ({ value: item.id, label: item.label })),
    { allowBack },
  )
  if (values === BACK_SIGNAL) return BACK_SIGNAL
  return { values: normalizeAgents(values), prompted: true, all }
}

function instructionFiles(agents: string[], scope: Scope): string[] {
  return [...new Set(agents.map((agent) => basename(agentPaths(agent, scope).instruction)))]
}

function instructionExplanation(agents: string[], scope: Scope): { title: string; body: string } {
  const files = instructionFiles(agents, scope)
  const fileText = humanList(files)
  const body = files.length === 1
    ? `The ${fileText} file contains general instructions that your selected AI tool reads automatically. jls can add managed sections for whichever skills you choose below without changing the rest of the file.`
    : `${fileText} files contain general instructions that your selected AI tools read automatically. jls can add managed sections for whichever skills you choose below without changing the rest of those files.`
  return { title: 'About AI Instruction Files', body }
}

async function chooseInstructionInjection(
  state: WizardState,
  stepId: string,
  agents: string[],
  scope: Scope,
  skills: string[],
  allowBack = true,
): Promise<NavResult<string[]>> {
  ensureIntro(state)
  const explanation = instructionExplanation(agents, scope)
  prompts.note(explanation.body, explanation.title)
  const files = humanList(instructionFiles(agents, scope))
  return chooseMany(
    state,
    stepId,
    `Which skills would you like to add to ${files}?`,
    skills.map((skill) => ({ value: skill, label: displaySkillName(skill) })),
    { allowBack, required: false },
  )
}

function installationSummary(
  scope: Scope,
  skills: string[],
  agents: string[],
  injectedSkills: string[],
  allAgents: AgentSpec[],
): string {
  const skillNames = skills.map(displaySkillName)
  const harnessNames = agents.map((id) => agentLabel(id, allAgents))
  const files = instructionFiles(agents, scope)
  const injectedNames = injectedSkills.map(displaySkillName)
  const injectionLines = injectedNames.length > 0
    ? files.map((file) => `${file} → ${injectedNames.join(', ')}`)
    : ['None']
  return [
    'Skills to install',
    indentedCommaList(skillNames),
    '',
    'Installation location',
    indentedLineList([scopeDisplay(scope)]),
    '',
    'Affected AI harnesses',
    indentedCommaList(harnessNames),
    '',
    'Instruction injection',
    indentedLineList(injectionLines),
  ].join('\n')
}

function updateSummary(groups: InstallGroup[], available: AvailableSkillVersions): string {
  const skillLines = groups.map((group) => `${displaySkillName(group.skill)}  ${updateStatus(group, available)}`)
  const harnesses = [...new Set(groups.flatMap((group) => group.targets.map((target) => agentLabel(target.agent))))]
  return [
    'Skills to update',
    indentedLineList(skillLines),
    '',
    'Update location',
    indentedLineList([...new Set(groups.map((group) => scopeDisplay(group.scope)))]),
    '',
    'Affected AI harnesses',
    indentedCommaList(harnesses),
  ].join('\n')
}

function uninstallSummary(groups: InstallGroup[]): string {
  const skillNames = [...new Set(groups.map((group) => displaySkillName(group.skill)))]
  const locations = [...new Set(groups.map((group) => scopeDisplay(group.scope)))]
  const harnessNames = [...new Set(groups.flatMap((group) => group.targets.map((target) => agentLabel(target.agent))))]
  return [
    'Skills to uninstall',
    indentedCommaList(skillNames),
    '',
    'Uninstall location',
    indentedLineList(locations),
    '',
    'Affected AI harnesses',
    indentedCommaList(harnessNames),
  ].join('\n')
}

function targetsForNewInstall(agents: string[], instructions: boolean): InstallTarget[] {
  return agents.map((agent) => ({ agent, instructions }))
}

function targetsForUpdate(group: InstallGroup, override?: boolean): InstallTarget[] {
  return group.targets.map((target) => ({
    agent: target.agent,
    instructions: override ?? target.instructions,
  }))
}

async function installAtScope(
  scope: Scope,
  skills: string[],
  explicitAgents: string[],
  instructionOverride: boolean | undefined,
  state: WizardState,
  stepPrefix: string,
  allowBack = true,
  askInstructions = true,
): Promise<InstallResult> {
  const release = await fetchAvailableSkills(state)
  const availableVersions = stableVersions(release)
  let selectedSkills = skills

  skillStep:
  while (true) {
    if (selectedSkills.length === 0) {
      const chosen = await chooseInstallSkills(release, scope, state, `${stepPrefix}.skills`, allowBack)
      if (chosen === BACK_SIGNAL) return BACK_SIGNAL
      selectedSkills = chosen
    }
    requireReleasedSkills(release, selectedSkills)
    if (!await ensureSkillCompatibility(release, selectedSkills, state)) return HOME

    agentStep:
    while (true) {
      const agentChoice = await chooseAgents(explicitAgents, state, `${stepPrefix}.harnesses`, allowBack)
      if (agentChoice === BACK_SIGNAL) {
        if (skills.length > 0) return BACK_SIGNAL
        selectedSkills = []
        continue skillStep
      }

      instructionStep:
      while (true) {
        let injectedSkills: string[]
        if (instructionOverride === true) injectedSkills = [...selectedSkills]
        else if (instructionOverride === false) injectedSkills = []
        else if (askInstructions && process.stdin.isTTY) {
          const choice = await chooseInstructionInjection(
            state,
            `${stepPrefix}.instructions`,
            agentChoice.values,
            scope,
            selectedSkills,
            true,
          )
          if (choice === BACK_SIGNAL) continue agentStep
          injectedSkills = choice
        } else injectedSkills = []

        const prompted = !!process.stdin.isTTY && (
          skills.length === 0
          || explicitAgents.length === 0
          || (askInstructions && instructionOverride === undefined)
        )

        if (!prompted) {
          console.log(`Scope: ${scope.identity}`)
          console.log(`Agents: ${agentChoice.values.join(', ')}`)
          console.log(`Skills: ${selectedSkills.join(', ')}`)
          console.log(`Instruction skills: ${injectedSkills.join(', ') || 'none'}`)
          for (const skill of selectedSkills) {
            await withSkillPackage(release, skill, (pkg) => installTargets(
              pkg,
              scope,
              targetsForNewInstall(agentChoice.values, injectedSkills.includes(skill)),
              false,
              'install',
            ))
          }
          return 0
        }

        confirmationStep:
        while (true) {
          prompts.note(
            installationSummary(scope, selectedSkills, agentChoice.values, injectedSkills, agentChoice.all),
            'Installation Summary',
          )
          const proceed = await chooseConfirmation(state, `${stepPrefix}.confirm`, { allowBack: true })
          if (proceed === BACK_SIGNAL || !proceed) continue instructionStep

          const plannedStates = installPreflight(scope, selectedSkills, agentChoice.values, injectedSkills, availableVersions)
          const alreadyInstalled = satisfiedSkills(plannedStates)
          if (alreadyInstalled.length > 0) {
            prompts.note(
              alreadyInstalled.map(displaySkillName).join(', '),
              'The Following Skills Have Already Been Installed',
            )
          }

          const stale = staleSkills(plannedStates)
          let approvedStaleSkills = new Set<string>()
          if (stale.length > 0) {
            prompts.log.warn('Some selected skills are already installed but out of date.')
            const selected = await chooseMany(
              state,
              `${stepPrefix}.existing-updates`,
              'Which would you like to update instead?',
              stale.map((group) => ({ value: group.skill, label: staleInstallLabel(group) })),
              { allowBack: true, required: false },
            )
            if (selected === BACK_SIGNAL) continue confirmationStep
            approvedStaleSkills = new Set(selected)
          }

          const actionable = plannedStates.filter((target) => (
            target.state === 'missing'
            || target.state === 'configure'
            || (target.state === 'stale' && approvedStaleSkills.has(target.skill))
          ))
          const continuingSkills = selectedSkills.filter((skill) => (
            actionable.some((target) => target.skill === skill)
          ))

          if (continuingSkills.length === 0) {
            prompts.log.info('There is nothing to install.')
            return HOME
          }

          if (alreadyInstalled.length > 0) {
            prompts.log.info(`Installation will continue for: ${continuingSkills.map(displaySkillName).join(', ')}.`)
          }

          for (const skill of continuingSkills) {
            const skillStates = plannedStates.filter((target) => target.skill === skill)
            const missingAgents = skillStates.filter((target) => target.state === 'missing').map((target) => target.agent)
            const configureTargets = skillStates.filter((target) => target.state === 'configure')
            const updateAgents = skillStates
              .filter((target) => target.state === 'stale' && approvedStaleSkills.has(skill))
              .map((target) => target.agent)

            await withSkillPackage(release, skill, (pkg) => {
              if (missingAgents.length > 0) {
                installTargets(
                  pkg,
                  scope,
                  targetsForNewInstall(missingAgents, injectedSkills.includes(skill)),
                  true,
                  'install',
                )
              }
              for (const target of configureTargets) {
                configureInstruction(pkg, scope, target.agent, target.requestedInstructions, true)
              }
              if (updateAgents.length > 0) {
                installTargets(
                  pkg,
                  scope,
                  targetsForNewInstall(updateAgents, injectedSkills.includes(skill)),
                  true,
                  'update',
                )
              }
            })
          }
          return 0
        }
      }
    }
  }
}

async function installWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'install')
  const state = newWizardState()

  if (parsed.scope) {
    const scope = resolveScope(parsed.scope)
    if (parsed.skills.length === 0 && !process.stdin.isTTY) throw new Error('no skills selected')
    const askInstructions = parsed.instructions === undefined && process.stdin.isTTY
    const result = await installAtScope(
      scope,
      parsed.skills,
      parsed.agents,
      parsed.instructions,
      state,
      `install.${scope.kind}:${scope.identity}`,
      false,
      askInstructions,
    )
    if (result === BACK_SIGNAL) cancel()
    if (result === HOME) return 0
    return result
  }

  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const scope = await chooseScope(state, 'install.scope', 'Where would you like to install skills?', false)
    if (scope === BACK_SIGNAL) cancel()
    const result = await installAtScope(
      scope,
      parsed.skills,
      parsed.agents,
      parsed.instructions,
      state,
      `install.${scope.kind}:${scope.identity}`,
      true,
      true,
    )
    if (result === BACK_SIGNAL) continue
    if (result === HOME) return 0
    return result
  }
}

async function updateAtScope(
  scope: Scope,
  skills: string[],
  explicitAgents: string[],
  instructionOverride: boolean | undefined,
  state: WizardState,
  stepPrefix: string,
): Promise<UpdateResult> {
  const release = requireRelease(await fetchStableReleaseManifest())
  const availableVersions = stableVersions(release)
  const parsed: ParsedAction = { skills, scope: scope.identity, agents: explicitAgents, instructions: instructionOverride }

  while (true) {
    let groups = matchingGroups(parsed, scope)
    if (skills.length === 0) {
      if (!process.stdin.isTTY) throw new Error('no skills selected for update')
      const installed = discoverInstallations(scope)
      if (installed.length === 0) {
        prompts.log.warn('No skills were detected. Choose a different scope or path.')
        return BACK_SIGNAL
      }

      prompts.log.step('Checking for updates...')
      const available = installed.filter((group) => updateAvailable(group, availableVersions))
      if (available.length === 0) {
        prompts.log.warn('All skills are already up to date. Choose a different scope or path.')
        return BACK_SIGNAL
      }

      const skillWidth = Math.max(...available.map((group) => displaySkillName(group.skill).length))
      const selected = await chooseMany(
        state,
        `${stepPrefix}.skills`,
        'The following skill updates were found. Which would you like to install?',
        available.map((group) => ({
          value: group.skill,
          label: `${displaySkillName(group.skill).padEnd(skillWidth)}  ${updateStatus(group, availableVersions)}`,
        })),
        { allowBack: true },
      )
      if (selected === BACK_SIGNAL) return BACK_SIGNAL
      groups = available.filter((group) => selected.includes(group.skill))
    }

    if (groups.length === 0) throw new Error('no installations match update filters')
    requireReleasedSkills(release, groups.map((group) => group.skill))
    for (const group of groups) {
      const released = release.skills[group.skill]
      for (const installed of installedVersions(group)) {
        try {
          if (compareVersions(installed, released.version) > 0) {
            throw new Error(`${group.skill} ${installed} is newer than stable ${released.version}; refusing to downgrade`)
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('refusing to downgrade')) throw error
        }
      }
    }
    if (!await ensureSkillCompatibility(release, groups.map((group) => group.skill), state)) return HOME

    if (process.stdin.isTTY) {
      prompts.note(updateSummary(groups, availableVersions), 'Update Summary')
      const proceed = await chooseConfirmation(state, `${stepPrefix}.confirm`, { allowBack: true })
      if (proceed === BACK_SIGNAL || !proceed) {
        if (skills.length > 0) return BACK_SIGNAL
        continue
      }
    }

    for (const group of groups) {
      await withSkillPackage(release, group.skill, (pkg) => installTargets(
        pkg,
        group.scope,
        targetsForUpdate(group, instructionOverride),
        !!process.stdin.isTTY,
        'update',
      ))
    }
    return 0
  }
}

async function updateWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'update')
  const state = newWizardState()

  if (parsed.scope) {
    const scope = resolveScope(parsed.scope)
    const result = await updateAtScope(
      scope,
      parsed.skills,
      parsed.agents,
      parsed.instructions,
      state,
      `update.${scope.kind}:${scope.identity}`,
    )
    if (result === BACK_SIGNAL) cancel()
    if (result === HOME) return 0
    return result
  }

  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const scope = await chooseScope(state, 'update.scope', 'Where would you like to update skills?', false)
    if (scope === BACK_SIGNAL) cancel()
    const result = await updateAtScope(
      scope,
      parsed.skills,
      parsed.agents,
      parsed.instructions,
      state,
      `update.${scope.kind}:${scope.identity}`,
    )
    if (result === BACK_SIGNAL) continue
    if (result === HOME) return 0
    return result
  }
}

async function chooseUninstallSkills(
  scope: Scope,
  state: WizardState,
  stepId: string,
): Promise<NavResult<InstallGroup[]>> {
  const available = discoverInstallations(scope)
  if (available.length === 0) {
    prompts.log.warn('No skills were detected. Choose a different scope or path.')
    return BACK_SIGNAL
  }
  const selected = await chooseMany(
    state,
    stepId,
    'Select skills to uninstall.',
    available.map((group) => ({ value: group.skill, label: displaySkillName(group.skill) })),
    { allowBack: true },
  )
  if (selected === BACK_SIGNAL) return BACK_SIGNAL
  return available.filter((group) => selected.includes(group.skill))
}

async function uninstallAtScope(
  scope: Scope,
  skills: string[],
  explicitAgents: string[],
  state: WizardState,
  stepPrefix: string,
): Promise<NavResult<number>> {
  const parsed: ParsedAction = { skills, scope: scope.identity, agents: explicitAgents }
  while (true) {
    let groups = matchingGroups(parsed, scope)
    if (skills.length === 0) {
      if (!process.stdin.isTTY) throw new Error('no skills selected for uninstall')
      const selected = await chooseUninstallSkills(scope, state, `${stepPrefix}.skills`)
      if (selected === BACK_SIGNAL) return BACK_SIGNAL
      groups = selected
    }
    if (groups.length === 0) throw new Error('no installations match uninstall filters')

    if (process.stdin.isTTY) {
      prompts.note(uninstallSummary(groups), 'Uninstall Summary')
      const proceed = await chooseConfirmation(state, `${stepPrefix}.confirm`, { allowBack: true, safeDefault: true })
      if (proceed === BACK_SIGNAL || !proceed) {
        if (skills.length > 0) return BACK_SIGNAL
        continue
      }
    }

    for (const group of groups) uninstallGroup(group, !!process.stdin.isTTY)
    return 0
  }
}

async function uninstallWizard(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'uninstall')
  const state = newWizardState()

  if (parsed.scope) {
    const scope = resolveScope(parsed.scope)
    const result = await uninstallAtScope(
      scope,
      parsed.skills,
      parsed.agents,
      state,
      `uninstall.${scope.kind}:${scope.identity}`,
    )
    if (result === BACK_SIGNAL) cancel()
    return result
  }

  if (!process.stdin.isTTY) throw new Error('--scope is required in non-interactive mode')
  while (true) {
    const scope = await chooseScope(state, 'uninstall.scope', 'Where would you like to uninstall skills?', false)
    if (scope === BACK_SIGNAL) cancel()
    const result = await uninstallAtScope(
      scope,
      parsed.skills,
      parsed.agents,
      state,
      `uninstall.${scope.kind}:${scope.identity}`,
    )
    if (result === BACK_SIGNAL) continue
    return result
  }
}

function generatedDataPath(scope: Scope, manifest: Manifest, entry: GeneratedDataSpec): string {
  validateGeneratedData(manifest)
  return canonicalPath(join(scope.root, entry.path))
}

function generatedDataAtScope(scope: Scope): GeneratedDataGroup[] {
  const groups: GeneratedDataGroup[] = []
  for (const manifest of cachedManifests()) {
    const detected: string[] = []
    for (const entry of manifest.generated_data ?? []) {
      const path = generatedDataPath(scope, manifest, entry)
      if (!existsSync(path)) continue
      if (entry.marker && !existsSync(join(path, entry.marker))) continue
      detected.push(path)
    }
    if (detected.length > 0) groups.push({ skill: manifest.name, paths: detected })
  }
  return groups
}

function generatedDataSummary(groups: GeneratedDataGroup[]): string {
  const lines: string[] = []
  for (const group of groups) {
    lines.push(displaySkillName(group.skill))
    lines.push(indentedLineList(group.paths))
    lines.push('')
  }
  lines.push('This data will be permanently deleted and cannot be recovered.')
  return lines.join('\n').trim()
}

async function removeSkillGeneratedDataWizard(state: WizardState): Promise<NavResult<number>> {
  while (true) {
    const scope = await chooseScope(
      state,
      'generated-data.scope',
      'Where would you like to remove skill-generated data?',
      true,
    )
    if (scope === BACK_SIGNAL) return BACK_SIGNAL

    const available = generatedDataAtScope(scope)
    if (available.length === 0) {
      prompts.log.warn('No skill-generated data was detected. Choose a different scope or path.')
      continue
    }

    while (true) {
      const selected = await chooseMany(
        state,
        `generated-data.${scope.kind}:${scope.identity}.skills`,
        'Which skills would you like to remove generated data for?',
        available.map((group) => ({ value: group.skill, label: displaySkillName(group.skill) })),
        { allowBack: true },
      )
      if (selected === BACK_SIGNAL) break
      const groups = available.filter((group) => selected.includes(group.skill))
      prompts.note(generatedDataSummary(groups), 'Permanent Data Removal')
      const proceed = await chooseConfirmation(
        state,
        `generated-data.${scope.kind}:${scope.identity}.confirm`,
        { allowBack: true, safeDefault: true },
      )
      if (proceed === BACK_SIGNAL || !proceed) continue

      for (const group of groups) {
        for (const path of group.paths) rmSync(path, { recursive: true, force: true })
        prompts.log.step(`Removed ${displaySkillName(group.skill)}-generated data`)
      }
      prompts.outro('Skill-generated data removed')
      return 0
    }
  }
}

function installerExecutable(): string {
  if (!Bun.isStandaloneExecutable) {
    throw new Error('installer management is only available from the compiled jls executable')
  }
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
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return
  }

  const child = spawn('/bin/sh', [
    '-c',
    'sleep 1; rm -rf -- "$1"; rm -f -- "$2"',
    'jls-uninstall',
    dataRoot,
    executable,
  ], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function updateInstallerWizard(state: WizardState): Promise<UpdateResult> {
  ensureIntro(state)
  const executable = installerExecutable()
  prompts.log.step('Checking for updates...')
  const update = await checkInstallerUpdate(VERSION)
  if (!update) {
    prompts.log.warn('No updates found.')
    return HOME
  }

  prompts.note([
    'Current version',
    indentedLineList([VERSION]),
    '',
    'Available version',
    indentedLineList([update.version]),
  ].join('\n'), 'Update Summary')

  const proceed = await chooseConfirmation(state, 'installer-update.confirm', { allowBack: true })
  if (proceed === BACK_SIGNAL || !proceed) return BACK_SIGNAL

  prompts.log.step('Downloading update...')
  const staged = await stageInstallerUpdate(executable, update)
  scheduleInstallerReplacement(staged, executable)
  prompts.outro('jls installer update scheduled')
  return 0
}

async function uninstallInstallerWizard(state: WizardState): Promise<NavResult<number>> {
  ensureIntro(state)
  const executable = installerExecutable()
  prompts.log.warn('This action will uninstall the jls installer and any associated installer-owned data and tooling.')
  const proceed = await chooseConfirmation(state, 'installer-uninstall.confirm', { allowBack: true, safeDefault: true })
  if (proceed === BACK_SIGNAL || !proceed) return BACK_SIGNAL

  scheduleInstallerUninstall(executable, installerDataRoot())
  return 0
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
        { value: 'install', label: 'Install skills' },
        { value: 'update', label: 'Update skills' },
        { value: 'uninstall', label: 'Uninstall skills' },
        { value: 'generated-data', label: 'Remove skill-generated data' },
        { value: 'installer-update', label: 'Update jls installer' },
        { value: 'installer-uninstall', label: 'Uninstall jls installer' },
      ],
      { allowBack: false, initialValue: 'install' },
    )
    if (choice === BACK_SIGNAL) continue

    if (choice === 'installer-update') {
      const result = await updateInstallerWizard(state)
      if (result === BACK_SIGNAL || result === HOME) continue
      return result
    }
    if (choice === 'installer-uninstall') {
      const result = await uninstallInstallerWizard(state)
      if (result === BACK_SIGNAL) continue
      return result
    }
    if (choice === 'generated-data') {
      const result = await removeSkillGeneratedDataWizard(state)
      if (result === BACK_SIGNAL) continue
      return result
    }

    const scopeQuestion = choice === 'install'
      ? 'Where would you like to install skills?'
      : choice === 'update'
        ? 'Where would you like to update skills?'
        : 'Where would you like to uninstall skills?'

    while (true) {
      const scope = await chooseScope(state, `${choice}.scope`, scopeQuestion, true)
      if (scope === BACK_SIGNAL) break
      const stepPrefix = `${choice}.${scope.kind}:${scope.identity}`

      const result = choice === 'install'
        ? await installAtScope(scope, [], [], undefined, state, stepPrefix, true, true)
        : choice === 'update'
          ? await updateAtScope(scope, [], [], undefined, state, stepPrefix)
          : await uninstallAtScope(scope, [], [], state, stepPrefix)

      if (result === HOME) break
      if (result === BACK_SIGNAL) continue
      return result
    }
  }
}

function printHelp(): void {
  console.log(`jls\n\nUsage:\n  jls install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jls update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jls uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n\nSkill-first invocations continue to mean install. Interactive prompts use @clack/prompts ${PROMPTS_VERSION}.\n`)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0) return bareWizard()
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jls ${VERSION}`)
    return 0
  }
  if (args.some((arg: string) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateWizard(args)
  if (args[0] === 'uninstall') return uninstallWizard(args)
  return installWizard(args)
}

main()
  .then((exitCode) => { process.exitCode = exitCode })
  .catch((error) => {
    console.error(`jls: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
