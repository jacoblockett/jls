import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { HARNESS_ADAPTERS, harnessAdapter } from './harnesses'
import {
  parseSkillPackageManifest,
  type DownloadedSkillPackage,
  type SkillPackageManifest,
} from './installer-updater'
import { compiledTarget } from './targets'

export type CollisionScope = {
  kind: 'user' | 'project'
  origin: 'current' | 'global' | 'custom'
  identity: string
  root: string
}

export type InstallCollision = {
  path: string
}

type HarnessResourceTarget = {
  source: string
  destination: string
}

const isWindows = platform() === 'win32'

function normalizedPath(path: string): string {
  const value = normalize(path)
  if (!isWindows) return value
  return value.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
}

function userHome(): string {
  return normalizedPath(resolve(process.env.USERPROFILE || process.env.HOME || homedir()))
}

function runtimeSkillRoot(scopeRoot: string, skill: string): string {
  return join(scopeRoot, '.jls', skill)
}

function runtimeCliPath(manifest: SkillPackageManifest, scope: CollisionScope): string | undefined {
  if (!manifest.runtime || !manifest.runtime_cli) return undefined
  return join(
    runtimeSkillRoot(scope.root, manifest.name),
    'bin',
    `${manifest.runtime_cli}${compiledTarget().executableSuffix}`,
  )
}

