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
    format: 1,
    name: 'example-skill',
    version: '1.2.3',
    min_installer: '0.3.2',
    description: 'Example',
    skill_files: ['SKILL.md'],
  }
}

describe('file-explicit package ownership contract', () => {
  test('generated-data cleanup declarations require an identifying marker', () => {
    expect(() => parseSkillPackageManifest({
      ...baseManifest(),
      generated_data: [{ path: '.example' }],
    })).toThrow('generated_data[0].marker')
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

  test('installation declarations may name exact files but not directories', async () => {
    const manifest = { ...baseManifest(), skill_files: ['assets'] }
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`))
    zip.addFile('assets/file.txt', Buffer.from('owned leaf\n'))
    const bytes = new Uint8Array(zip.toBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const released: ReleasedSkill = {
      version: '1.2.3',
      min_installer: '0.3.2',
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
    )).rejects.toThrow('package declaration must reference a file: assets')
  })
})
