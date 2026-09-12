import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyInstallTargets, satisfiedSkills, staleSkills } from '../src/install-preflight'

describe('install preflight classification', () => {
  test('classifies missing, satisfied, stale, configure, unknown, and newer targets without downgrading', () => {
    const targets = classifyInstallTargets(
      ['map', 'other'],
      ['codex', 'claude'],
      { map: '0.2.0', other: '1.0.0' },
      { map: true, other: false },
      [
        { skill: 'map', agent: 'codex', version: '0.2.0', instructions: true },
        { skill: 'map', agent: 'claude', version: '0.1.0', instructions: true },
        { skill: 'other', agent: 'codex', version: 'unknown', instructions: false },
        { skill: 'other', agent: 'claude', version: '1.1.0', instructions: true },
      ],
    )

    expect(targets).toEqual([
      {
        skill: 'map',
        agent: 'codex',
        availableVersion: '0.2.0',
        requestedInstructions: true,
        installedVersion: '0.2.0',
        installedInstructions: true,
        state: 'satisfied',
      },
      {
        skill: 'map',
        agent: 'claude',
        availableVersion: '0.2.0',
        requestedInstructions: true,
        installedVersion: '0.1.0',
        installedInstructions: true,
        state: 'stale',
      },
      {
        skill: 'other',
        agent: 'codex',
        availableVersion: '1.0.0',
        requestedInstructions: false,
        installedVersion: 'unknown',
        installedInstructions: false,
        state: 'stale',
      },
      {
        skill: 'other',
        agent: 'claude',
        availableVersion: '1.0.0',
        requestedInstructions: false,
        installedVersion: '1.1.0',
        installedInstructions: true,
        state: 'configure',
      },
    ])
  })

  test('current installation with different instruction injection is configuration work', () => {
    const add = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: true },
      [{ skill: 'map', agent: 'codex', version: '0.2.0', instructions: false }],
    )
    expect(add[0]?.state).toBe('configure')

    const remove = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: false },
      [{ skill: 'map', agent: 'codex', version: '0.2.0', instructions: true }],
    )
    expect(remove[0]?.state).toBe('configure')
  })

  test('newer installation is satisfied only when requested configuration also matches', () => {
    const matching = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: false },
      [{ skill: 'map', agent: 'codex', version: '0.3.0', instructions: false }],
    )
    expect(matching[0]?.state).toBe('satisfied')

    const changed = classifyInstallTargets(
      ['map'],
      ['codex'],
      { map: '0.2.0' },
      { map: true },
      [{ skill: 'map', agent: 'codex', version: '0.3.0', instructions: false }],
    )
    expect(changed[0]?.state).toBe('configure')
  })

  test('groups stale targets by skill', () => {
    const targets = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      { map: true },
      [
        { skill: 'map', agent: 'codex', version: '0.1.0', instructions: false },
        { skill: 'map', agent: 'claude', version: 'unknown', instructions: true },
      ],
    )
    expect(staleSkills(targets)).toEqual([
      { skill: 'map', installedVersions: ['0.1.0', 'unknown'], availableVersion: '0.2.0' },
    ])
  })

  test('a skill is already installed only when every requested harness target is satisfied', () => {
    const complete = classifyInstallTargets(
      ['map'],
      ['codex', 'claude'],
      { map: '0.2.0' },
      { map: false },
      [
        { skill: 'map', agent: 'codex', version: '0.2.0', instructions: false },
        { skill: 'map', agent: 'claude', version: '0.3.0', instructions: false },
      ],
    )
    expect(satisfiedSkills(complete)).toEqual(['map'])
  })
})

describe('0.4 interactive flow contract', () => {
  const repo = resolve(import.meta.dir, '..')
  const source = readFileSync(join(repo, 'src', 'jls-v04.ts'), 'utf8').replace(/\r\n/g, '\n')

  test('bare installer is scope-first and retains custom paths', () => {
    expect(source).toContain("label: 'Manage skills on the current path'")
    expect(source).toContain("label: 'Manage skills on the global path'")
    expect(source).toContain("label: 'Manage skills on a custom path'")
    expect(source).toContain("label: 'Manage installer'")
  })

  test('install disables a skill only when every targetable harness already has it', () => {
    expect(source).toContain('agents.every((agent) => targetInstalled(scope, name, agent))')
    expect(source).toContain('skills.every((skill) => targetInstalled(scope, skill, agent.id))')
    expect(source).toContain("'Which AI harnesses should receive these skills?'")
  })

  test('instruction injection defaults on for capable selected skills', () => {
    expect(source).toContain('initialValues: capable')
    expect(source).toContain("'About AI Instruction Files'")
  })

  test('Install new skills does not silently perform stale skill updates', () => {
    expect(source).toContain("const actionable = planned.filter((target) => target.state === 'missing' || target.state === 'configure')")
    expect(source).not.toContain('Which would you like to update instead?')
  })

  test('updates have a confirmation and no-update state returns to management', () => {
    expect(source).toContain("'The following updates are available. Please select which you would like to install.'")
    expect(source).toContain('prompts.note(updateSummary(scope, groups, availableVersions))')
    expect(source).toContain("prompts.log.info('No updates were found.')")
  })

  test('generated-data choice is integrated into skill uninstall', () => {
    expect(source).toContain("'The following selected skills have generated data that can also be removed.'")
    expect(source).toContain("initialValues: cleanupGroups.map((group) => group.skill)")
    expect(source).not.toContain('Remove skill-generated data')
  })

  test('installer manifest remains the runtime version authority', () => {
    expect(source).toContain("import installerManifest from '../manifest.json'")
    expect(source).toContain('const VERSION = installerManifest.version')
  })
})
