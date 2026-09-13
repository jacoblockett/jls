import * as prompts from '@clack/prompts'
import { main } from './jls-v04'

const interactive = process.argv.slice(2).length === 0 && process.stdout.isTTY

main()
  .then((exitCode) => { process.exitCode = exitCode })
  .catch((error) => {
    const message = `jls: ${error instanceof Error ? error.message : String(error)}`
    if (interactive) {
      prompts.log.error(message)
      prompts.outro('')
    } else {
      console.error(message)
    }
    process.exitCode = 1
  })
