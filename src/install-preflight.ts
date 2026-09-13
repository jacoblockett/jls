export type InstalledInstallTarget = {
  skill: string
  agent: string
  version: string
  instructions: boolean
}

export type InstallTargetState = {
  skill: string
  agent: string
  availableVersion: string
  requestedInstructions: boolean
  installedVersion?: string
  installedInstructions?: boolean
  state: 'missing' | 'satisfied' | 'configure' | 'stale'
}

export type StaleSkill = {
  skill: string
  installedVersions: string[]
  availableVersion: string
}

function semverParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: string, b: string): number | undefined {
  const left = semverParts(a)
  const right = semverParts(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

function versionState(installedVersion: string, availableVersion: string): 'current' | 'stale' {
  if (installedVersion === 'unknown') return 'stale'
  const comparison = compareVersions(installedVersion, availableVersion)
  if (comparison === undefined) return installedVersion === availableVersion ? 'current' : 'stale'
  return comparison >= 0 ? 'current' : 'stale'
}

export function staleUpdateTargets<T extends { version: string }>(targets: T[], availableVersion: string): T[] {
  return targets.filter((target) => compareVersions(target.version, availableVersion) === -1)
}

export function classifyInstallTargets(
  skills: string[],
  agents: string[],
  availableVersions: Record<string, string>,
  requestedInstructions: Record<string, boolean>,
  installedTargets: InstalledInstallTarget[],
): InstallTargetState[] {
  const installed = new Map(
    installedTargets.map((target) => [`${target.skill}\u0000${target.agent}`, target]),
  )
  const result: InstallTargetState[] = []

  for (const skill of skills) {
    const availableVersion = availableVersions[skill]
    if (!availableVersion) throw new Error(`missing available version for ${skill}`)
    const wantedInstructions = requestedInstructions[skill] ?? false

    for (const agent of agents) {
      const target = installed.get(`${skill}\u0000${agent}`)
      if (!target) {
        result.push({
          skill,
          agent,
          availableVersion,
          requestedInstructions: wantedInstructions,
          state: 'missing',
        })
        continue
      }

      const installedVersionState = versionState(target.version, availableVersion)
      const state = installedVersionState === 'stale'
        ? 'stale'
        : target.instructions === wantedInstructions
          ? 'satisfied'
          : 'configure'

      result.push({
        skill,
        agent,
        availableVersion,
        requestedInstructions: wantedInstructions,
        installedVersion: target.version,
        installedInstructions: target.instructions,
        state,
      })
    }
  }

  return result
}

export function satisfiedSkills(targets: InstallTargetState[]): string[] {
  const bySkill = new Map<string, InstallTargetState[]>()
  for (const target of targets) {
    const group = bySkill.get(target.skill) ?? []
    group.push(target)
    bySkill.set(target.skill, group)
  }
  return [...bySkill.entries()]
    .filter(([, group]) => group.length > 0 && group.every((target) => target.state === 'satisfied'))
    .map(([skill]) => skill)
    .sort()
}

export function staleSkills(targets: InstallTargetState[]): StaleSkill[] {
  const groups = new Map<string, StaleSkill>()
  for (const target of targets) {
    if (target.state !== 'stale') continue
    const group = groups.get(target.skill) ?? {
      skill: target.skill,
      installedVersions: [],
      availableVersion: target.availableVersion,
    }
    if (target.installedVersion && !group.installedVersions.includes(target.installedVersion)) {
      group.installedVersions.push(target.installedVersion)
    }
    groups.set(target.skill, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, installedVersions: group.installedVersions.sort() }))
    .sort((a, b) => a.skill.localeCompare(b.skill))
}
