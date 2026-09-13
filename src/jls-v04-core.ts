import { spawnSync } from 'node:child_process'
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
import {
  HARNESS_ADAPTERS,
  harnessAdapter,
  normalizeHarnessId,
  type HarnessAdapter,
  type HarnessPaths,
} from './harnesses'
import { classifyInstallTargets, type InstallTargetState } from './install-preflight'
import {
  compareVersions,
  downloadSkillPackage,
  fetchStableReleaseManifest,
  parseSkillPackageManifest,
  type DownloadedSkillPackage,
  type ReleaseManifest,
  type SkillPackageManifest,
} from './installer-updater'
import {
  assertGeneratedDataOwnership,
  assertRuntimeLayoutAvailable,
  assertVacantOrOwned,
  cleanupRuntimeMetaRoot,
  markRuntimeLayout,
  runtimeSkillOwned,
  runtimeSkillRoot,
} from './install-ownership'
import { renderResource } from './resource-render'
import { compiledTarget } from './targets'
import installerManifest from '../manifest.json'

const VERSION = installerManifest.version
const isWindows = platform() === 'win32'

type Manifest = SkillPackageManifest

type Scope = {
  kind: 'user' | 'project'
  origin: 'current' | 'global' | 'custom'
  identity: string
  root: string
}

type ParsedAction = {
  skills: string[]
  scope?: string
  agents: string[]
  instructions?: boolean
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

type InstallTarget = {
  agent: string
  instructions: boolean
}

type HarnessResourceTarget = {
  source: string
  destination: string
}

const agentCatalog: HarnessAdapter[] = HARNESS_ADAPTERS

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
  const value = normalize(path)
  if (!isWindows) return value
  return value.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
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

function cachedManifestPath(name: string): string {
  return join(skillMetadataRoot(), `${name}.json`)
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
  if (!existsSync(root)) throw new Error(`scope path does not exist: ${root}`)
  if (!statSync(root).isDirectory()) throw new Error(`scope path is not a directory: ${root}`)
  return { kind: 'project', origin: 'custom', identity: root, root }
}

function commandExists(command: string): boolean {
  return spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true }).status === 0
}

function detectedAgents(): string[] {
  return agentCatalog
    .filter((agent) => commandExists(agent.command) || agent.detectionPaths(userHome()).some(existsSync))
    .map((agent) => agent.id)
}

function normalizeAgents(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeHarnessId))].sort()
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

function copyPackageEntry(source: string, destination: string, tokens?: Record<string, string>): void {
  if (!existsSync(source)) throw new Error(`missing package asset ${source}`)
  if (statSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source)) copyPackageEntry(join(source, entry), join(destination, entry), tokens)
    return
  }
  const bytes = readFileSync(source)
  if (!tokens || Object.keys(tokens).length === 0) {
    atomicWrite(destination, bytes)
    return
  }
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

function assertManagedBlockWritable(path: string, skill: string): void {
  if (!existsSync(path)) return
  if (!statSync(path).isFile()) throw new Error(`instruction path collides with a non-file: ${path}`)
  const { begin, end } = managedMarkers(skill)
  const current = readFileSync(path, 'utf8')
  const begins = current.split(begin).length - 1
  const ends = current.split(end).length - 1
  if (begins === 0 && ends === 0) return
  if (begins !== 1 || ends !== 1 || current.indexOf(end) < current.indexOf(begin)) {
    throw new Error(`instruction file contains an ambiguous JLS ownership block: ${path}`)
  }
}

function managedBlock(path: string, skill: string, fragment: string): void {
  assertManagedBlockWritable(path, skill)
  const { begin, end } = managedMarkers(skill)
  const block = `${begin}\n${fragment.trim()}\n${end}`
  let current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const beginIndex = current.indexOf(begin)
  const endIndex = current.indexOf(end)
  if (beginIndex >= 0) current = current.slice(0, beginIndex) + block + current.slice(endIndex + end.length)
  else if (!current.trim()) current = `${block}\n`
  else current = `${current.replace(/[\r\n]+$/, '')}\n\n${block}\n`
  atomicWrite(path, current)
}

