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

describe('0.4 installer wording and rendering contract', () => {
  const source = readFileSync(join(repo, 'src', 'jls-v04.ts'), 'utf8')

  test('generated-data question matches the approved wording', () => {
    expect(source).toContain('The following skills you selected have data generated beyond its installation. If you would like to retain any of this data, deselect the options below before continuing.')
  })

  test('instruction injection question carries its own context', () => {
    expect(source).toContain('The following skills have instructions to inject into your ${names} ${noun}. You can opt out of any of these if you like. See above for an explanation of ${referent}.')
    expect(source).toContain('AI tools can use instruction files to receive extra directions about how they should work in a project.')
  })

  test('harness picker uses the approved wording and defaults all feasible harnesses on', () => {
    expect(source).toContain("For which of the following AI harnesses would you like to install your selected skills? If you don't see your desired harness here, it is either undetected or unsupported.")
    expect(source).toContain('initialValues: enabledHarnesses')
    expect(source).not.toContain('The following supported AI harnesses were detected. You can opt out of any of these if you like.')
  })

  test('single feasible choices and empty scopes skip redundant screens', () => {
    expect(source).toContain('if (enabled.length === 1) {')
    expect(source).toContain('const harnessWasPrompted = enabledHarnesses.length > 1')
    expect(source).toContain('selectedAgents = enabledHarnesses')
    expect(source).toContain("noSkillsDetected ? 'No skills detected. Which skills would you like to install?' : 'Which skills would you like to install?'")
    expect(source).toContain('if (!hasInstalled) {')
    expect(source).toContain('const result = await installAtScope(scope, state, `${prefix}.install`, true)')
  })

  test('zero detected harnesses stop installation explicitly', () => {
    expect(source).toContain('if (detected.length === 0) {')
    expect(source).toContain("prompts.log.warn('No supported AI harnesses were detected.')")
  })

  test('No and Backspace share the same confirmation result', () => {
    expect(source).toContain("if (choice === BACK_SIGNAL || choice === 'no') return BACK_SIGNAL")
  })

  test('uses Clack path selection for custom scopes', () => {
    expect(source).toContain('await prompts.path({')
    expect(source).toContain('directory: true')
    expect(source).toContain('validate: validateCustomPath')
  })

  test('installed skills carry an explicit already-installed suffix', () => {
    expect(source).toContain("disabledSuffix: installedEverywhere ? ' (already installed)' : undefined")
  })

  test('summaries show the concrete path, dim bullets, and avoid self-reference', () => {
    expect(source).toContain("'The following skills will be installed:'")
    expect(source).toContain("'The following skills will be updated:'")
    expect(source).toContain("'The following skills will be uninstalled:'")
    expect(source).toContain('scope.root')
    expect(source).toContain("return styleText('dim', `${indent}• ${text}`)")
    expect(source).not.toContain('JLS Installer will install')
    expect(source).not.toContain('JLS Installer will update')
    expect(source).not.toContain('JLS Installer will uninstall')
    expect(source).toContain('const showGeneratedDetail = removeData.size > 0')
    expect(source).toContain('if (!showGeneratedDetail || !cleanupSkills.has(group.skill)) continue')
  })

  test('skill and installer no-update messages match and use info', () => {
    expect(source.match(/prompts\.log\.info\('No updates were found\.'\)/g)?.length).toBe(2)
  })

  test('interactive lifecycle work is quiet, spinner-backed, and does not append an empty outro', () => {
    expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe']")
    expect(source).toContain('spinner.start(`${words.progress} ${name}`)')
    expect(source).toContain('prompts.log.success(`${words.success} ${name}`)')
    expect(source).toContain("if (level === 'success') prompts.log.success('Done.')")
    expect(source).toContain("else prompts.log.info('Done.')")
    expect(source).not.toContain('prompts.outro()')
  })

  test('installer uninstall delegates to the verified cross-platform remover', () => {
    expect(source).toContain("import { prepareInstallerSelfUninstall } from './self-uninstall'")
    expect(source).toContain('completion = await prepareInstallerSelfUninstall(executable, installerDataRoot())')
    expect(source).not.toContain('ping 127.0.0.1')
    expect(source).not.toContain("'sleep 1;")
    expect(source).not.toContain('scheduleInstallerUninstall(')
  })
})
