import { describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadSkillPackage,
  fetchStableReleaseManifest,
  isSkillCompatible,
  parseReleaseManifest,
  parseSkillPackageManifest,
  parseSkillReleaseManifest,
  selectInstallerArtifact,
  selectSkillArtifact,
  type ReleasedSkill,
} from '../src/installer-updater'

const repo = resolve(import.meta.dir, '..')
const scratch = join(repo, 'build', 'installer-updater-tests')

function reset(name: string): string {
  const root = join(scratch, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function releaseIndex(installerVersion = '0.7.0') {
  return {
    installer: {
      version: installerVersion,
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/jls-windows-x64.exe',
          sha256: '0'.repeat(64),
        },
      },
    },
    skills: {
      'example-skill': {
        manifest_url: 'https://fixture.invalid/example-skill-manifest.json',
      },
    },
  }
}

function skillRelease(version = '1.2.3', sha = '1'.repeat(64), minInstaller = '0.7.0') {
  return {
    name: 'example-skill',
    version,
    min_installer: minInstaller,
    description: 'Example skill',
    dependencies: [{
      name: 'Example CLI',
      install_url: 'https://fixture.invalid/install',
      detect: {
        command: ['example'],
        path: ['tools/example'],
      },
    }],
    artifacts: {
      'windows-x64': {
        url: 'https://fixture.invalid/example-skill-windows-x64.zip',
        sha256: sha,
      },
    },
  }
}

function fixtureFetcher(index: unknown, skill: unknown | null = skillRelease(), archive?: Uint8Array): typeof fetch {
  return (async (input: any) => {
    const url = String(input)
    if (url === 'https://fixture.invalid/manifest.json') return Response.json(index)
    if (url === 'https://fixture.invalid/example-skill-manifest.json') {
      return skill === null ? new Response('missing', { status: 404 }) : Response.json(skill)
    }
    if (url === 'https://fixture.invalid/example-skill-windows-x64.zip' && archive) return new Response(archive)
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

describe('release metadata', () => {
  test('semantic versions compare deterministically', () => {
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(() => compareVersions('0.5.0-nightly', '0.5.0')).toThrow()
  })

  test('JLS release manifest contains installer artifacts and external skill references', () => {
    const parsed = parseReleaseManifest(releaseIndex())
    expect(parsed.installer.version).toBe('0.7.0')
    expect(parsed.skills['example-skill'].manifest_url).toBe('https://fixture.invalid/example-skill-manifest.json')
  })

  test('legacy extra manifest metadata does not block current manifests', () => {
    expect(parseReleaseManifest({ ...releaseIndex(), format: 3 }).installer.version).toBe('0.7.0')
    expect(parseSkillReleaseManifest('example-skill', { ...skillRelease(), format: 1 }).version).toBe('1.2.3')
  })

  test('external skill manifest profile metadata round-trips with compatibility and artifacts', () => {
    const released = parseSkillReleaseManifest('example-skill', skillRelease())
    expect(released.version).toBe('1.2.3')
    expect(released.min_installer).toBe('0.7.0')
    expect(released.description).toBe('Example skill')
    expect(released.dependencies?.[0]).toEqual({
      name: 'Example CLI',
      install_url: 'https://fixture.invalid/install',
      detect: {
        command: ['example'],
        path: ['tools/example'],
      },
    })
    expect(released.artifacts['windows-x64']?.url).toEndWith('/example-skill-windows-x64.zip')
    expect(() => parseSkillReleaseManifest('other', skillRelease())).toThrow()
  })

  test('dependency detection metadata requires at least one non-empty command or path array', () => {
    expect(() => parseSkillReleaseManifest('example-skill', {
      ...skillRelease(),
      dependencies: [{
        name: 'Example CLI',
        install_url: 'https://fixture.invalid/install',
        detect: {},
      }],
    })).toThrow()
    expect(() => parseSkillReleaseManifest('example-skill', {
      ...skillRelease(),
      dependencies: [{
        name: 'Example CLI',
        install_url: 'https://fixture.invalid/install',
        detect: { command: [] },
      }],
    })).toThrow()
  })

  test('stable release discovery omits skills above installer compatibility', async () => {
    const compatible = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex(), skillRelease('1.2.3', '1'.repeat(64), '0.4.0')),
      '0.4.0',
    )
    expect(compatible?.skills['example-skill']?.version).toBe('1.2.3')
    expect(compatible?.incompatibleSkills).toEqual({})

    const incompatible = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex(), skillRelease('1.2.3', '1'.repeat(64), '0.4.1')),
      '0.4.0',
    )
    expect(incompatible?.skills['example-skill']).toBeUndefined()
    expect(incompatible?.incompatibleSkills['example-skill']?.min_installer).toBe('0.4.1')
    expect(isSkillCompatible('0.4.0', { min_installer: '0.4.1' })).toBe(false)
  })

  test('stable release fetch resolves referenced skill manifests', async () => {
    const resolved = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex()),
      '0.7.0',
    )
    expect(resolved?.skills['example-skill'].version).toBe('1.2.3')
    expect(resolved?.skills['example-skill'].description).toBe('Example skill')
  })

  test('unpublished referenced skills are omitted without breaking installer update discovery', async () => {
    const resolved = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex(), null),
      '0.7.0',
    )
    expect(resolved?.skills).toEqual({})
    expect(resolved?.incompatibleSkills).toEqual({})
  })

  test('artifact selection remains exact-target with explicit portable fallback only', () => {
    const native = parseSkillReleaseManifest('example-skill', skillRelease())
    expect(selectSkillArtifact('example-skill', native, 'windows-x64').key).toBe('windows-x64')
    expect(() => selectSkillArtifact('example-skill', native, 'linux-x64-gnu')).toThrow()

    const portable = parseSkillReleaseManifest('example-skill', {
      ...skillRelease(),
      artifacts: {
        portable: { url: 'https://fixture.invalid/example-skill-portable.zip', sha256: '2'.repeat(64) },
      },
    })
    expect(selectSkillArtifact('example-skill', portable, 'linux-arm64-musl').key).toBe('portable')
    const index = parseReleaseManifest(releaseIndex())
    expect(selectInstallerArtifact(index, 'windows-x64').url).toEndWith('/jls-windows-x64.exe')
  })

  test('installer update does not need to fetch external skill manifests', async () => {
    const index = releaseIndex('0.8.0')
    const fetcher = (async (input: any) => {
      const url = String(input)
      if (url === 'https://fixture.invalid/manifest.json') return Response.json(index)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const update = await checkInstallerUpdate('0.7.0', 'https://fixture.invalid/manifest.json', fetcher, 'windows-x64')
    expect(update?.version).toBe('0.8.0')
  })
})

