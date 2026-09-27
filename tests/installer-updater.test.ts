import { describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  checkInstallerUpdate,
  compareVersions,
  downloadSkillPackage,
  fetchAvailableSkills,
  packageToolFiles,
  packageTools,
  parseGitHubRelease,
  parseSkillPackageManifest,
  parseSkillRepositoryManifest,
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

function skillManifest() {
  return {
    name: 'example-skill',
    description: 'Example skill',
    dependencies: [{
      name: 'Example CLI',
      install_url: 'https://fixture.invalid/install',
      detect: {
        command: ['example'],
        path: ['tools/example'],
      },
    }],
    skill_files: ['SKILL.md'],
  }
}

function skillRelease(version = '1.2.3', portable = false) {
  const name = portable ? 'example-skill.zip' : 'example-skill-windows-x64.zip'
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{
      name,
      browser_download_url: `https://fixture.invalid/${name}`,
      digest: `sha256:${'1'.repeat(64)}`,
    }],
  }
}

function installerRelease(version = '0.8.0') {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{
      name: 'jls-windows-x64.exe',
      browser_download_url: 'https://fixture.invalid/jls-windows-x64.exe',
      digest: `sha256:${'2'.repeat(64)}`,
    }],
  }
}

function discoveryFetcher(release: unknown = skillRelease(), manifest: unknown = skillManifest()): typeof fetch {
  return (async (input: any) => {
    const url = String(input)
    if (url === 'https://api.github.com/repos/owner/jls-example-skill/releases/latest') {
      return release === null ? new Response('missing', { status: 404 }) : Response.json(release)
    }
    if (url === 'https://raw.githubusercontent.com/owner/jls-example-skill/v1.2.3/manifest.json') {
      return Response.json(manifest)
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

// Package-contract tests below only need an archive fetcher; retain this helper
// shape so those focused tests stay independent from repository discovery.
function fixtureFetcher(_release: unknown, _manifest: unknown, archive?: Uint8Array): typeof fetch {
  return (async (input: any) => {
    if (archive && String(input).endsWith('.zip')) return new Response(archive)
    return new Response('missing', { status: 404 })
  }) as typeof fetch
}

describe('repository release discovery', () => {
  test('semantic versions compare deterministically', () => {
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(() => compareVersions('0.5.0-nightly', '0.5.0')).toThrow()
  })

  test('GitHub release metadata must describe a stable release', () => {
    expect(parseGitHubRelease(skillRelease()).tag_name).toBe('v1.2.3')
    expect(() => parseGitHubRelease({ ...skillRelease(), prerelease: true })).toThrow()
  })

  test('skill metadata comes from the skill repository manifest', () => {
    const parsed = parseSkillRepositoryManifest('owner/jls-example-skill', skillManifest())
    expect(parsed.name).toBe('example-skill')
    expect(parsed.description).toBe('Example skill')
    expect(parsed.dependencies?.[0].detect).toEqual({
      command: ['example'],
      path: ['tools/example'],
    })

    expect(() => parseSkillRepositoryManifest('owner/jls-other', skillManifest())).toThrow()
    expect(parseSkillRepositoryManifest('owner/curated-repository', skillManifest()).name).toBe('example-skill')
  })

  test('dependency detection metadata requires command and/or path', () => {
    expect(() => parseSkillRepositoryManifest('owner/jls-example-skill', {
      ...skillManifest(),
      dependencies: [{
        name: 'Example CLI',
        install_url: 'https://fixture.invalid/install',
        detect: {},
      }],
    })).toThrow()
  })

  test('embedded repository pointers resolve current stable skill releases', async () => {
    const resolved = await fetchAvailableSkills(
      ['owner/jls-example-skill'],
      discoveryFetcher(),
    )
    expect(resolved.skills['example-skill'].version).toBe('1.2.3')
    expect(resolved.skills['example-skill'].description).toBe('Example skill')
    expect(resolved.skills['example-skill'].artifacts['windows-x64']?.url)
      .toBe('https://fixture.invalid/example-skill-windows-x64.zip')
  })

  test('catalog repositories without a stable release are omitted', async () => {
    const resolved = await fetchAvailableSkills(
      ['owner/jls-example-skill'],
      discoveryFetcher(null),
    )
    expect(resolved.skills).toEqual({})
  })

  test('artifact selection remains exact-target with explicit portable fallback only', () => {
    const native: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/example-skill-windows-x64.zip',
          sha256: '1'.repeat(64),
        },
      },
    }
    expect(selectSkillArtifact('example-skill', native, 'windows-x64').key).toBe('windows-x64')
    expect(() => selectSkillArtifact('example-skill', native, 'linux-x64-gnu')).toThrow()

    const portable: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        portable: {
          url: 'https://fixture.invalid/example-skill.zip',
          sha256: '1'.repeat(64),
        },
      },
    }
    expect(selectSkillArtifact('example-skill', portable, 'linux-arm64-musl').key).toBe('portable')
  })

  test('installer self-update reads GitHub release metadata without skill discovery', async () => {
    const fetcher = (async (input: any) => {
      const url = String(input)
      if (url === 'https://api.github.com/repos/jacoblockett/jls/releases/latest') {
        return Response.json(installerRelease())
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    const update = await checkInstallerUpdate(
      '0.7.0',
      'jacoblockett/jls',
      fetcher,
      'windows-x64',
    )
    expect(update?.version).toBe('0.8.0')
    expect(update?.artifact.url).toEndWith('/jls-windows-x64.exe')
  })
})

describe('skill package contract', () => {
  test('package manifest validation supports multiple installer-managed tools', () => {
    const parsed = parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      dependencies: [{
        name: 'Example CLI',
        install_url: 'https://fixture.invalid/install',
        detect: { command: ['example'], path: ['tools/example'] },
      }],
      skill_files: ['SKILL.md'],
      tools: {
        history: {
          artifacts: { 'windows-x64': 'tools/windows-x64/history.exe' },
          token: 'HISTORY_CLI',
        },
        screenshot: {
          artifacts: { 'windows-x64': 'tools/windows-x64/screenshot.exe' },
          token: 'SCREENSHOT_CLI',
        },
      },
      tool_files: ['support.dat'],
      generated_data: [{
        path: '.example',
        marker: 'project.json',
      }],
    })
    expect(parsed.name).toBe('example-skill')
    expect(parsed.dependencies?.[0].detect).toEqual({ command: ['example'], path: ['tools/example'] })
    expect(Object.keys(packageTools(parsed))).toEqual(['history', 'screenshot'])
    expect(packageTools(parsed).history?.token).toBe('HISTORY_CLI')
    expect(packageTools(parsed).screenshot?.artifacts['windows-x64']).toBe('tools/windows-x64/screenshot.exe')
    expect(packageToolFiles(parsed)).toEqual(['support.dat'])
    expect(parsed.generated_data?.[0]).toEqual({
      path: '.example',
      marker: 'project.json',
    })
    expect(() => parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['../escape'],
    })).toThrow()
  })

  test('legacy singular runtime manifests normalize to one managed tool', () => {
    const parsed = parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['SKILL.md'],
      runtime: 'rust',
      runtime_artifacts: { 'windows-x64': 'runtime/windows-x64/example.exe' },
      runtime_files: ['support.dat'],
      runtime_cli: 'example',
      cli_token: 'EXAMPLE_CLI',
    })
    expect(packageTools(parsed)).toEqual({
      example: {
        artifacts: { 'windows-x64': 'runtime/windows-x64/example.exe' },
        token: 'EXAMPLE_CLI',
      },
    })
    expect(packageToolFiles(parsed)).toEqual(['support.dat'])
  })

  test('package manifest rejects ambiguous mixed or duplicate tool declarations', () => {
    const base = {
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['SKILL.md'],
    }
    expect(() => parseSkillPackageManifest({
      ...base,
      tools: {
        one: { artifacts: { 'windows-x64': 'one.exe' }, token: 'SAME_CLI' },
        two: { artifacts: { 'windows-x64': 'two.exe' }, token: 'SAME_CLI' },
      },
    })).toThrow()
    expect(() => parseSkillPackageManifest({
      ...base,
      tools: { one: { artifacts: { 'windows-x64': 'one.exe' } } },
      runtime: 'rust',
      runtime_artifacts: { 'windows-x64': 'legacy.exe' },
      runtime_cli: 'legacy',
    })).toThrow()
  })

  test('target packages reject tools that would install to the same filename', async () => {
    const root = reset('colliding-tool-package')
    const packageRoot = join(root, 'package')
    mkdirSync(join(packageRoot, 'one'), { recursive: true })
    mkdirSync(join(packageRoot, 'two'), { recursive: true })
    const packageManifest = {
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['SKILL.md'],
      tools: {
        first: { artifacts: { 'windows-x64': 'one/tool.exe' }, token: 'FIRST_CLI' },
        second: { artifacts: { 'windows-x64': 'two/tool.exe' }, token: 'SECOND_CLI' },
      },
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '# Example Skill\n')
    writeFileSync(join(packageRoot, 'one', 'tool.exe'), 'one')
    writeFileSync(join(packageRoot, 'two', 'tool.exe'), 'two')

    const zip = new AdmZip()
    zip.addLocalFolder(packageRoot)
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        'windows-x64': {
          url: 'https://fixture.invalid/example-skill-windows-x64.zip',
          sha256: sha256(bytes),
        },
      },
    }

    await expect(downloadSkillPackage(
      'example-skill',
      released,
      fixtureFetcher({}, {}, bytes),
      'windows-x64',
    )).rejects.toThrow()
  })

  test('target packages reject tool/support-file destination overlap', async () => {
    const root = reset('overlapping-tool-package')
    const packageRoot = join(root, 'package')
    mkdirSync(join(packageRoot, 'tools'), { recursive: true })
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    const packageManifest = {
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['SKILL.md'],
      tools: {
        helper: { artifacts: { portable: 'tools/helper' }, token: 'HELPER_CLI' },
      },
      tool_files: ['bin/helper'],
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '# Example Skill\n')
    writeFileSync(join(packageRoot, 'tools', 'helper'), 'tool')
    writeFileSync(join(packageRoot, 'bin', 'helper'), 'support')

    const zip = new AdmZip()
    zip.addLocalFolder(packageRoot)
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        portable: {
          url: 'https://fixture.invalid/example-skill.zip',
          sha256: sha256(bytes),
        },
      },
    }

    await expect(downloadSkillPackage(
      'example-skill',
      released,
      fixtureFetcher({}, {}, bytes),
      'windows-x64',
    )).rejects.toThrow()
  })

  test('legacy ownership_marker fields are ignored rather than becoming runtime ownership state', () => {
    const parsed = parseSkillPackageManifest({
      name: 'example-skill',
      version: '1.2.3',
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
      description: 'Example',
      skill_files: ['SKILL.md'],
    })
    expect('format' in parsed).toBe(false)
  })

  test('download validates every tool artifact in a target-specific package', async () => {
    const root = reset('multi-tool-package')
    const packageRoot = join(root, 'package')
    mkdirSync(join(packageRoot, 'tools', 'windows-x64'), { recursive: true })
    const packageManifest = {
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['SKILL.md'],
      tools: {
        history: {
          artifacts: { 'windows-x64': 'tools/windows-x64/history.exe' },
          token: 'HISTORY_CLI',
        },
        screenshot: {
          artifacts: { 'windows-x64': 'tools/windows-x64/screenshot.exe' },
          token: 'SCREENSHOT_CLI',
        },
      },
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '# Example Skill\n')
    writeFileSync(join(packageRoot, 'tools', 'windows-x64', 'history.exe'), 'history')
    writeFileSync(join(packageRoot, 'tools', 'windows-x64', 'screenshot.exe'), 'screenshot')

    const zip = new AdmZip()
    zip.addLocalFolder(packageRoot)
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.2.3',
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
      expect(Object.keys(packageTools(downloaded.manifest))).toEqual(['history', 'screenshot'])
    } finally {
      downloaded.cleanup()
    }
  })

  test('portable packages may carry portable managed tools', async () => {
    const root = reset('portable-tool-package')
    const packageRoot = join(root, 'package')
    mkdirSync(join(packageRoot, 'tools'), { recursive: true })
    const packageManifest = {
      name: 'example-skill',
      version: '1.2.3',
      description: 'Example',
      skill_files: ['SKILL.md'],
      tools: {
        helper: {
          artifacts: { portable: 'tools/helper' },
          token: 'HELPER_CLI',
        },
      },
    }
    writeFileSync(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    writeFileSync(join(packageRoot, 'SKILL.md'), '# Example Skill\n')
    writeFileSync(join(packageRoot, 'tools', 'helper'), '#!/usr/bin/env sh\n')

    const zip = new AdmZip()
    zip.addLocalFolder(packageRoot)
    const bytes = new Uint8Array(zip.toBuffer())
    const released: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        portable: {
          url: 'https://fixture.invalid/example-skill.zip',
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
      expect(packageTools(downloaded.manifest).helper?.artifacts.portable).toBe('tools/helper')
    } finally {
      downloaded.cleanup()
    }
  })

  test('download verifies and extracts a referenced package', async () => {
    const root = reset('package')
    const packageRoot = join(root, 'package')
    mkdirSync(packageRoot, { recursive: true })
    const packageManifest = {
      name: 'example-skill',
      version: '1.2.3',
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
