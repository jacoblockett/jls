import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { platform } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import {
  HARNESS_ADAPTERS,
  harnessAdapter,
  normalizeHarnessId,
  type HarnessPaths,
} from './harnesses'
import { classifyInstallTargets, staleUpdateTargets, type InstallTargetState } from './install-preflight'
import {
  downloadSkillPackage,
  fetchStableReleaseManifest,
  packageToolFiles,
  packageTools,
  parseSkillPackageManifest,
  type DownloadedSkillPackage,
  type ReleaseManifest,
  type SkillPackageManifest,
} from './installer-updater'
import { detectInstallCollisions } from './install-collision-override'
import { containerAncestors, pruneEmptyContainers } from './container-pruning'
import { displayManagedPath } from './display-path'
import {
  cachedManifestPath,
  canonicalPath,
  normalizedPath,
  skillMetadataRoot,
  userHome,
} from './installer-paths'
import { removeLegacyOwnershipMarker } from './legacy-ownership'
import { renderResource } from './resource-render'
import { compiledTarget } from './targets'
const VERSION = process.env.JLS_BUILD_VERSION?.trim() || '0.0.0'
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


function toolMetaRoot(scopeRoot: string): string {
  return join(scopeRoot, '.jls')
}

function skillToolRoot(scopeRoot: string, skill: string): string {
  return join(toolMetaRoot(scopeRoot), skill)
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
  return HARNESS_ADAPTERS
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

function removeFile(path: string): void {
  if (existsSync(path) && statSync(path).isFile()) rmSync(path, { force: true })
}

function managedMarkers(skill: string): { begin: string; end: string } {
  return { begin: `<!-- jls:begin ${skill} -->`, end: `<!-- jls:end ${skill} -->` }
}

function managedBlockPresent(path: string, skill: string): boolean {
  if (!existsSync(path) || !statSync(path).isFile()) return false
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
  if (!existsSync(path) || !statSync(path).isFile()) return
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

function cachedPackageManifest(skill: string): Manifest | undefined {
  const path = cachedManifestPath(skill)
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  try {
    const manifest = parseSkillPackageManifest(JSON.parse(readFileSync(path, 'utf8')))
    return manifest.name === skill ? manifest : undefined
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

function skillFilesPresent(skillPath: string): boolean {
  const manifest = installedPackageManifest(skillPath)
  if (!manifest) return false
  return manifest.skill_files.every((rel) => {
    const path = join(skillPath, rel)
    return existsSync(path) && statSync(path).isFile()
  })
}

function harnessResourcesPresent(skillPath: string, agent: string, scope: Scope): boolean {
  const manifest = installedPackageManifest(skillPath)
  if (!manifest) return false
  return harnessResourceTargets(manifest, agent, scope).every(({ destination }) => (
    existsSync(destination) && statSync(destination).isFile()
  ))
}

function removeHarnessResources(manifest: Manifest, agent: string, scope: Scope): void {
  for (const { destination } of harnessResourceTargets(manifest, agent, scope)) removeFile(destination)
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
  for (const agent of HARNESS_ADAPTERS) {
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

function toolArtifact(manifest: Manifest, toolName: string): string {
  const tool = packageTools(manifest)[toolName]
  if (!tool) throw new Error(`${manifest.name} manifest is missing tool ${toolName}`)
  const target = compiledTarget().key
  const artifact = tool.artifacts[target] ?? tool.artifacts.portable
  if (!artifact) throw new Error(`${manifest.name} tool ${toolName} has no bundled artifact for ${target}`)
  return artifact
}

function toolExecutablePath(manifest: Manifest, scope: Scope, toolName: string): string {
  return join(skillToolRoot(scope.root, manifest.name), 'bin', basename(toolArtifact(manifest, toolName)))
}

function installedToolFiles(manifest: Manifest, scope: Scope): string[] {
  const root = skillToolRoot(scope.root, manifest.name)
  return [
    ...Object.keys(packageTools(manifest)).map((name) => toolExecutablePath(manifest, scope, name)),
    ...packageToolFiles(manifest).map((rel) => join(root, rel)),
  ]
}

function toolTokens(manifest: Manifest, scope: Scope): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const [name, tool] of Object.entries(packageTools(manifest))) {
    if (!tool.token) continue
    tokens[`{{${tool.token}}}`] = normalize(toolExecutablePath(manifest, scope, name))
  }
  return tokens
}

function previousManifestForSkill(scope: Scope, skill: string): Manifest | undefined {
  // Installed metadata in this scope is authoritative. The global cache is only a
  // recovery fallback when no matching installed manifest survives locally.
  for (const group of discoverInstallations(scope)) {
    if (group.skill !== skill) continue
    for (const target of group.targets) {
      const manifest = installedPackageManifest(target.skillPath)
      if (manifest?.name === skill) return manifest
    }
  }
  return cachedPackageManifest(skill)
}

function removeLegacyOwnershipMarkers(manifest: Manifest, scope: Scope): void {
  // Legacy marker cleanup is migration-only. A matching filename alone never
  // establishes ownership, so foreign or malformed files are preserved.
  removeLegacyOwnershipMarker(
    join(toolMetaRoot(scope.root), '.jls-owned.json'),
    { kind: 'runtime-root' },
  )
  removeLegacyOwnershipMarker(
    join(skillToolRoot(scope.root, manifest.name), '.jls-owned.json'),
    { kind: 'skill-runtime', skill: manifest.name },
  )
  for (const spec of manifest.generated_data ?? []) {
    removeLegacyOwnershipMarker(
      join(scope.root, spec.path, '.jls-owned.json'),
      { kind: 'generated-data', skill: manifest.name },
    )
  }
}

function removeObsoleteToolFiles(previous: Manifest | undefined, next: Manifest, scope: Scope): void {
  if (!previous) return
  const nextFiles = new Set(installedToolFiles(next, scope).map((path) => normalizedPath(resolve(path))))
  for (const path of installedToolFiles(previous, scope)) {
    if (!nextFiles.has(normalizedPath(resolve(path)))) removeFile(path)
  }
}

function removeObsoleteSkillFiles(previous: Manifest, next: Manifest, destination: string): void {
  const nextFiles = new Set(next.skill_files.map((rel) => normalizedPath(normalize(rel))))
  for (const rel of previous.skill_files) {
    if (!nextFiles.has(normalizedPath(normalize(rel)))) removeFile(join(destination, rel))
  }
}

function removeSkillFiles(manifest: Manifest, destination: string): void {
  for (const rel of manifest.skill_files) removeFile(join(destination, rel))
  removeFile(join(destination, 'manifest.json'))
}

function renderInstructionFragment(
  pkg: DownloadedSkillPackage,
  tokens: Record<string, string>,
): string {
  const manifest = pkg.manifest
  if (!manifest.instruction_fragment) return ''
  return renderResource(
    readFileSync(join(pkg.root, manifest.instruction_fragment), 'utf8'),
    tokens,
    manifest.instruction_fragment,
  )
}

function assertInstallCollisions(pkg: DownloadedSkillPackage, scope: Scope, targets: InstallTarget[]): void {
  const collisions = detectInstallCollisions(pkg, scope, targets.map((target) => target.agent))
  if (collisions.length === 0) return
  const paths = collisions.map((collision) => displayManagedPath(scope.root, collision.path)).join(', ')
  throw new Error(`installation collides with existing file/path: ${paths}`)
}

function provisionTools(
  pkg: DownloadedSkillPackage,
  scope: Scope,
  previous: Manifest | undefined,
): Record<string, string> {
  const manifest = pkg.manifest
  removeObsoleteToolFiles(previous, manifest, scope)
  removeLegacyOwnershipMarkers(previous ?? manifest, scope)

  const root = skillToolRoot(scope.root, manifest.name)
  for (const name of Object.keys(packageTools(manifest))) {
    const artifact = toolArtifact(manifest, name)
    const executable = toolExecutablePath(manifest, scope, name)
    copyPackageEntry(join(pkg.root, artifact), executable)
    try { chmodSync(executable, 0o755) } catch {}
  }
  for (const rel of packageToolFiles(manifest)) {
    copyPackageEntry(join(pkg.root, rel), join(root, rel))
  }
  return toolTokens(manifest, scope)
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
  const previousPackage = previousManifestForSkill(scope, pkg.manifest.name)
  const tokens = provisionTools(pkg, scope, previousPackage)
  const fragment = renderInstructionFragment(pkg, tokens)

  for (const target of targets) {
    const paths = agentPaths(target.agent, scope)
    const dest = join(paths.skillRoot, pkg.manifest.name)
    const previous = installedPackageManifest(dest)
    if (previous) {
      removeHarnessResources(previous, target.agent, scope)
      removeObsoleteSkillFiles(previous, pkg.manifest, dest)
    }
    mkdirSync(dest, { recursive: true })
    for (const rel of pkg.manifest.skill_files) copyPackageEntry(join(pkg.root, rel), join(dest, rel), tokens)
    copyPackageEntry(join(pkg.root, 'manifest.json'), join(dest, 'manifest.json'))
    installHarnessResources(pkg, target.agent, scope, tokens)
    if (target.instructions && fragment) managedBlock(paths.instruction, pkg.manifest.name, fragment)
    else removeManagedBlock(paths.instruction, pkg.manifest.name)

    const verb = action === 'update' ? 'Updated' : 'Installed'
    console.log(`${verb} ${pkg.manifest.name} ${pkg.manifest.version} for ${target.agent} at ${displayManagedPath(scope.root, dest)}`)
  }

  removeLegacyOwnershipMarkers(pkg.manifest, scope)
  cachePackageManifest(pkg)
}

function configureInstruction(pkg: DownloadedSkillPackage, scope: Scope, target: InstallTargetState): void {
  const paths = agentPaths(target.agent, scope)
  assertManagedBlockWritable(paths.instruction, pkg.manifest.name)
  if (target.requestedInstructions) {
    const fragment = renderInstructionFragment(pkg, toolTokens(pkg.manifest, scope))
    if (!fragment) throw new Error(`${pkg.manifest.name} does not provide managed instructions`)
    managedBlock(paths.instruction, pkg.manifest.name, fragment)
  } else {
    removeManagedBlock(paths.instruction, pkg.manifest.name)
  }
  console.log(`Configured ${pkg.manifest.name} for ${target.agent}`)
}

function uninstallGroup(group: InstallGroup): void {
  let toolManifest: Manifest | undefined
  for (const target of group.targets) {
    const manifest = installedPackageManifest(target.skillPath)
    if (!manifest || manifest.name !== group.skill) {
      throw new Error(`refusing to uninstall skill path without its matching manifest: ${displayManagedPath(group.scope.root, target.skillPath)}`)
    }
    if (installedToolFiles(manifest, group.scope).length > 0 && !toolManifest) toolManifest = manifest
    const paths = agentPaths(target.agent, group.scope)
    const resourceContainers = harnessResourceTargets(manifest, target.agent, group.scope)
      .map(({ destination }) => dirname(destination))
    const skillContainers = manifest.skill_files.flatMap((rel) => (
      containerAncestors(join(target.skillPath, rel), target.skillPath)
    ))

    removeHarnessResources(manifest, target.agent, group.scope)
    removeSkillFiles(manifest, target.skillPath)
    removeManagedBlock(target.instructionPath, group.skill)
    removeLegacyOwnershipMarkers(manifest, group.scope)
    pruneEmptyContainers([
      ...skillContainers,
      target.skillPath,
      paths.skillRoot,
      ...resourceContainers,
    ])
    console.log(`Uninstalled ${group.skill} for ${target.agent} from ${displayManagedPath(group.scope.root, group.scope.root)}`)
  }

  if (!discoverInstallations(group.scope).some((candidate) => candidate.skill === group.skill)) {
    const manifest = toolManifest ?? cachedPackageManifest(group.skill)
    if (manifest) {
      const files = installedToolFiles(manifest, group.scope)
      for (const path of files) removeFile(path)
      removeLegacyOwnershipMarkers(manifest, group.scope)
      const toolRoot = skillToolRoot(group.scope.root, manifest.name)
      pruneEmptyContainers([
        ...files.flatMap((path) => containerAncestors(path, toolRoot)),
        toolRoot,
        toolMetaRoot(group.scope.root),
      ])
    }
    removeFile(cachedManifestPath(group.skill))
    pruneEmptyContainers([skillMetadataRoot()])
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

function ensureReleased(release: ReleaseManifest, skills: string[]): void {
  for (const skill of skills) {
    if (!release.skills[skill]) throw new Error(`stable release does not contain ${skill}`)
  }
}

async function installCommand(args: string[]): Promise<number> {
  const parsed = parseAction(args, 'install')
  const scope = requireScope(parsed)
  if (parsed.skills.length === 0) throw new Error('no skills selected')

  const release = requireRelease(await fetchStableReleaseManifest())
  ensureReleased(release, parsed.skills)
  const agents = parsed.agents.length > 0 ? normalizeAgents(parsed.agents) : detectedAgents()
  if (agents.length === 0) throw new Error('no supported AI harness detected; specify --agent')

  const requestedInstructions = Object.fromEntries(parsed.skills.map((skill) => [skill, parsed.instructions ?? false]))
  const installedTargets = discoverInstallations(scope).flatMap((group) => group.targets
    .filter((target) => (
      skillFilesPresent(target.skillPath)
      && harnessResourcesPresent(target.skillPath, target.agent, scope)
    ))
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
  const groups = matchingGroups(parsed, scope)
  if (parsed.skills.length > 0 && groups.length === 0) {
    throw new Error('no installations match update filters')
  }
  const release = requireRelease(await fetchStableReleaseManifest())

  for (const group of groups) {
    const released = release.skills[group.skill]
    if (!released) {
      if (parsed.skills.includes(group.skill)) ensureReleased(release, [group.skill])
      continue
    }
    const staleTargets = staleUpdateTargets(group.targets, released.version)
    if (staleTargets.length === 0) continue

    ensureReleased(release, [group.skill])
    const pkg = await downloadSkillPackage(group.skill, released)
    try {
      installTargets(
        pkg,
        group.scope,
        staleTargets.map((target) => ({
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
