import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { displayManagedPath } from '../src/display-path'

describe('scope-localized path rendering', () => {
  test('keeps the selected root intact and localizes descendants to that root name', () => {
    const root = resolve('tmp', 'test', 'v1')
    expect(displayManagedPath(root, root)).toBe(root)
    expect(displayManagedPath(root, join(root, '.map'))).toBe('/v1/.map')
    expect(displayManagedPath(root, join(root, '.jls', 'map', 'bin'))).toBe('/v1/.jls/map/bin')
  })

  test('leaves paths outside the selected root unchanged', () => {
    const root = resolve('tmp', 'test', 'v1')
    const outside = resolve('tmp', 'elsewhere', 'file.txt')
    expect(displayManagedPath(root, outside)).toBe(outside)
  })
})