describe('skill package contract', () => {
  test('package manifest validation remains installer-owned and skill-agnostic', () => {
    const parsed = parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      dependencies: [{
        name: 'Example CLI',
        install_url: 'https://fixture.invalid/install',
        detect: { command: ['example'], path: ['tools/example'] },
      }],
      skill_files: ['SKILL.md'],
      runtime: 'native',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/example.exe' },
      runtime_files: ['support.dat'],
      runtime_cli: 'example',
      generated_data: [{
        path: '.example',
        marker: 'project.json',
      }],
    })
    expect(parsed.name).toBe('example-skill')
    expect(parsed.dependencies?.[0].detect).toEqual({ command: ['example'], path: ['tools/example'] })
    expect(parsed.runtime_artifacts?.['windows-x64']).toBe('runtime/windows-x64/example.exe')
    expect(parsed.generated_data?.[0]).toEqual({
      path: '.example',
      marker: 'project.json',
    })
    expect(() => parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['../escape'],
    })).toThrow()
  })

  test('legacy ownership_marker fields are ignored rather than becoming runtime ownership state', () => {
    const parsed = parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['SKILL.md'],
      generated_data: [{ path: '.example', marker: 'project.json', ownership_marker: '.jls-owned.json' }],
    })
    expect(parsed.generated_data?.[0]).toEqual({ path: '.example', marker: 'project.json' })
  })

  test('package parser accepts a legacy extra format field without retaining it', () => {
    const parsed = parseSkillPackageManifest({
      format: 1,
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['SKILL.md'],
    })
    expect('format' in parsed).toBe(false)
  })

  test('download verifies and extracts a referenced package', async () => {
    const root = reset('package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const packageManifest = {
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['SKILL.md'],
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '# Example Skill\n\nAgent-usable instructions only.\n')

    const zip = new AdmZip()
    zip.addLocalFile(join(packageRoot, 'manifest.json'))
    zip.addLocalFile(join(packageRoot, 'SKILL.md'))
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/example-skill-windows-x64.zip',
          sha256: sha256(bytes),
        },
      },
    }

    const downloaded = await downloadSkillPackage(
      'example-skill',
      released,
      fixtureFetcher({}, {}, bytes),
      'windows-x64',
    )
    try {
      expect(downloaded.manifest.name).toBe('example-skill')
      expect(existsSync(join(downloaded.root, 'SKILL.md'))).toBe(true)
    } finally {
      downloaded.cleanup()
    }
  })
})
