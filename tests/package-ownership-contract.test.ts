import { describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import {
  downloadSkillPackage,
  parseSkillPackageManifest,
  type ReleasedSkill,
} from '../src/installer-updater'

function baseManifest() {
  return {
    name: 'example-skill',
    version: '1.2.3',
    description: 'Example',
    skill_files: ['SKILL.md'],
  }
}

describe('file-explicit package ownership contract', () => {
  test('generated-data cleanup declarations require an identifying marker', () => {
    expect(() => parseSkillPackageManifest({
      ...baseManifest(),
      generated_data: [{ path: '.example' }],
    })).toThrow()
  })

  test('legacy ownership_marker is ignored when the identifying marker is present', () => {
    const manifest = parseSkillPackageManifest({
      ...baseManifest(),
      generated_data: [{
        path: '.example',
        marker: 'project.json',
        ownership_marker: '.jls-owned.json',
      }],
    })
    expect(manifest.generated_data).toEqual([{ path: '.example', marker: 'project.json' }])
  })

  test('tool declarations own exact executable and support-file leaves', async () => {
    const manifest = {
      ...baseManifest(),
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
      tool_files: ['support/browser.dat'],
    }
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`))
    zip.addFile('SKILL.md', Buffer.from('# Skill\n'))
    zip.addFile('tools/windows-x64/history.exe', Buffer.from('history'))
    zip.addFile('tools/windows-x64/screenshot.exe', Buffer.from('screenshot'))
    zip.addFile('support/browser.dat', Buffer.from('support'))
    const bytes = new Uint8Array(zip.toBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const released: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        'windows-x64': { url: 'https://fixture.invalid/example.zip', sha256 },
      },
    }
    const fetcher = (async () => new Response(bytes)) as typeof fetch

    const downloaded = await downloadSkillPackage(
      'example-skill',
      released,
      fetcher,
      'windows-x64',
    )
    downloaded.cleanup()
  })

  test('installation declarations may name exact files but not directories', async () => {
    const manifest = { ...baseManifest(), skill_files: ['assets'] }
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`))
    zip.addFile('assets/file.txt', Buffer.from('owned leaf\n'))
    const bytes = new Uint8Array(zip.toBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const released: ReleasedSkill = {
      version: '1.2.3',
      artifacts: {
        'windows-x64': { url: 'https://fixture.invalid/example.zip', sha256 },
      },
    }
    const fetcher = (async () => new Response(bytes)) as typeof fetch

    await expect(downloadSkillPackage(
      'example-skill',
      released,
      fetcher,
      'windows-x64',
    )).rejects.toThrow()
  })
})
