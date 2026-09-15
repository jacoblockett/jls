import { describe, expect, test } from 'bun:test'
import { stripVTControlCharacters } from 'node:util'
import {
  ExclusiveMultiSelectPrompt,
  applyExclusiveToggle,
  optionText,
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

describe('exclusive multiselect behavior', () => {
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

  test('a lone enabled option is not silently selected', () => {
    const p = new ExclusiveMultiSelectPrompt<string>({
      options: [{ value: 'only', label: 'Only option' }],
      initialValues: [],
      allowBack: true,
      render() { return '' },
    })
    expect(p.value).toEqual([])
    p.emit('cursor', 'space')
    expect(p.value).toEqual(['only'])
  })

  test('disabled options hide descriptions but retain user-relevant status', () => {
    const option = {
      value: 'map',
      label: 'Map',
      description: 'extra details',
      disabledSuffix: ' (installed)',
    }
    const disabled = stripVTControlCharacters(optionText({ ...option, disabled: true }, 'disabled'))
    expect(disabled).toContain('Map')
    expect(disabled).toContain('(installed)')
    expect(disabled).not.toContain('extra details')

    const active = stripVTControlCharacters(optionText(option, 'active'))
    expect(active).toContain('extra details')
  })
})
