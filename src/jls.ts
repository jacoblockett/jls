import { main } from './jls-v04'

main()
  .then((exitCode) => { process.exitCode = exitCode })
  .catch((error) => {
    console.error(`jls: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
