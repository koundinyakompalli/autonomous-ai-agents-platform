import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReadOnlyRepoTools } from './repo-tools.js'

const tempRoots: string[] = []

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-openai-tools-'))
  tempRoots.push(root)
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src', 'example.ts'),
    ['export function greet(name: string) {', '  return `hi ${name}`', '}'].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(root, 'src', 'nested', 'notes.md'),
    ['# Notes', 'review the greeting implementation'].join('\n'),
    'utf8',
  )
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

describe('createReadOnlyRepoTools', () => {
  it('lists directories relative to the workspace', async () => {
    const workspace = await makeWorkspace()
    const tools = createReadOnlyRepoTools(workspace)

    const result = await tools.execute({
      callId: 'call-1',
      name: 'list_directory',
      arguments: JSON.stringify({ path: 'src', maxDepth: 2 }),
    }) as { entries: Array<{ path: string; type: string }> }

    expect(result.entries).toEqual(
      expect.arrayContaining([
        { path: 'src/example.ts', type: 'file' },
        { path: 'src/nested', type: 'directory' },
        { path: 'src/nested/notes.md', type: 'file' },
      ]),
    )
  })

  it('reads files with line numbers', async () => {
    const workspace = await makeWorkspace()
    const tools = createReadOnlyRepoTools(workspace)

    const result = await tools.execute({
      callId: 'call-2',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/example.ts', startLine: 1, endLine: 2 }),
    }) as { content: string }

    expect(result.content).toContain('1: export function greet(name: string) {')
    expect(result.content).toContain('2:   return `hi ${name}`')
  })

  it('searches file contents', async () => {
    const workspace = await makeWorkspace()
    const tools = createReadOnlyRepoTools(workspace)

    const result = await tools.execute({
      callId: 'call-3',
      name: 'grep_search',
      arguments: JSON.stringify({ query: 'greeting', path: 'src', filePattern: '**/*' }),
    }) as { matches: Array<{ path: string; line: number }> }

    expect(result.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/nested/notes.md', line: 2 }),
      ]),
    )
  })

  it('rejects path traversal outside the workspace', async () => {
    const workspace = await makeWorkspace()
    const tools = createReadOnlyRepoTools(workspace)

    await expect(
      tools.execute({
        callId: 'call-4',
        name: 'read_file',
        arguments: JSON.stringify({ path: '../secrets.txt' }),
      }),
    ).rejects.toThrow('outside the workspace')
  })
})
