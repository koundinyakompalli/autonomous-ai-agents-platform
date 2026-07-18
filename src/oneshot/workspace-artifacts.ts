import * as fs from 'fs/promises'
import * as path from 'path'

export interface WorkspaceArtifactFile {
  fileName: string
  body: string | object
  format?: 'json' | 'md' | 'txt'
}

function serializeArtifactBody(body: string | object, format: 'json' | 'md' | 'txt'): string {
  if (typeof body === 'string') {
    return body
  }

  if (format === 'json') {
    return JSON.stringify(body, null, 2)
  }

  return JSON.stringify(body, null, 2)
}

export async function materializeRunArtifacts(
  statePath: string,
  artifacts: WorkspaceArtifactFile[],
  stage?: string,
): Promise<string[]> {
  const artifactDir = stage
    ? path.join(statePath, stage)
    : statePath
  await fs.mkdir(artifactDir, { recursive: true })

  const writtenPaths: string[] = []
  for (const artifact of artifacts) {
    const targetPath = path.join(artifactDir, artifact.fileName)
    const format = artifact.format ?? 'json'
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, serializeArtifactBody(artifact.body, format), 'utf8')
    writtenPaths.push(targetPath)
  }

  return writtenPaths
}
