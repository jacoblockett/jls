import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  TARGET_KEYS,
  installerAssetName,
  targetByKey,
  type TargetKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')
const semver = /^\d+\.\d+\.\d+$/

export type AggregateOptions = {
  inputRoot: string
  outputRoot: string
  version: string
  releaseTag: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function aggregateRelease({ inputRoot, outputRoot, version, releaseTag }: AggregateOptions): void {
  if (!semver.test(version)) throw new Error(`invalid installer version: ${version}`)
  if (!/^[A-Za-z0-9._-]+$/.test(releaseTag)) throw new Error(`invalid release tag: ${releaseTag}`)

  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  const artifacts: Record<TargetKey, { url: string; sha256: string }> = {} as Record<TargetKey, { url: string; sha256: string }>
  for (const key of TARGET_KEYS) {
    const name = installerAssetName(targetByKey(key))
    const source = join(inputRoot, `target-${key}`, name)
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`required installer artifact is missing: target-${key}/${name}`)
    }
    const destination = join(outputRoot, name)
    copyFileSync(source, destination)
    artifacts[key] = {
      url: `https://github.com/jacoblockett/jls/releases/download/${releaseTag}/${name}`,
      sha256: sha256(destination),
    }
  }

  // Legacy installers resolve their own updates through this file. New
  // installers do not consume it, and it intentionally carries no skill data.
  writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify({
    installer: { version, artifacts },
    skills: {},
  }, null, 2)}\n`)

  console.log(`Aggregated ${TARGET_KEYS.length} required installer targets into ${outputRoot}`)
}

if (import.meta.main) {
  const version = process.env.JLS_BUILD_VERSION?.trim()
  const releaseTag = process.env.JLS_RELEASE_TAG?.trim()
  if (!version) throw new Error('JLS_BUILD_VERSION is required for release aggregation')
  if (!releaseTag) throw new Error('JLS_RELEASE_TAG is required for release aggregation')

  aggregateRelease({
    inputRoot: resolve(process.env.JLS_AGGREGATE_INPUT?.trim() || join(repo, 'build', 'targets')),
    outputRoot: resolve(process.env.JLS_AGGREGATE_OUTPUT?.trim() || join(repo, 'build', 'release')),
    version,
    releaseTag,
  })
}
