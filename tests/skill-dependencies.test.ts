import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  dependencyDetected,
  missingDependenciesText,
  missingSkillDependencies,
  resolveDependencyPath,
} from '../src/skill-dependencies'
import type { ReleasedSkill, SkillDependency } from '../src/installer-updater'

const beads: SkillDependency = {
  name: 'Beads',
  install_url: 'https://example.invalid/beads',
  detect: { command: ['bd'] },
}

describe('skill dependency detection', () => {
  test('any declared command or path may satisfy a dependency', () => {
    const dependency: SkillDependency = {
      name: 'Example',
      install_url: 'https://example.invalid/install',
      detect: {
        command: ['missing', 'example'],
        path: ['tools/missing', 'tools/example'],
      },
    }
    expect(dependencyDetected(dependency, '/scope', {
      commandExists: (command) => command === 'example',
      pathExists: () => false,
    })).toBe(true)
    expect(dependencyDetected(dependency, '/scope', {
      commandExists: () => false,
      pathExists: (path) => path === resolve('/scope', 'tools/example'),
    })).toBe(true)
    expect(dependencyDetected(dependency, '/scope', {
      commandExists: () => false,
      pathExists: () => false,
    })).toBe(false)
  })

  test('relative detection paths resolve against the selected management root', () => {
    expect(resolveDependencyPath(join('tools', 'bd'), resolve('/scope')))
      .toBe(resolve('/scope', 'tools', 'bd'))
  })

  test('missing dependencies remain grouped beneath the skills that require them', () => {
    const released: Record<string, ReleasedSkill> = {
      tasks: {
        version: '1.0.0',
        min_installer: '0.4.0',
        dependencies: [beads],
        artifacts: {},
      },
      map: {
        version: '1.0.0',
        min_installer: '0.4.0',
        artifacts: {},
      },
    }
    expect(missingSkillDependencies(['map', 'tasks'], released, '/scope', {
      commandExists: () => false,
      pathExists: () => false,
    })).toEqual([{ skill: 'tasks', dependencies: [beads] }])
  })
})

describe('missing dependency notice', () => {
  test('renders each missing dependency nested under its skill with an install link', () => {
    const lines = missingDependenciesText([{ skill: 'tasks', dependencies: [beads] }]).split('\n')
    const skillLine = lines.indexOf('• Tasks')
    expect(skillLine).toBeGreaterThan(-1)
    const dependencyLine = lines[skillLine + 1] ?? ''
    expect(dependencyLine.startsWith('  • ')).toBe(true)
    expect(dependencyLine).toContain('Beads')
    expect(dependencyLine).toContain(beads.install_url)
  })
})