function removeManagedBlock(path: string, skill: string): void {
  if (!existsSync(path)) return
  assertManagedBlockWritable(path, skill)
  const { begin, end } = managedMarkers(skill)
  const current = readFileSync(path, 'utf8')
  const beginIndex = current.indexOf(begin)
  const endIndex = current.indexOf(end)
  if (beginIndex < 0 && endIndex < 0) return
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
  if (!manifest) return false
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

function installedVersions(group: InstallGroup): string[] {
  return [...new Set(group.targets.map((target) => target.version))].sort()
}

function runtimeCliPath(manifest: Manifest, scope: Scope): string {
  if (!manifest.runtime_cli) throw new Error(`${manifest.name} manifest is missing runtime_cli`)
  return join(runtimeSkillRoot(scope.root, manifest.name), 'bin', `${manifest.runtime_cli}${compiledTarget().executableSuffix}`)
}

function renderInstructionFragment(pkg: DownloadedSkillPackage, cli?: string): string {
  const manifest = pkg.manifest
  if (!manifest.instruction_fragment) return ''
  const tokenName = manifest.cli_token || 'JL_SKILL_CLI'
  const tokens = cli ? { [`{{${tokenName}}}`]: normalize(cli) } : {}
  return Object.entries(tokens).reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    readFileSync(join(pkg.root, manifest.instruction_fragment), 'utf8'),
  )
}

function runtimeOwnershipEvidence(scope: Scope, skill: string): { root: boolean; skill: boolean } {
  const groups = discoverInstallations(scope)
  let root = false
  let ownedSkill = false
  for (const group of groups) {
    for (const target of group.targets) {
      const manifest = installedPackageManifest(target.skillPath)
      if (!manifest?.runtime) continue
      root = true
      if (group.skill === skill) ownedSkill = true
    }
  }
  return { root, skill: ownedSkill }
}

function legacyGeneratedDataOwned(scope: Scope, skill: string, generatedPath: string): boolean {
  const wanted = normalizedPath(resolve(generatedPath))
  for (const group of discoverInstallations(scope)) {
    if (group.skill !== skill) continue
    for (const installed of group.targets) {
      const manifest = installedPackageManifest(installed.skillPath)
      if (!manifest || manifest.name !== skill) continue
      for (const spec of manifest.generated_data ?? []) {
        if (normalizedPath(resolve(scope.root, spec.path)) !== wanted || !spec.marker) continue
        const marker = join(generatedPath, spec.marker)
        if (existsSync(marker) && statSync(marker).isFile()) return true
      }
    }
  }
  return false
}

function assertInstallCollisions(pkg: DownloadedSkillPackage, scope: Scope, targets: InstallTarget[]): void {
  const skill = pkg.manifest.name

  if (pkg.manifest.runtime) {
    const legacy = runtimeOwnershipEvidence(scope, skill)
    assertRuntimeLayoutAvailable(scope.root, skill, legacy.root, legacy.skill)
  }
  assertGeneratedDataOwnership(
    scope.root,
    skill,
    pkg.manifest.generated_data,
    (target) => legacyGeneratedDataOwned(scope, skill, target),
  )

  for (const target of targets) {
    const paths = agentPaths(target.agent, scope)
    if (existsSync(paths.skillRoot) && !statSync(paths.skillRoot).isDirectory()) {
      throw new Error(`skill root collides with an existing non-directory: ${paths.skillRoot}`)
    }

    const dest = join(paths.skillRoot, skill)
    const previous = installedPackageManifest(dest)
    assertVacantOrOwned(dest, previous?.name === skill, `${target.agent} skill path`)

    const previouslyOwnedResources = new Set(
      previous
        ? harnessResourceTargets(previous, target.agent, scope).map(({ destination }) => normalizedPath(resolve(destination)))
        : [],
    )
    for (const { destination } of harnessResourceTargets(pkg.manifest, target.agent, scope)) {
      const parent = dirname(destination)
      if (existsSync(parent) && !statSync(parent).isDirectory()) {
        throw new Error(`${target.agent} resource root collides with an existing non-directory: ${parent}`)
      }
      assertVacantOrOwned(
        destination,
        previouslyOwnedResources.has(normalizedPath(resolve(destination))),
        `${target.agent} harness resource`,
      )
    }

    assertManagedBlockWritable(paths.instruction, skill)
  }
}

function provisionRuntime(pkg: DownloadedSkillPackage, scope: Scope): { cli?: string } {
  const manifest = pkg.manifest
  if (!manifest.runtime) return {}
  if (manifest.runtime !== 'rust') throw new Error(`unsupported runtime "${manifest.runtime}"`)
  if (!manifest.runtime_cli) throw new Error(`${manifest.name} manifest is missing runtime_cli`)
  const target = compiledTarget().key
  const artifact = manifest.runtime_artifacts?.[target]
  if (!artifact) throw new Error(`${manifest.name} has no bundled runtime for ${target}`)

  markRuntimeLayout(scope.root, manifest.name)
  const root = runtimeSkillRoot(scope.root, manifest.name)
  const cli = runtimeCliPath(manifest, scope)
  copyPackageEntry(join(pkg.root, artifact), cli)
  try { chmodSync(cli, 0o755) } catch {}
  for (const rel of manifest.runtime_files ?? []) copyPackageEntry(join(pkg.root, rel), join(root, rel))
  return { cli }
}

