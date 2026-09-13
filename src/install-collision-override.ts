import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { HARNESS_ADAPTERS, harnessAdapter } from './harnesses'
import {
  generatedDataOwned,
  runtimeRootOwned,
  runtimeSkillOwned,
  runtimeSkillRoot,
} from './install-ownership'
import {
  parseSkillPackageManifest,
  type DownloadedSkillPackage,
  type SkillPackageManifest,
} from './installer-updater'

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
    for (const source of files) targets.push({ destination: join(root, basename(source)) })
  }
  return targets
}

function installedManifests(scope: CollisionScope): Array<{
  skill: string
  manifest: SkillPackageManifest
}> {
  const result: Array<{ skill: string; manifest: SkillPackageManifest }> = []
  for (const agent of HARNESS_ADAPTERS) {
    const paths = harnessAdapter(agent.id).paths(scope, userHome())
    if (!existsSync(paths.skillRoot) || !statSync(paths.skillRoot).isDirectory()) continue
    for (const entry of readdirSync(paths.skillRoot)) {
      const skillPath = join(paths.skillRoot, entry)
      if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) continue
      const manifest = installedPackageManifest(skillPath)
      if (manifest?.name === entry) result.push({ skill: entry, manifest })
    }
  }
  return result
}

function runtimeOwnershipEvidence(scope: CollisionScope, skill: string): { root: boolean; skill: boolean } {
  let root = false
  let ownedSkill = false
  for (const installed of installedManifests(scope)) {
    if (!installed.manifest.runtime) continue
    root = true
    if (installed.skill === skill) ownedSkill = true
  }
  return { root, skill: ownedSkill }
}

function legacyGeneratedDataOwned(
  scope: CollisionScope,
  skill: string,
  generatedPath: string,
): boolean {
  const wanted = normalizedPath(resolve(generatedPath))
  for (const agent of HARNESS_ADAPTERS) {
    const paths = harnessAdapter(agent.id).paths(scope, userHome())
    const manifest = installedPackageManifest(join(paths.skillRoot, skill))
    if (!manifest || manifest.name !== skill) continue
    for (const spec of manifest.generated_data ?? []) {
      if (normalizedPath(resolve(scope.root, spec.path)) !== wanted || !spec.marker) continue
      const marker = join(generatedPath, spec.marker)
      if (existsSync(marker) && statSync(marker).isFile()) return true
    }
  }
  return false
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

  if (pkg.manifest.runtime) {
    const legacy = runtimeOwnershipEvidence(scope, skill)
    const metaRoot = join(scope.root, '.jls')
    if (existsSync(metaRoot)) {
      if (!statSync(metaRoot).isDirectory()) add(metaRoot)
      else {
        const marker = join(metaRoot, '.jls-owned.json')
        if (existsSync(marker) ? !runtimeRootOwned(scope.root) : !legacy.root) add(metaRoot)
      }
    }

    const skillRoot = runtimeSkillRoot(scope.root, skill)
    if (existsSync(skillRoot)) {
      if (!statSync(skillRoot).isDirectory()) add(skillRoot)
      else {
        const marker = join(skillRoot, '.jls-owned.json')
        if (existsSync(marker) ? !runtimeSkillOwned(scope.root, skill) : !legacy.skill) add(skillRoot)
      }
    }
  }

  for (const spec of pkg.manifest.generated_data ?? []) {
    const target = resolve(scope.root, spec.path)
    if (!existsSync(target)) continue
    if (!statSync(target).isDirectory()) {
      add(target)
      continue
    }
    if (spec.ownership_marker) {
      const ownershipPath = join(target, spec.ownership_marker)
      if (existsSync(ownershipPath)) {
        if (!generatedDataOwned(target, skill, spec.ownership_marker)) add(target)
      } else if (!legacyGeneratedDataOwned(scope, skill, target)) {
        add(target)
      }
      continue
    }
    if (!spec.marker) {
      add(target)
      continue
    }
    const marker = join(target, spec.marker)
    if (!existsSync(marker) || !statSync(marker).isFile()) add(target)
  }

  for (const agent of agents) {
    const paths = harnessAdapter(agent).paths(scope, userHome())
    if (existsSync(paths.skillRoot) && !statSync(paths.skillRoot).isDirectory()) add(paths.skillRoot)

    const destination = join(paths.skillRoot, skill)
    const previous = installedPackageManifest(destination)
    if (existsSync(destination) && previous?.name !== skill) add(destination)

    const previouslyOwnedResources = new Set(
      previous?.name === skill
        ? harnessResourceTargets(previous, agent, scope).map((target) => normalizedPath(resolve(target.destination)))
        : [],
    )
    for (const target of harnessResourceTargets(pkg.manifest, agent, scope)) {
      const parent = dirname(target.destination)
      if (existsSync(parent) && !statSync(parent).isDirectory()) add(parent)
      if (
        existsSync(target.destination)
        && !previouslyOwnedResources.has(normalizedPath(resolve(target.destination)))
      ) add(target.destination)
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
