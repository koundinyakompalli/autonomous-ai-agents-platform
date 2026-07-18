import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeRunArtifacts } from './workspace-artifacts.js'

const tempRoots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-oneshot-state-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

describe('materializeRunArtifacts', () => {
  it('writes stage artifacts into the run state directory', async () => {
    const root = await createTempRoot()
    const statePath = path.join(root, 'state')

    const written = await materializeRunArtifacts(statePath, [
      {
        fileName: 'plan.json',
        body: { summary: 'Plan artifact' },
      },
      {
        fileName: 'notes.md',
        body: '# Notes',
        format: 'md',
      },
    ], 'planner')

    expect(written).toEqual([
      path.join(statePath, 'planner', 'plan.json'),
      path.join(statePath, 'planner', 'notes.md'),
    ])

    await expect(
      fs.readFile(path.join(statePath, 'planner', 'plan.json'), 'utf8'),
    ).resolves.toContain('"summary": "Plan artifact"')
    await expect(
      fs.readFile(path.join(statePath, 'planner', 'notes.md'), 'utf8'),
    ).resolves.toBe('# Notes')
  })

  it('creates nested directories for sidecar artifact paths', async () => {
    const root = await createTempRoot()
    const statePath = path.join(root, 'state')

    const written = await materializeRunArtifacts(statePath, [
      {
        fileName: 'ticket-evidence/comments.md',
        body: '# Comments',
        format: 'md',
      },
    ], 'planner')

    expect(written).toEqual([
      path.join(statePath, 'planner', 'ticket-evidence', 'comments.md'),
    ])
    await expect(
      fs.readFile(
        path.join(statePath, 'planner', 'ticket-evidence', 'comments.md'),
        'utf8',
      ),
    ).resolves.toBe('# Comments')
  })
})