function cachePackageManifest(pkg: DownloadedSkillPackage): void {
  atomicWrite(cachedManifestPath(pkg.manifest.name), readFileSync(join(pkg.root, 'manifest.json')))
}

function installTargets(
  pkg: DownloadedSkillPackage,
  scope: Scope,
  targets: InstallTarget[],
  action: 'install' | 'update',
): void {
  assertInstallCollisions(pkg, scope, targets)
  cachePackageManifest(pkg)
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
    console.log(`${verb} ${pkg.manifest.name} ${pkg.manifest.version} for ${target.agent} at ${dest}`)
  }
}

function configureInstruction(pkg: DownloadedSkillPackage, scope: Scope, target: InstallTargetState): void {
  const paths = agentPaths(target.agent, scope)
  assertManagedBlockWritable(paths.instruction, pkg.manifest.name)
  if (target.requestedInstructions) {
    const cli = pkg.manifest.runtime ? runtimeCliPath(pkg.manifest, scope) : undefined
    const fragment = renderInstructionFragment(pkg, cli)
    if (!fragment) throw new Error(`${pkg.manifest.name} does not provide managed instructions`)
    managedBlock(paths.instruction, pkg.manifest.name, fragment)
  } else {
    removeManagedBlock(paths.instruction, pkg.manifest.name)
  }
  console.log(`Configured ${pkg.manifest.name} for ${target.agent}`)
}

