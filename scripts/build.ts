import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillCatalog } from '../src/skill-catalog'
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

const installerManifest = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8')) as Record<string, unknown>
if (installerManifest.name !== 'jls') throw new Error('installer manifest name must be jls')

// Validate the pointer-only catalog at build time. src/skill-catalog.ts imports the
// same file, so Bun embeds this exact repository list into the executable.
parseSkillCatalog(JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8')))

const buildVersion = process.env.JLS_BUILD_VERSION?.trim()
if (!buildVersion || !semver.test(buildVersion)) {
  throw new Error(`JLS_BUILD_VERSION must be plain semver: ${String(buildVersion)}`)
}

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
  '--define',
  `process.env.JLS_BUILD_VERSION=${JSON.stringify(buildVersion)}`,
  '--outfile',
  output,
], {
  cwd: repo,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
if (installerBuild.exitCode !== 0) process.exit(installerBuild.exitCode)

console.log(`Built ${output}`)
