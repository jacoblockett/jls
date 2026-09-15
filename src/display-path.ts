import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

function inside(root: string, target: string): string | undefined {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel
}

export function displayManagedPath(scopeRoot: string, target: string): string {
  const rel = inside(scopeRoot, target)
  if (rel === undefined) return target
  // The selected management root is user-facing context, so render it as the
  // native absolute path. Descendants remain scope-localized for diagnostics.
  if (rel === '') return resolve(scopeRoot)
  const anchor = basename(resolve(scopeRoot)) || basename(scopeRoot) || scopeRoot
  return `/${[anchor, ...rel.split(/[\\/]+/)].filter(Boolean).join('/')}`
}
