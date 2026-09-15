import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyInstallTargets, satisfiedSkills, staleSkills, staleUpdateTargets } from '../src/install-preflight'

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

  test('updates select only genuinely stale targets', () => {
    const targets = [
      { agent: 'stale', version: '0.1.0' },
      { agent: 'current', version: '0.2.0' },
      { agent: 'newer', version: '0.3.0' },
      { agent: 'unknown', version: 'unknown' },
    ]
    expect(staleUpdateTargets(targets, '0.2.0')).toEqual([
      { agent: 'stale', version: '0.1.0' },
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

describe('runtime-facing installer behavior', () => {
  test('--version reports the installer manifest version', () => {
    const repo = resolve(import.meta.dir, '..')
    const manifest = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8'))
    const result = spawnSync(process.execPath, [join(repo, 'src', 'jls-v04-core.ts'), '--version'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(`jls ${manifest.version}`)
  })
})
