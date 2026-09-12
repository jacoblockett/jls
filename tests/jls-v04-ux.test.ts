import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { scopeActionOptions, validateCustomPath } from '../src/jls-v04'

const repo = resolve(import.meta.dir, '..')

describe('0.4 installer scope UX', () => {
  test('unavailable scope actions are omitted rather than disabled', () => {
    expect(scopeActionOptions(false)).toEqual([
      { value: 'install', label: 'Install new skills' },
    ])
    expect(scopeActionOptions(true).map((option) => option.label)).toEqual([
      'Install new skills',
      'Check for updates',
      'Uninstall existing skills',
    ])
  })

  test('custom paths must already exist and be directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'jls-ux-'))
    try {
      expect(validateCustomPath(root)).toBeUndefined()
      expect(validateCustomPath(join(root, 'missing'))).toBe('That path does not exist.')
      const file = join(root, 'file.txt')
      writeFileSync(file, 'x')
      expect(validateCustomPath(file)).toBe('That path is not a directory.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('0.4 installer wording contract', () => {
  const source = readFileSync(join(repo, 'src', 'jls-v04.ts'), 'utf8')

  test('generated-data question matches the approved wording', () => {
    expect(source).toContain('The following skills you selected have data generated beyond its installation. If you would like to retain any of this data, deselect the options below before continuing.')
  })

  test('instruction injection question carries its own context', () => {
    expect(source).toContain('The following skills have instructions to inject into your ${names} ${noun}. You can opt out of any of these if you like. See above for an explanation of ${referent}.')
    expect(source).toContain('AI tools can use instruction files to receive extra directions about how they should work in a project.')
  })

  test('harness picker is opt-out and defaults all available harnesses on', () => {
    expect(source).toContain('The following supported AI harnesses were detected. You can opt out of any of these if you like.')
    expect(source).toContain('initialValues: enabledHarnesses')
  })

  test('No and Backspace share the same confirmation result', () => {
    expect(source).toContain("if (choice === BACK_SIGNAL || choice === 'no') return BACK_SIGNAL")
  })

  test('summaries use ASCII asterisk bullets', () => {
    expect(source).toContain('`* ${displaySkillName(skill)}`')
    expect(source).toContain("lines.push('  * Skill/agent files: Remove')")
  })

  test('no-update result is a warning node', () => {
    expect(source).toContain("prompts.log.warn('No updates were found.')")
  })
})