function uninstallGroup(group: InstallGroup): void {
  let hadRuntime = false
  for (const target of group.targets) {
    const manifest = installedPackageManifest(target.skillPath)
    if (!manifest || manifest.name !== group.skill) {
      throw new Error(`refusing to uninstall unowned skill path: ${target.skillPath}`)
    }
    if (manifest.runtime) hadRuntime = true
    removeHarnessResources(manifest, target.agent, group.scope)
    rmSync(target.skillPath, { recursive: true, force: true })
    removeManagedBlock(target.instructionPath, group.skill)
    console.log(`Uninstalled ${group.skill} for ${target.agent} from ${group.scope.root}`)
  }

  if (!discoverInstallations(group.scope).some((candidate) => candidate.skill === group.skill)) {
    const runtimeRoot = runtimeSkillRoot(group.scope.root, group.skill)
    if (existsSync(runtimeRoot)) {
      if (!runtimeSkillOwned(group.scope.root, group.skill) && !hadRuntime) {
        throw new Error(`refusing to remove unowned runtime path: ${runtimeRoot}`)
      }
      rmSync(runtimeRoot, { recursive: true, force: true })
    }
    rmSync(cachedManifestPath(group.skill), { force: true })
    cleanupRuntimeMetaRoot(group.scope.root, hadRuntime)
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
      continue
    }
    if (arg.startsWith('--scope=')) {
      out.scope = arg.slice('--scope='.length)
      continue
    }
    if (arg === '--agent') {
      if (i + 1 >= body.length) throw new Error('--agent requires a harness name')
      out.agents.push(body[++i])
      continue
    }
    if (arg.startsWith('--agent=')) {
      out.agents.push(arg.slice('--agent='.length))
      continue
    }
    if (arg === '--instructions') {
      if (command === 'uninstall') throw new Error('--instructions is not valid for uninstall')
      out.instructions = true
      continue
    }
    if (arg === '--no-instructions') {
      if (command === 'uninstall') throw new Error('--no-instructions is not valid for uninstall')
      out.instructions = false
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown ${command} option ${arg}`)
    out.skills.push(arg)
  }
  return out
}

function requireScope(parsed: ParsedAction): Scope {
  if (!parsed.scope) throw new Error('--scope is required')
  return resolveScope(parsed.scope)
}

function requireRelease(release: ReleaseManifest | null): ReleaseManifest {
  if (!release) throw new Error('no stable JLS release is currently available')
  return release
}

function availableVersions(release: ReleaseManifest): Record<string, string> {
  return Object.fromEntries(Object.entries(release.skills).map(([name, skill]) => [name, skill.version]))
}

function ensureReleasedAndCompatible(release: ReleaseManifest, skills: string[]): void {
  for (const skill of skills) {
    const released = release.skills[skill]
    if (!released) throw new Error(`stable release does not contain ${skill}`)
    if (compareVersions(VERSION, released.min_installer) < 0) {
      throw new Error(`${skill} ${released.version} requires JLS ${released.min_installer} or newer; running ${VERSION}`)
    }
  }
}

async function installCommand(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'install')
  const scope = requireScope(parsed)
  if (parsed.skills.length === 0) throw new Error('no skills selected')

  const release = requireRelease(await fetchStableReleaseManifest())
  ensureReleasedAndCompatible(release, parsed.skills)
  const agents = parsed.agents.length > 0 ? normalizeAgents(parsed.agents) : detectedAgents()
  if (agents.length === 0) throw new Error('no supported AI harness detected; specify --agent')

  const requestedInstructions = Object.fromEntries(parsed.skills.map((skill) => [skill, parsed.instructions ?? false]))
  const installedTargets = discoverInstallations(scope).flatMap((group) => group.targets
    .filter((target) => harnessResourcesPresent(target.skillPath, target.agent, scope))
    .map((target) => ({
      skill: group.skill,
      agent: target.agent,
      version: target.version,
      instructions: target.instructions,
    })))
  const planned = classifyInstallTargets(parsed.skills, agents, availableVersions(release), requestedInstructions, installedTargets)
  const actionable = planned.filter((target) => target.state === 'missing' || target.state === 'configure')

  for (const skill of parsed.skills) {
    const states = actionable.filter((target) => target.skill === skill)
    if (states.length === 0) continue
    const pkg = await downloadSkillPackage(skill, release.skills[skill])
    try {
      const missing = states.filter((target) => target.state === 'missing')
      if (missing.length > 0) {
        installTargets(
          pkg,
          scope,
          missing.map((target) => ({ agent: target.agent, instructions: target.requestedInstructions })),
          'install',
        )
      }
      for (const target of states.filter((candidate) => candidate.state === 'configure')) {
        configureInstruction(pkg, scope, target)
      }
    } finally {
      pkg.cleanup()
    }
  }
  return 0
}

function matchingGroups(parsed: ParsedAction, scope: Scope): InstallGroup[] {
  const requestedAgents = normalizeAgents(parsed.agents)
  return discoverInstallations(scope)
    .map((group) => ({
      ...group,
      targets: requestedAgents.length > 0
        ? group.targets.filter((target) => requestedAgents.includes(target.agent))
        : group.targets,
    }))
    .filter((group) => {
      if (parsed.skills.length > 0 && !parsed.skills.includes(group.skill)) return false
      return group.targets.length > 0
    })
}

async function updateCommand(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'update')
  const scope = requireScope(parsed)
  const release = requireRelease(await fetchStableReleaseManifest())
  let groups = matchingGroups(parsed, scope)
  groups = groups.filter((group) => {
    const released = release.skills[group.skill]
    if (!released) return false
    return installedVersions(group).some((version) => compareVersions(version, released.version) < 0)
  })

  for (const group of groups) {
    ensureReleasedAndCompatible(release, [group.skill])
    const pkg = await downloadSkillPackage(group.skill, release.skills[group.skill])
    try {
      installTargets(
        pkg,
        group.scope,
        group.targets.map((target) => ({
          agent: target.agent,
          instructions: parsed.instructions ?? target.instructions,
        })),
        'update',
      )
    } finally {
      pkg.cleanup()
    }
  }
  return 0
}

async function uninstallCommand(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'uninstall')
  const scope = requireScope(parsed)
  const groups = matchingGroups(parsed, scope)
  if (groups.length === 0) throw new Error('no installations match uninstall filters')
  for (const group of groups) uninstallGroup(group)
  cleanupRuntimeMetaRoot(scope.root)
  return 0
}

function printHelp(): void {
  console.log(`jls\n\nUsage:\n  jls install [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jls update [skills...] [--scope user|cwd|PATH] [--agent AGENT]... [--instructions|--no-instructions]\n  jls uninstall [skills...] [--scope user|cwd|PATH] [--agent AGENT]...\n\nSkill-first invocations continue to mean install.\n`)
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0) throw new Error('no lifecycle command supplied')
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`jls ${VERSION}`)
    return 0
  }
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    printHelp()
    return 0
  }
  if (args[0] === 'update') return updateCommand(args)
  if (args[0] === 'uninstall') return uninstallCommand(args)
  return installCommand(args)
}

if (import.meta.main) {
  main()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      console.error(`jls: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
