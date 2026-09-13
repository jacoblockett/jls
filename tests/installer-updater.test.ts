
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
    format: 3,
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

function skillRelease(version = '1.2.3', sha = '1'.repeat(64)) {
  return {
    format: 1,
    name: 'example-skill',
    version,
    min_installer: '0.7.0',
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
    expect(() => compareVersions('0.5.0-nightly', '0.5.0')).toThrow('invalid semantic version comparison')
  })

  test('JLS release manifest contains installer artifacts and external skill references only', () => {
    const parsed = parseReleaseManifest(releaseIndex())
    expect(parsed.format).toBe(3)
    expect(parsed.installer.version).toBe('0.7.0')
    expect(parsed.skills['example-skill'].manifest_url).toBe('https://fixture.invalid/example-skill-manifest.json')
    expect(() => parseReleaseManifest({ ...releaseIndex(), format: 2 })).toThrow('unsupported release manifest format')
  })

  test('external skill manifest owns version, compatibility, hashes, and target artifacts', () => {
    const released = parseSkillReleaseManifest('example-skill', skillRelease())
    expect(released.version).toBe('1.2.3')
    expect(released.min_installer).toBe('0.7.0')
    expect(released.artifacts['windows-x64']?.url).toEndWith('/example-skill-windows-x64.zip')
    expect(() => parseSkillReleaseManifest('other', skillRelease())).toThrow('identifies example-skill')
    expect(() => parseSkillReleaseManifest('example-skill', { ...skillRelease(), format: 2 })).toThrow('unsupported released skill manifest format')
  })

  test('stable release fetch resolves referenced skill manifests', async () => {
    const resolved = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex()),
    )
    expect(resolved?.skills['example-skill'].version).toBe('1.2.3')
  })

  test('unpublished referenced skills are omitted without breaking installer update discovery', async () => {
    const resolved = await fetchStableReleaseManifest(
      'https://fixture.invalid/manifest.json',
      fixtureFetcher(releaseIndex(), null),
    )
    expect(resolved?.skills).toEqual({})
  })

  test('artifact selection remains exact-target with explicit portable fallback only', () => {
    const native = parseSkillReleaseManifest('example-skill', skillRelease())
    expect(selectSkillArtifact('example-skill', native, 'windows-x64').key).toBe('windows-x64')
    expect(() => selectSkillArtifact('example-skill', native, 'linux-x64-gnu')).toThrow('no linux-x64-gnu or portable')

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
      format: 1,
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['SKILL.md'],
      runtime: 'native',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/example.exe' },
      runtime_files: ['support.dat'],
      runtime_cli: 'example',
      generated_data: [{
        path: '.example',
        marker: 'project.json',
        ownership_marker: '.jls-owned.json',
      }],
    })
    expect(parsed.name).toBe('example-skill')
    expect(parsed.runtime_artifacts?.['windows-x64']).toBe('runtime/windows-x64/example.exe')
    expect(parsed.generated_data?.[0]).toEqual({
      path: '.example',
      marker: 'project.json',
      ownership_marker: '.jls-owned.json',
    })
    expect(() => parseSkillPackageManifest({
      format: 1,
      name: 'example-skill',
      version: '1.2.3',
      min_installer: '0.7.0',
      description: 'Example',
      skill_files: ['../escape'],
    })).toThrow('relative contained path')
  })

  test('download verifies and extracts a referenced package', async () => {
    const root = reset('package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const packageManifest = {
      format: 1,
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