import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  const navigation = readFileSync(join(repo, 'src', 'nav-prompts.ts'), 'utf8')
  const multiselect = readFileSync(join(repo, 'src', 'exclusive-multiselect.ts'), 'utf8')

  test('generic prompt helpers never auto-select a lone option', () => {
    expect(source).not.toContain('if (enabled.length === 1) {')
    expect(source).not.toContain('if (required && selectable.length === 1) {')
  })

  test('generated-data question matches the approved wording', () => {
    expect(source).toContain('The following skills you selected have data generated beyond its installation. If you would like to retain any of this data, deselect the options below before continuing.')
  })

  test('instruction injection uses the requested plural wording and a skill-specific single confirmation', () => {
    expect(source).toContain('The following skills have instructions to inject into your ${names} ${noun}. Deselect any of these you wish not to be injected. See above for more information.')
    expect(source).toContain('The ${displaySkillName(skill)} skill has instructions to inject into your ${names} ${noun}. Would you like them to be injected? See above for more information.')
    expect(source).toContain("{ value: 'inject', label: 'Inject' }")
    expect(source).toContain("{ value: 'skip', label: 'Do not inject' }")
    expect(source).toContain('AI tools can use instruction files to receive extra directions about how they should work in a project.')
    expect(source).not.toContain('You can opt out of any of these if you like.')
  })

  test('install always presents the full skill catalog and marks only fully installed skills unavailable', () => {
    expect(source).toContain('const skillItems: ChoiceItem[] = Object.keys(release.skills).sort().map((skill) => {')
    expect(source).toContain('const installedEverywhere = detected.every((agent) => targetInstalled(scope, skill, agent.id))')
    expect(source).toContain("disabledSuffix: installedEverywhere ? ' (installed)' : undefined")
    expect(source).toContain("noSkillsDetected ? 'No skills detected. Which skills would you like to install?' : 'Which skills would you like to install?'")
    expect(source).toContain("prompts.log.warn('No skills are available to install because all available skills are already installed.')")
  })

  test('disabled status text remains dim and outside the struck label', () => {
    expect(multiselect).toContain("const suffix = option.disabledSuffix ? styleText('dim', option.disabledSuffix) : ''")
    expect(multiselect).toContain("styleText(['strikethrough', 'gray'], label)}${description}${suffix}")
    expect(multiselect).not.toContain("styleText(['strikethrough', 'gray'], `${label}${suffix}`)")
  })

  test('harness picker skips only when exactly one supported harness is detected', () => {
    expect(source).toContain("For which of the following AI harnesses would you like to install your selected skills? If you don't see your desired harness here, it is either undetected or unsupported.")
    expect(source).toContain('const harnessWasPrompted = detected.length > 1')
    expect(source).toContain('initialValues: enabledHarnesses')
    expect(source).toContain("disabledSuffix: alreadyInstalled ? ' (already installed)' : undefined")
    expect(source).toContain('selectedAgents = enabledHarnesses')
    expect(source).not.toContain('const harnessWasPrompted = enabledHarnesses.length > 1')
  })

  test('empty scopes skip only the redundant action screen and proceed to skill selection', () => {
    expect(source).toContain('if (!hasInstalled) {')
    expect(source).toContain('const result = await installAtScope(scope, state, `${prefix}.install`, true)')
  })

  test('single update uses binary confirmation while multiple updates use an all-off multiselect', () => {
    expect(source).toContain('if (available.length === 1) {')
    expect(source).toContain('Would you like to update the ${displaySkillName(group.skill)} skill (${updateStatus(group, availableVersions)})?')
    expect(source).toContain("'The following updates are available. Please select which you would like to install.'")
    expect(source).toContain('{ allowBack: true, initialValues: [] }')
    expect(source).toContain("prompts.log.info('No updates were found.')")
  })

  test('single uninstall uses binary confirmation while multiple uninstalls use an all-off multiselect', () => {
    expect(source).toContain('Would you like to uninstall the ${displaySkillName(group.skill)} skill?')
    expect(source).toContain("'Which skills would you like to uninstall?'")
    expect(source).toContain("prompts.log.warn('No installed skills were found.')")
    expect(source).toContain("`${prefix}.single-confirm`")
  })

  test('navigation records Go back as the history hint', () => {
    expect(navigation).toContain("styleText('dim', 'Go back')")
    expect(navigation).toContain('if (prompt.backRequested) return `${title}${backHistory(hasGuide)}`')
    expect(multiselect).toContain("styleText('dim', 'Go back')")
    expect(multiselect).toContain('if (prompt.backRequested) return `${title}${backHistory(hasGuide)}`')
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

  test('all structured summaries normalize and dim paths without italicizing them, while dimming only bullet glyphs', () => {
    expect(source).toContain("'The following skills will be installed:'")
    expect(source).toContain("'The following skills will be updated:'")
    expect(source).toContain("'The following skills will be uninstalled:'")
    expect(source).toContain("return styleText('dim', normalizedPath(scope.root))")
    expect(source).not.toContain("styleText(['italic', 'dim'], normalizedPath(scope.root))")
    expect(source).toContain("return `${indent}${styleText('dim', '•')} ${text}`")
    expect(source).not.toContain("styleText('dim', `${indent}• ${text}`)")
    expect(source).not.toContain('JLS Installer will install')
  })

  test('uninstall summary stays flat unless generated data is actually selected for removal', () => {
    expect(source).toContain('const showGeneratedDetail = removeData.size > 0')
    expect(source).toContain('if (!showGeneratedDetail || !cleanupSkills.has(group.skill)) continue')
    expect(source).toContain("lines.push(noteBullet('Skill/agent files: Remove', '  '))")
    expect(source).toContain("Generated data: ${removeData.has(group.skill) ? 'Remove' : 'Keep'}")
  })

  test('collisions are disclosed and warning wrapping leaves continuation guides to Clack', () => {
    expect(source).toContain("prompts.note(collisionSummary(collisions), 'Collisions detected')")
    expect(source).toContain('The following directories/files would be occupied/overwritten should installation continue. Installation in this case would be destructive and could cause permanent loss of data.')
    expect(source).toContain("prompts.log.warn(wrapLogMessage('See above. Installation has failed due to colliding directories/files. Would you like to continue with installation despite this collision?'))")
    expect(source).toContain('const width = columns - 3')
    expect(source).toContain("return lines.join('\\n')")
    expect(source).not.toContain("styleText('gray', '│')")
    expect(source).toContain('const destructiveProceed = await chooseConfirmation(state, `${prefix}.collision-confirm`, true)')
    expect(source).toContain('removeInstallCollisions(collisions)')
  })

  test('skill and installer no-update messages match and use info', () => {
    expect(source.match(/prompts\.log\.info\('No updates were found\.'\)/g)?.length).toBe(2)
  })

  test('interactive lifecycle subprocess is asynchronous so the spinner remains live and all progress nodes use info', () => {
    expect(source).toContain("const child = spawn(process.execPath, ['--core', ...args]")
    expect(source).toContain('spinner.start(`${words.progress} ${name}`)')
    expect(source).toContain('await runLifecycle(args)')
    expect(source).toContain('prompts.log.info(`${words.success} ${name}`)')
    expect(source).not.toContain('prompts.log.success(`${words.success} ${name}`)')
    expect(source).toContain("if (level === 'success') prompts.log.success('Done.')")
    expect(source).toContain("else prompts.log.info('Done.')")
    expect(source).not.toContain("prompts.outro('')")
  })

  test('installer update wording and replacement path match the accepted contract', () => {
    expect(source).toContain('An update was found. Would you like to update from v${VERSION} to v${update.version}? If you choose to update, this current session will end. You must relaunch the installer after updating.')
    expect(source).toContain("import { prepareInstallerReplacement } from './installer-replacement'")
    expect(source).toContain('await prepareInstallerReplacement(staged, executable)')
    expect(source).not.toContain('scheduleInstallerReplacement(staged, executable)')
  })

  test('successful installer self-uninstall exits silently while retaining failure handling', () => {
    expect(source).toContain('This will uninstall the current installer binary file from the location you launched it from and remove installer-owned metadata and tooling. Doing so will immediately end the current session. It will not, however, remove or uninstall any currently installed skills, agent files, agent instruction injections, skill runtimes, or generated data from skills.')
    expect(source).toContain("import { prepareInstallerSelfUninstall } from './self-uninstall'")
    expect(source).toContain('await prepareInstallerSelfUninstall(executable, installerDataRoot())')
    expect(source).not.toContain("if (completion === 'complete') finishOperation('success')")
    expect(source).not.toContain('ping 127.0.0.1')
    expect(source).not.toContain("'sleep 1;")
    expect(source).not.toContain('scheduleInstallerUninstall(')
  })
})
