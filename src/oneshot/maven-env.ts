import { createHash } from 'crypto'
import * as os from 'os'
import * as path from 'path'

export const ONESHOT_SCRATCH_BASE_ENV = 'ONESHOT_SCRATCH_BASE_PATH'

export const MAVEN_ARTIFACTORY_SSL_OPTS = [
  '-Dmaven.wagon.http.ssl.insecure=true',
  '-Dmaven.wagon.http.ssl.allowall=true',
  '-Daether.connector.https.securityMode=insecure',
]

export function buildOneShotScratchPath(
  workspacePath: string,
  stage: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const basePath = env[ONESHOT_SCRATCH_BASE_ENV] || path.join(os.tmpdir(), 'oneshot')
  const digest = createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 12)
  return path.join(basePath, digest, stage)
}

export function stripMavenRepoLocalOption(mavenOpts: string): string {
  return mavenOpts
    .split(/\s+/)
    .filter((part) => part.trim().length > 0)
    .filter((part) => !part.startsWith('-Dmaven.repo.local='))
    .join(' ')
}

export function buildMavenScratchEnv(
  baseEnv: NodeJS.ProcessEnv,
  scratchPath: string,
): NodeJS.ProcessEnv {
  const sanitizedMavenOpts = stripMavenRepoLocalOption(baseEnv.MAVEN_OPTS ?? '')
  const mavenRepoLocalOpt = `-Dmaven.repo.local=${path.join(scratchPath, '.m2', 'repository')}`
  const missingDefaults = [...MAVEN_ARTIFACTORY_SSL_OPTS, mavenRepoLocalOpt]
    .filter((opt) => !sanitizedMavenOpts.includes(opt))

  return {
    ...baseEnv,
    MAVEN_OPTS: [sanitizedMavenOpts, ...missingDefaults].filter(Boolean).join(' '),
  }
}
