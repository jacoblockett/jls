import { expect, test } from 'bun:test'
import { renderResource } from '../src/resource-render'

const token = '{{JLS_MAP_CLI}}'
const template = `developer_instructions = """\nUse only \`${token}\`.\n"""\n`

test('TOML resources escape Windows paths without changing the represented path', () => {
  const windowsPath = 'C:\\Users\\jacob\\Downloads\\jls-test\\.jls\\map\\bin\\map.exe'
  const rendered = renderResource(template, { [token]: windowsPath }, 'map-state-writer.toml')

  expect(rendered).toContain('C:\\\\Users\\\\jacob\\\\Downloads\\\\jls-test\\\\.jls\\\\map\\\\bin\\\\map.exe')
  expect(rendered).not.toContain('C:\\Users\\jacob\\Downloads')
})

test('TOML resources leave Linux and macOS paths unchanged', () => {
  for (const path of [
    '/home/jacob/project/.jls/map/bin/map',
    '/Users/jacob/project/.jls/map/bin/map',
  ]) {
    expect(renderResource(template, { [token]: path }, 'map-state-writer.toml')).toContain(path)
  }
})

test('non-TOML resources retain native Windows paths', () => {
  const windowsPath = 'C:\\Users\\jacob\\project\\.jls\\map\\bin\\map.exe'
  expect(renderResource(`CLI: ${token}\n`, { [token]: windowsPath }, 'AGENTS.md')).toBe(`CLI: ${windowsPath}\n`)
})

test('resources render multiple managed-tool tokens independently', () => {
  const template = 'history={{HISTORY_CLI}}\nscreenshot={{SCREENSHOT_CLI}}\n'
  const rendered = renderResource(template, {
    '{{HISTORY_CLI}}': '/project/.jls/inspiration/bin/history',
    '{{SCREENSHOT_CLI}}': '/project/.jls/inspiration/bin/screenshot',
  }, 'agent.md')
  expect(rendered).toContain('history=/project/.jls/inspiration/bin/history')
  expect(rendered).toContain('screenshot=/project/.jls/inspiration/bin/screenshot')
})
