import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  cleanupSpecs,
  detectGeneratedCleanup,
  removeGeneratedCleanup,
  type BeadsMetadataCleanupSpec,
} from '../src/generated-cleanup'

const repo = resolve(import.meta.dir, '..')
const scratch = join(repo, 'build', 'generated-cleanup-tests')

function reset(name: string): string {
  const root = join(scratch, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}

describe('generated cleanup manifest contract', () => {
  test('supports bounded paths and explicit Beads metadata cleanup', () => {
    const specs = cleanupSpecs({
      name: 'example',
      generated_data: [{ path: '.example', marker: 'project.json', description: 'Example data' }],
      generated_cleanup: [{
        kind: 'beads-metadata',
        description: 'Generated issues',
        metadata_key: 'jls-tasks',
        metadata_value: 'owned',
      }],
    })
    expect(specs).toEqual([
      { kind: 'path', path: '.example', marker: 'project.json', description: 'Example data' },
      {
        kind: 'beads-metadata',
        description: 'Generated issues',
        metadataKey: 'jls-tasks',
        metadataValue: 'owned',
      },
    ])
  })

  test('rejects traversal rather than allowing cleanup outside the selected scope', () => {
    expect(() => cleanupSpecs({ name: 'bad', generated_data: [{ path: '../outside' }] })).toThrow('relative contained path')
  })
})

describe('Beads provenance cleanup', () => {
  test('detects only exact structured metadata and ignores matching prose', () => {
    const root = reset('beads-detect')
    mkdirSync(join(root, '.beads'))
    const calls: string[][] = []
    const runner = (_command: string, args: string[]) => {
      calls.push(args)
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify([
          { id: 'bd-owned', title: 'ordinary', metadata: { 'jls-tasks': 'owned' } },
          { id: 'bd-wrong', title: 'ordinary', metadata: { 'jls-tasks': 'other' } },
          { id: 'bd-prose', title: 'jls-tasks owned', metadata: {} },
          { id: 'bd-none', description: 'mentions jls-tasks', metadata: null },
        ]),
      }
    }
    const detected = detectGeneratedCleanup(root, {
      name: 'tasks',
      generated_cleanup: [{
        kind: 'beads-metadata',
        description: 'Tasks issues',
        metadata_key: 'jls-tasks',
        metadata_value: 'owned',
      }],
    }, runner)
    expect(detected).toHaveLength(1)
    expect(detected[0]?.issueIds).toEqual(['bd-owned'])
    expect(calls[0]).toEqual(['list', '--metadata-field', 'jls-tasks=owned', '--json', '--limit', '0'])
  })

  test('requeries exact metadata immediately before deleting exact IDs', () => {
    const root = reset('beads-remove')
    mkdirSync(join(root, '.beads'))
    const calls: string[][] = []
    const runner = (_command: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'list') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify([
            { id: 'bd-1', metadata: { 'jls-tasks': 'owned' } },
            { id: 'bd-2', metadata: { 'jls-tasks': 'owned' } },
            { id: 'bd-3', title: 'jls-tasks', metadata: {} },
          ]),
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const spec: BeadsMetadataCleanupSpec = {
      kind: 'beads-metadata',
      description: 'Tasks issues',
      metadataKey: 'jls-tasks',
      metadataValue: 'owned',
    }
    removeGeneratedCleanup(root, { skill: 'tasks', description: spec.description, spec, issueIds: ['stale-id'] }, runner)
    expect(calls[1]).toEqual(['delete', 'bd-1', 'bd-2', '--force'])
  })
})

describe('path cleanup', () => {
  test('requires the declared marker and removes only the declared path', () => {
    const root = reset('path')
    const generated = join(root, '.map')
    mkdirSync(generated)
    writeFileSync(join(generated, 'project.json'), '{}')
    writeFileSync(join(root, 'keep.txt'), 'keep')
    const detected = detectGeneratedCleanup(root, {
      name: 'map',
      generated_data: [{ path: '.map', marker: 'project.json', description: 'Map data' }],
    })
    expect(detected).toHaveLength(1)
    removeGeneratedCleanup(root, detected[0]!)
    expect(existsSync(generated)).toBe(false)
    expect(existsSync(join(root, 'keep.txt'))).toBe(true)
  })
})