function installedPackageManifest(skillPath: string): SkillPackageManifest | undefined {
  const path = join(skillPath, 'manifest.json')
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  try {
    return parseSkillPackageManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

function harnessResourceTargets(
  manifest: SkillPackageManifest,
  agent: string,
  scope: CollisionScope,
): HarnessResourceTarget[] {
  const declared = manifest.harness_resources?.[agent] ?? {}
  const roots = harnessAdapter(agent).paths(scope, userHome()).resources
  const targets: HarnessResourceTarget[] = []
  for (const [kind, files] of Object.entries(declared)) {
    const root = roots[kind]
    if (!root) continue
    for (const source of files) targets.push({ source, destination: join(root, basename(source)) })
  }
  return targets
}

function installedManifests(scope: CollisionScope, skill?: string): SkillPackageManifest[] {
  const result: SkillPackageManifest[] = []
  for (const agent of HARNESS_ADAPTERS) {
    const paths = harnessAdapter(agent.id).paths(scope, userHome())
    if (!existsSync(paths.skillRoot) || !statSync(paths.skillRoot).isDirectory()) continue
    for (const entry of readdirSync(paths.skillRoot)) {
      if (skill && entry !== skill) continue
      const skillPath = join(paths.skillRoot, entry)
      if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) continue
      const manifest = installedPackageManifest(skillPath)
      if (manifest?.name === entry) result.push(manifest)
    }
  }
  return result
}

function packageFileDestinations(source: string, destination: string): string[] {
  if (!existsSync(source) || !statSync(source).isDirectory()) return [destination]
  const result: string[] = []
  for (const entry of readdirSync(source)) {
    result.push(...packageFileDestinations(join(source, entry), join(destination, entry)))
  }
  return result
}

function expectedSkillFiles(pkg: DownloadedSkillPackage, destination: string): string[] {
  return [
    ...pkg.manifest.skill_files.flatMap((rel) => (
      packageFileDestinations(join(pkg.root, rel), join(destination, rel))
    )),
    join(destination, 'manifest.json'),
  ]
}

function managedSkillFiles(manifest: SkillPackageManifest | undefined, destination: string): Set<string> {
  if (!manifest) return new Set()
  return new Set([
    ...manifest.skill_files.map((rel) => normalizedPath(resolve(destination, rel))),
    normalizedPath(resolve(destination, 'manifest.json')),
  ])
}

function expectedRuntimeFiles(pkg: DownloadedSkillPackage, scope: CollisionScope): string[] {
  if (!pkg.manifest.runtime) return []
  const root = runtimeSkillRoot(scope.root, pkg.manifest.name)
  const cli = runtimeCliPath(pkg.manifest, scope)
  return [
    ...(cli ? [cli] : []),
    ...(pkg.manifest.runtime_files ?? []).flatMap((rel) => (
      packageFileDestinations(join(pkg.root, rel), join(root, rel))
    )),
  ]
}

function managedRuntimeFiles(scope: CollisionScope, skill: string): Set<string> {
  const files = new Set<string>()
  for (const manifest of installedManifests(scope, skill)) {
    const cli = runtimeCliPath(manifest, scope)
    if (cli) files.add(normalizedPath(resolve(cli)))
    const root = runtimeSkillRoot(scope.root, skill)
    for (const rel of manifest.runtime_files ?? []) files.add(normalizedPath(resolve(root, rel)))
  }
  return files
}

function instructionPathCollides(path: string, skill: string): boolean {
  if (!existsSync(path)) return false
  if (!statSync(path).isFile()) return true
  const begin = `<!-- jls:begin ${skill} -->`
  const end = `<!-- jls:end ${skill} -->`
  const current = readFileSync(path, 'utf8')
  const begins = current.split(begin).length - 1
  const ends = current.split(end).length - 1
  if (begins === 0 && ends === 0) return false
  return begins !== 1 || ends !== 1 || current.indexOf(end) < current.indexOf(begin)
}

function pathInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function addBlockingContainers(
  filePath: string,
  root: string,
  add: (path: string) => void,
): void {
  let current = dirname(filePath)
  const boundary = resolve(root)
  while (pathInside(boundary, current)) {
    if (existsSync(current)) {
      if (!statSync(current).isDirectory()) add(current)
      break
    }
    if (resolve(current) === boundary) break
    current = dirname(current)
  }
}

function filePathCollides(path: string, managed: Set<string>): boolean {
  if (!existsSync(path)) return false
  if (!statSync(path).isFile()) return true
  return !managed.has(normalizedPath(resolve(path)))
}

export function detectInstallCollisions(
  pkg: DownloadedSkillPackage,
  scope: CollisionScope,
  agents: string[],
): InstallCollision[] {
  const skill = pkg.manifest.name
  const collisions = new Map<string, InstallCollision>()
  const add = (path: string) => {
    const normalized = normalizedPath(path)
    collisions.set(normalized, { path: normalized })
  }

  const runtimeManaged = managedRuntimeFiles(scope, skill)
  for (const destination of expectedRuntimeFiles(pkg, scope)) {
    addBlockingContainers(destination, scope.root, add)
    if (filePathCollides(destination, runtimeManaged)) add(destination)
  }

  for (const agent of agents) {
    const paths = harnessAdapter(agent).paths(scope, userHome())
    if (existsSync(paths.skillRoot) && !statSync(paths.skillRoot).isDirectory()) add(paths.skillRoot)

    const destination = join(paths.skillRoot, skill)
    if (existsSync(destination) && !statSync(destination).isDirectory()) add(destination)
    const previous = installedPackageManifest(destination)
    const priorSkillFiles = managedSkillFiles(previous?.name === skill ? previous : undefined, destination)
    for (const file of expectedSkillFiles(pkg, destination)) {
      addBlockingContainers(file, destination, add)
      if (filePathCollides(file, priorSkillFiles)) add(file)
    }

    const priorResources = new Set(
      previous?.name === skill
        ? harnessResourceTargets(previous, agent, scope).map((target) => normalizedPath(resolve(target.destination)))
        : [],
    )
    for (const target of harnessResourceTargets(pkg.manifest, agent, scope)) {
      addBlockingContainers(target.destination, scope.root, add)
      if (filePathCollides(target.destination, priorResources)) add(target.destination)
    }

    if (instructionPathCollides(paths.instruction, skill)) add(paths.instruction)
  }

  return [...collisions.values()]
}

export function removeInstallCollisions(collisions: InstallCollision[]): void {
  const paths = [...new Set(collisions.map((collision) => collision.path))]
    .sort((a, b) => b.length - a.length)
  for (const path of paths) rmSync(path, { recursive: true, force: true })
}
