import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  TARGET_KEYS,
  installerAssetName,
  targetByKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')

export type AggregateOptions = {
  inputRoot: string
  outputRoot: string
}

export function aggregateRelease({ inputRoot, outputRoot }: AggregateOptions): void {
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  for (const key of TARGET_KEYS) {
    const name = installerAssetName(targetByKey(key))
    const source = join(inputRoot, `target-${key}`, name)
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`required installer artifact is missing: target-${key}/${name}`)
    }
    copyFileSync(source, join(outputRoot, name))
  }

  console.log(`Aggregated ${TARGET_KEYS.length} required installer targets into ${outputRoot}`)
}

if (import.meta.main) {
  aggregateRelease({
    inputRoot: resolve(process.env.JLS_AGGREGATE_INPUT?.trim() || join(repo, 'build', 'targets')),
    outputRoot: resolve(process.env.JLS_AGGREGATE_OUTPUT?.trim() || join(repo, 'build', 'release')),
  })
}
