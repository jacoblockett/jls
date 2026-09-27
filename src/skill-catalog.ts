import rawCatalog from '../catalog.json'

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const skillNamePattern = /^[a-z0-9][a-z0-9-]*$/

export function parseSkillCatalog(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('catalog.json must be a non-empty array of GitHub repositories')
  }

  const repositories = value.map((entry, index) => {
    if (typeof entry !== 'string' || !repositoryPattern.test(entry)) {
      throw new Error(`catalog.json[${index}] must be an owner/repository pointer`)
    }
    return entry
  })

  if (new Set(repositories).size !== repositories.length) {
    throw new Error('catalog.json cannot contain duplicate repositories')
  }

  return repositories
}

export function expectedSkillNameFromRepository(repository: string): string | undefined {
  if (!repositoryPattern.test(repository)) throw new Error(`invalid skill repository ${repository}`)
  const name = repository.slice(repository.indexOf('/') + 1)
  if (!name.startsWith('jls-')) return undefined
  const skill = name.slice(4)
  if (!skillNamePattern.test(skill)) {
    throw new Error(`repository ${repository} does not yield a valid JLS skill name`)
  }
  return skill
}

// catalog.json is bundled into compiled installers. JLS therefore owns only the
// repository pointers; every substantive skill contract remains with the skill.
export const SKILL_REPOSITORIES = Object.freeze(parseSkillCatalog(rawCatalog))
