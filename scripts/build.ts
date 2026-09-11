import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hostMatchesTarget,
  installerAssetName,
  targetByKey,
} from '../src/targets'

const repo = join(import.meta.dir, '..')
const out = join(repo, 'build')
const semver = /^\d+\.\d+\.\d+$/
const buildTarget = targetByKey(process.env.JLS_BUILD_TARGET?.trim() || 'windows-x64')

mkdirSync(out, { recursive: true })

if (!hostMatchesTarget(buildTarget)) {
  throw new Error(`build target ${buildTarget.key} does not match this host OS/architecture`)
}

type SkillReference = { manifest_url: string }
type Catalog = { format: 1; skills: Record<string, SkillReference> }
type InstallerManifest = { format: 1; name: 'jls'; version: string }

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readCatalog(): Catalog {
  const raw = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8')) as Record<string, unknown>
  if (raw.format !== 1) throw new Error('catalog format must be 1')
  if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
    throw new Error('catalog skills must be an object')
  }

  const skills: Record<string, SkillReference> = {}
  for (const [name, value] of Object.entries(raw.skills as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid catalog skill name ${name}`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid catalog skill ${name}`)
    const manifestUrl = (value as Record<string, unknown>).manifest_url
    if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) throw new Error(`${name} catalog entry requires manifest_url`)
    const parsed = new URL(manifestUrl)
    if (parsed.protocol !== 'https:') throw new Error(`${name} manifest_url must use HTTPS`)
    skills[name] = { manifest_url: manifestUrl }
  }
  return { format: 1, skills }
}

function readInstallerManifest(): InstallerManifest {
  const raw = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8')) as Record<string, unknown>
  if (raw.format !== 1) throw new Error('installer manifest format must be 1')
  if (raw.name !== 'jls') throw new Error('installer manifest name must be jls')
  if (typeof raw.version !== 'string' || !semver.test(raw.version)) {
    throw new Error(`manifest.json version must be plain semver: ${String(raw.version)}`)
  }
  return { format: 1, name: 'jls', version: raw.version }
}

const installerVersion = readInstallerManifest().version
const installerName = installerAssetName(buildTarget)
const output = join(out, installerName)
rmSync(output, { force: true })

const installerBuild = Bun.spawnSync([
  process.execPath,
  'build',
  join(repo, 'src', 'jls.ts'),
  '--compile',
  `--target=${buildTarget.bunCompileTarget}`,
  '--define',
  `JLS_COMPILED_TARGET=${JSON.stringify(buildTarget.key)}`,
  '--outfile',
  output,
], {
  cwd: repo,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
if (installerBuild.exitCode !== 0) process.exit(installerBuild.exitCode)

const releaseTag = process.env.JLS_RELEASE_TAG?.trim() || 'dev'
if (!/^[A-Za-z0-9._-]+$/.test(releaseTag)) throw new Error(`invalid release tag: ${releaseTag}`)
const releaseBase = `https://github.com/jacoblockett/jls/releases/download/${releaseTag}`
const catalog = readCatalog()

const releaseManifest = {
  format: 3,
  installer: {
    version: installerVersion,
    artifacts: {
      [buildTarget.key]: {
        url: `${releaseBase}/${installerName}`,
        sha256: sha256(output),
      },
    },
  },
  skills: catalog.skills,
}

const manifestOutput = join(out, 'manifest.json')
writeFileSync(manifestOutput, `${JSON.stringify(releaseManifest, null, 2)}\n`)

console.log(`Built ${output}`)
console.log(`Built ${manifestOutput}`)
