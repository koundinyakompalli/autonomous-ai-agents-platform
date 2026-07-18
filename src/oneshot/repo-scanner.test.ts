import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatScanForPrompt, scanRepo } from './repo-scanner.js'

const tempDirs: string[] = []

describe('scanRepo', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir =>
      fs.rm(dir, { recursive: true, force: true }),
    ))
  })

  it('detects a basic TypeScript repository layout', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-repo-scan-'))
    tempDirs.push(workspacePath)

    await fs.mkdir(path.join(workspacePath, 'src', 'routes'), { recursive: true })
    await fs.writeFile(
      path.join(workspacePath, 'package.json'),
      JSON.stringify({
        name: 'sample-app',
        scripts: {
          test: 'vitest run',
        },
        dependencies: {
          react: '^19.0.0',
        },
        devDependencies: {
          vitest: '^3.0.0',
        },
      }, null, 2),
    )
    await fs.writeFile(path.join(workspacePath, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2))
    await fs.writeFile(path.join(workspacePath, 'src', 'routes', 'index.ts'), 'export const route = true\n')

    const result = await scanRepo(workspacePath)

    expect(result.techStack.primaryLanguage).toBe('typescript')
    expect(result.techStack.buildTool).toBe('npm')
    expect(result.techStack.testFramework).toBe('vitest')
    expect(result.techStack.frameworks).toContain('react')
    expect(result.projectStructure.rootFiles).toContain('package.json')
    expect(result.projectStructure.topLevelDirs).toContain('src')
    expect(result.projectGuidanceFiles).toEqual([])
    expect(result.keyFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'package.json', role: 'build_config' }),
        expect.objectContaining({ path: 'tsconfig.json', role: 'build_config' }),
      ]),
    )
  })

  it('detects repo-local project guidance as advisory planner context', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-repo-scan-'))
    tempDirs.push(workspacePath)

    await fs.mkdir(path.join(workspacePath, '.claude', 'rules'), { recursive: true })
    await fs.writeFile(path.join(workspacePath, '.clinerules'), 'Prefer service-layer tests.\n')
    await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), 'Use existing DAO patterns.\n')
    await fs.writeFile(
      path.join(workspacePath, '.claude', 'rules', 'testing.md'),
      'Test fixtures are advisory templates.\n',
    )

    const result = await scanRepo(workspacePath)

    expect(result.projectGuidanceFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.clinerules',
          kind: 'clinerules',
          contentPreview: expect.stringContaining('Prefer service-layer tests.'),
          truncated: false,
        }),
        expect.objectContaining({
          path: 'CLAUDE.md',
          kind: 'claude_md',
          contentPreview: expect.stringContaining('Use existing DAO patterns.'),
        }),
        expect.objectContaining({
          path: '.claude/rules/testing.md',
          kind: 'claude_markdown',
          contentPreview: expect.stringContaining('Test fixtures are advisory templates.'),
        }),
      ]),
    )

    const promptSummary = formatScanForPrompt(result)
    expect(promptSummary).toContain('## Project Guidance (Advisory)')
    expect(promptSummary).toContain('soft conventions and navigation hints')
    expect(promptSummary).toContain('not mandatory validation gates')
    expect(promptSummary).toContain('Ticket acceptance criteria')
    expect(promptSummary).toContain('Prefer service-layer tests.')
  })

  it('caps oversized guidance previews without failing the scan', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-repo-scan-'))
    tempDirs.push(workspacePath)

    const oversizedGuidance = `${'A'.repeat(3000)}\nDo not require this tail.\n`
    await fs.writeFile(path.join(workspacePath, '.clinerules'), oversizedGuidance)

    const result = await scanRepo(workspacePath)

    expect(result.projectGuidanceFiles).toHaveLength(1)
    expect(result.projectGuidanceFiles[0]).toMatchObject({
      path: '.clinerules',
      truncated: true,
    })
    expect(result.projectGuidanceFiles[0].contentPreview.length).toBeLessThan(
      oversizedGuidance.length,
    )
    expect(result.projectGuidanceFiles[0].contentPreview).not.toContain(
      'Do not require this tail.',
    )
  })
})
