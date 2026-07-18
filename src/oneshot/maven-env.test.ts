import { describe, expect, it } from 'vitest'
import {
  buildMavenScratchEnv,
  stripMavenRepoLocalOption,
} from './maven-env.js'

describe('maven-env', () => {
  it('strips repo-local Maven repository options', () => {
    expect(
      stripMavenRepoLocalOption(
        '-Xmx2g -Dmaven.repo.local=.m2/repository -Dkeep=true',
      ),
    ).toBe('-Xmx2g -Dkeep=true')
  })

  it('adds scratch Maven repository while preserving inherited Maven env', () => {
    const env = buildMavenScratchEnv(
      {
        MAVEN_OPTS:
          '-Dmaven.repo.local=.m2/repository -Dkeep=true -Dpassword=super-secret',
        MAVEN_USER: 'secret-user',
        MAVEN_PASSWORD: 'secret-password',
      },
      '/tmp/oneshot/run/tester',
    )

    expect(env.MAVEN_OPTS).toContain(
      '-Dmaven.repo.local=/tmp/oneshot/run/tester/.m2/repository',
    )
    expect(env.MAVEN_OPTS).toContain('-Dkeep=true')
    expect(env.MAVEN_OPTS).not.toContain('-Dmaven.repo.local=.m2/repository')
    expect(env.MAVEN_USER).toBe('secret-user')
    expect(env.MAVEN_PASSWORD).toBe('secret-password')
  })
})
