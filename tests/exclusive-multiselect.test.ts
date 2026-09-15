import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ExclusiveMultiSelectPrompt,
  applyExclusiveToggle,
  type ExclusiveOption,
} from '../src/exclusive-multiselect'

const options: ExclusiveOption<string>[] = [
  { value: 'codex', label: 'OpenAI Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'disabled', label: 'Already installed', disabled: true },
]

function prompt(initialValues: string[] = [], cursorAt?: string): ExclusiveMultiSelectPrompt<string> {
  return new ExclusiveMultiSelectPrompt<string>({
    options,
    initialValues,
    cursorAt,
    allowBack: true,
    render() { return '' },
  })
}

describe('exclusive multiselect keyboard policy', () => {
  test('space toggles the highlighted ordinary option live before submit', () => {
    const p = prompt()
    p.emit('cursor', 'space')
    expect(p.value).toEqual(['codex'])

    p.emit('cursor', 'space')
    expect(p.value).toEqual([])
  })

  test('toggle helper preserves ordinary multiselect behavior', () => {
    expect(applyExclusiveToggle(['codex'], options[1], options)).toEqual(['codex', 'claude'])
    expect(applyExclusiveToggle(['codex', 'claude'], options[0], options)).toEqual(['claude'])
  })

  test('A toggles all enabled ordinary options and excludes disabled items', () => {
    const p = prompt()
    p.emit('key', undefined, { name: 'a' } as any)
    expect(p.value).toEqual(['codex', 'claude'])

    p.emit('key', undefined, { name: 'a' } as any)
    expect(p.value).toEqual([])
  })

  test('I retains the existing invert-selection shortcut', () => {
    const p = prompt(['codex'])
    p.emit('key', undefined, { name: 'i' } as any)
    expect(p.value).toEqual(['claude'])
  })

  test('Backspace requests navigation back without becoming a selection', () => {
    const p = prompt(['codex'])
    p.emit('key', undefined, { name: 'backspace' } as any)
    expect(p.backRequested).toBe(true)
    expect(p.value).toEqual(['codex'])
    expect(p.state).toBe('submit')
  })

  test('cursorAt restores the previous highlighted option', () => {
    const p = prompt([], 'claude')
    expect(p.cursor).toBe(1)
  })
})

describe('installer option presentation', () => {
  test('installer source does not use Clack option hints, pseudo-options, or inline confirmations', () => {
    const repo = resolve(import.meta.dir, '..')
    const source = readFileSync(join(repo, 'src', 'jls.ts'), 'utf8')
    expect(source).not.toContain('hint:')
    expect(source).not.toContain("label: 'All of the above'")
    expect(source).not.toContain("label: 'Go back'")
    expect(source).not.toContain("label: 'Cancel & exit'")
    expect(source).not.toContain('prompts.confirm(')
  })

  test('custom prompt footers use explicit key names except for navigation arrows', () => {
    const repo = resolve(import.meta.dir, '..')
    const multiselect = readFileSync(join(repo, 'src', 'exclusive-multiselect.ts'), 'utf8')
    const navigation = readFileSync(join(repo, 'src', 'nav-prompts.ts'), 'utf8')

    for (const text of ['↑/↓', 'Enter', 'Backspace', 'Esc']) {
      expect(multiselect).toContain(text)
      expect(navigation).toContain(text)
    }
    for (const text of ['Space', 'A']) expect(multiselect).toContain(text)

    for (const glyph of ['␣', '↵', '←', '⎋', '⌫', '␛']) {
      expect(multiselect).not.toContain(glyph)
      expect(navigation).not.toContain(glyph)
    }
  })

  test('disabled options suppress descriptions while preserving status suffixes', () => {
    const repo = resolve(import.meta.dir, '..')
    const multiselect = readFileSync(join(repo, 'src', 'exclusive-multiselect.ts'), 'utf8')
    expect(multiselect).toContain("const description = state === 'disabled'")
    expect(multiselect).toContain("? ''")
    expect(multiselect).toContain("styleText(['strikethrough', 'gray'], label)}${description}${suffix}")
  })

  test('Map picker description is concise catalog metadata', () => {
    const repo = resolve(import.meta.dir, '..')
    const catalog = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8'))
    expect(catalog.skills.map.description).toBe('Durable intent graph for decisions and goals')
  })
})
