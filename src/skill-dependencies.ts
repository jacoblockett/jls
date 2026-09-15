import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ReleasedSkill, SkillDependency } from './installer-updater'

export type MissingDependencyGroup = {
  skill: string
  dependencies: SkillDependency[]
}

type DetectionHooks = {
  commandExists?: (command: string) => boolean
  pathExists?: (path: string) => boolean
}

function userHome(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

export function resolveDependencyPath(raw: string, scopeRoot: string): string {
  let value = raw.trim()
  value = value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
  value = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
    const name = braced || plain
    return process.env[name] ?? whole
  })
  if (value === '~') value = userHome()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(userHome(), value.slice(2))
  return resolve(isAbsolute(value) ? value : join(scopeRoot, value))
}

function systemCommandExists(command: string): boolean {
  return spawnSync(platform() === 'win32' ? 'where' : 'which', [command], {
    stdio: 'ignore',
    windowsHide: true,
  }).status === 0
}

export function dependencyDetected(
  dependency: SkillDependency,
  scopeRoot: string,
  hooks: DetectionHooks = {},
): boolean {
  const commandExists = hooks.commandExists ?? systemCommandExists
  const pathExists = hooks.pathExists ?? existsSync
  if (dependency.detect.command?.some((command) => commandExists(command))) return true
  if (dependency.detect.path?.some((path) => pathExists(resolveDependencyPath(path, scopeRoot)))) return true
  return false
}

export function missingSkillDependencies(
  skills: string[],
  released: Record<string, ReleasedSkill>,
  scopeRoot: string,
  hooks: DetectionHooks = {},
): MissingDependencyGroup[] {
  const groups: MissingDependencyGroup[] = []
  for (const skill of skills) {
    const dependencies = (released[skill]?.dependencies ?? [])
      .filter((dependency) => !dependencyDetected(dependency, scopeRoot, hooks))
    if (dependencies.length > 0) groups.push({ skill, dependencies })
  }
  return groups
}

function displaySkillName(name: string): string {
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : name
}

export function missingDependenciesText(groups: MissingDependencyGroup[]): string {
  return [
    'One or more of the skills you selected require the following dependencies that were not detected on your system:',
    '',
    ...groups.flatMap((group) => [
      `• ${displaySkillName(group.skill)}`,
      ...group.dependencies.map((dependency) => `  • ${dependency.name} (install: ${dependency.install_url})`),
    ]),
    '',
    'It is recommended that you install these dependencies before attempting to use the skills that require them. If these dependencies exist on your system in an unconventional way, ensure your agents have sufficient knowledge of where they exist and how to use them, ideally via your agent instruction files.',
  ].join('\n')
}
