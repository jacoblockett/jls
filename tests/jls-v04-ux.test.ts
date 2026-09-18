import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateCustomPath } from '../src/jls-v04'

describe('installer scope behavior', () => {

  test('custom management paths must exist and be directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-ux-'))
    try {
      expect(validateCustomPath(root)).toBeUndefined()
      expect(validateCustomPath(join(root, 'missing'))).toBeDefined()
      const file = join(root, 'file.txt')
      writeFileSync(file, 'x')
      expect(validateCustomPath(file)).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
