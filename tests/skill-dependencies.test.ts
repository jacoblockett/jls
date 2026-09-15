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
  test('uses the single generic template and nested dependency bullets', () => {
    expect(missingDependenciesText([{ skill: 'tasks', dependencies: [beads] }])).toBe([
      'One or more of the skills you selected require the following dependencies that were not detected on your system:',
      '',
      '• Tasks',
      '  • Beads (install: https://example.invalid/beads)',
      '',
      'It is recommended that you install these dependencies before attempting to use the skills that require them. If these dependencies exist on your system in an unconventional way, ensure your agents have sufficient knowledge of where they exist and how to use them, ideally via your agent instruction files.',
    ].join('\n'))
  })
})
