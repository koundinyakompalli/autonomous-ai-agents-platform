import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildReviewContext } from './review-context.js'

const tempDirs: string[] = []

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-review-context-'))
  tempDirs.push(dir)
  return dir
}

describe('buildReviewContext', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('loads impacted file contents and records missing files', async () => {
    const workspace = await makeTempWorkspace()
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'app.ts'), 'export const ok = true;\n')

    const context = await buildReviewContext(workspace, {
      specs: [
        {
          id: 'SPEC-1',
          objective: 'Update app behavior',
          acceptanceCriteria: ['App behavior updates correctly'],
          targetFiles: ['src/app.ts', 'src/missing.ts'],
          implementationNotes: ['Use existing patterns'],
          validationSteps: ['npm run build'],
        },
      ],
    })

    expect(context.impactedFiles[0]).toMatchObject({
      path: 'src/app.ts',
      exists: true,
      included: true,
      truncated: false,
    })
    expect(context.impactedFiles[0].content).toContain('export const ok = true')
    expect(context.impactedFiles[1]).toMatchObject({
      path: 'src/missing.ts',
      exists: false,
      included: false,
    })
  })

  it('truncates when impacted files exceed the deterministic file cap', async () => {
    const workspace = await makeTempWorkspace()
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true })

    const impactedFiles: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const filePath = `src/file-${index}.ts`
      impactedFiles.push(filePath)
      await fs.writeFile(path.join(workspace, filePath), `export const value${index} = ${index};\n`)
    }

    const context = await buildReviewContext(workspace, {
      specs: [
        {
          id: 'SPEC-1',
          objective: 'Touch many files',
          acceptanceCriteria: ['All files are covered'],
          targetFiles: impactedFiles,
          implementationNotes: ['Follow existing structure'],
          validationSteps: ['npm run build'],
        },
      ],
    })

    expect(context.impactedFiles).toHaveLength(20)
    expect(context.truncated).toBe(true)
    expect(context.truncationNote).toContain('omitted')
  })
})
