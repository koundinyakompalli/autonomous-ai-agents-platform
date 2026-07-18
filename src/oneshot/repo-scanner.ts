import * as fs from 'fs/promises'
import type { Dirent } from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const SCAN_TIMEOUT_MS = 30_000
const MAX_FILES_PER_EXT = 8
const MAX_WALK_FILES = 5000
const MAX_PROJECT_GUIDANCE_FILES = 8
const MAX_PROJECT_GUIDANCE_FILE_CHARS = 2_000
const MAX_PROJECT_GUIDANCE_TOTAL_CHARS = 10_000

export type ProjectGuidanceKind =
  | 'clinerules'
  | 'claude_md'
  | 'claude_file'
  | 'claude_markdown'

export interface RepoScanResult {
  scannedAt: string
  workspacePath: string
  techStack: TechStack
  projectStructure: ProjectStructure
  keyFiles: KeyFile[]
  projectGuidanceFiles: ProjectGuidanceFile[]
}

export interface TechStack {
  primaryLanguage: string | null
  buildTool: string | null
  testFramework: string | null
  frameworks: string[]
}

export interface ProjectStructure {
  rootFiles: string[]
  topLevelDirs: string[]
  estimatedFileCount: number
  extensionBreakdown: Record<string, number>
}

export interface KeyFile {
  path: string
  role: string
  description: string
}

export interface ProjectGuidanceFile {
  path: string
  kind: ProjectGuidanceKind
  contentPreview: string
  truncated: boolean
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function fileIsFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function detectTechStack(workspacePath: string): Promise<TechStack> {
  let primaryLanguage: string | null = null
  let buildTool: string | null = null
  let testFramework: string | null = null
  const frameworks: string[] = []

  try {
    const hasPomXml = await fileExists(path.join(workspacePath, 'pom.xml'))
    const hasBuildGradle = await fileExists(path.join(workspacePath, 'build.gradle'))
    const hasBuildGradleKts = await fileExists(path.join(workspacePath, 'build.gradle.kts'))
    const hasPackageJson = await fileExists(path.join(workspacePath, 'package.json'))
    const hasTsconfig = await fileExists(path.join(workspacePath, 'tsconfig.json'))
    const hasYarnLock = await fileExists(path.join(workspacePath, 'yarn.lock'))
    const hasRequirementsTxt = await fileExists(path.join(workspacePath, 'requirements.txt'))
    const hasPyprojectToml = await fileExists(path.join(workspacePath, 'pyproject.toml'))
    const hasGoMod = await fileExists(path.join(workspacePath, 'go.mod'))

    if (hasPomXml) {
      primaryLanguage = 'java'
      buildTool = 'maven'
    } else if (hasBuildGradle || hasBuildGradleKts) {
      primaryLanguage = 'java'
      buildTool = 'gradle'
    } else if (hasPackageJson && hasTsconfig) {
      primaryLanguage = 'typescript'
      buildTool = hasYarnLock ? 'yarn' : 'npm'
    } else if (hasRequirementsTxt || hasPyprojectToml) {
      primaryLanguage = 'python'
      buildTool = 'pip'
    } else if (hasGoMod) {
      primaryLanguage = 'go'
      buildTool = null
    }

    // Test framework detection
    if (primaryLanguage === 'java') {
      const buildFileContent = hasPomXml
        ? await readFileSafe(path.join(workspacePath, 'pom.xml'))
        : hasBuildGradle
          ? await readFileSafe(path.join(workspacePath, 'build.gradle'))
          : await readFileSafe(path.join(workspacePath, 'build.gradle.kts'))
      if (buildFileContent && buildFileContent.toLowerCase().includes('junit')) {
        testFramework = 'junit'
      }
    } else if (primaryLanguage === 'typescript' && hasPackageJson) {
      const packageJsonContent = await readFileSafe(path.join(workspacePath, 'package.json'))
      if (packageJsonContent) {
        try {
          const pkg = JSON.parse(packageJsonContent) as Record<string, unknown>
          const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>
          const scripts = (pkg.scripts ?? {}) as Record<string, string>
          const allScripts = Object.values(scripts).join(' ')
          if (devDeps['vitest'] || allScripts.includes('vitest')) {
            testFramework = 'vitest'
          } else if (devDeps['jest'] || allScripts.includes('jest')) {
            testFramework = 'jest'
          }
        } catch {
          // malformed package.json — skip
        }
      }
    } else if (primaryLanguage === 'python') {
      const requirementsContent = hasRequirementsTxt
        ? await readFileSafe(path.join(workspacePath, 'requirements.txt'))
        : null
      const pyprojectContent = hasPyprojectToml
        ? await readFileSafe(path.join(workspacePath, 'pyproject.toml'))
        : null
      const combined = `${requirementsContent ?? ''} ${pyprojectContent ?? ''}`.toLowerCase()
      if (combined.includes('pytest')) {
        testFramework = 'pytest'
      }
    } else if (primaryLanguage === 'go') {
      testFramework = 'go test'
    }

    // Framework detection
    if (hasPomXml) {
      const pomContent = await readFileSafe(path.join(workspacePath, 'pom.xml'))
      if (pomContent && pomContent.toLowerCase().includes('spring-boot')) {
        frameworks.push('spring-boot')
      }
    }

    if (hasPackageJson) {
      const packageJsonContent = await readFileSafe(path.join(workspacePath, 'package.json'))
      if (packageJsonContent) {
        try {
          const pkg = JSON.parse(packageJsonContent) as Record<string, unknown>
          const deps = (pkg.dependencies ?? {}) as Record<string, unknown>
          const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>
          if (devDeps['react'] || deps['react']) {
            frameworks.push('react')
          }
          if (deps['express']) {
            frameworks.push('express')
          }
        } catch {
          // malformed package.json — skip
        }
      }
    }

    if (hasRequirementsTxt || hasPyprojectToml) {
      const requirementsContent = hasRequirementsTxt
        ? await readFileSafe(path.join(workspacePath, 'requirements.txt'))
        : null
      const pyprojectContent = hasPyprojectToml
        ? await readFileSafe(path.join(workspacePath, 'pyproject.toml'))
        : null
      const combined = `${requirementsContent ?? ''} ${pyprojectContent ?? ''}`.toLowerCase()
      if (combined.includes('fastapi')) {
        frameworks.push('fastapi')
      }
    }
  } catch {
    // return whatever was detected so far
  }

  return { primaryLanguage, buildTool, testFramework, frameworks }
}

async function walkDirectory(
  dirPath: string,
  fileCount: { count: number },
  extensionMap: Map<string, number>,
): Promise<void> {
  if (fileCount.count >= MAX_WALK_FILES) {
    return
  }

  let entries: Dirent[]
  try {
    entries = (await fs.readdir(dirPath, { withFileTypes: true })) as unknown as Dirent[]
  } catch {
    return
  }

  for (const entry of entries) {
    if (fileCount.count >= MAX_WALK_FILES) {
      return
    }
    const entryName = entry.name as unknown as string
    if (entryName.startsWith('.')) {
      continue
    }
    if (entry.isDirectory()) {
      await walkDirectory(path.join(dirPath, entryName), fileCount, extensionMap)
    } else if (entry.isFile()) {
      fileCount.count++
      const ext = path.extname(entryName).toLowerCase()
      if (ext) {
        extensionMap.set(ext, (extensionMap.get(ext) ?? 0) + 1)
      }
    }
  }
}

async function detectProjectStructure(workspacePath: string): Promise<ProjectStructure> {
  const rootFiles: string[] = []
  const topLevelDirs: string[] = []

  try {
    const rootEntries = (await fs.readdir(workspacePath, { withFileTypes: true })) as unknown as Dirent[]
    for (const entry of rootEntries) {
      const entryName = entry.name as unknown as string
      if (entryName.startsWith('.')) {
        continue
      }
      if (entry.isDirectory()) {
        topLevelDirs.push(entryName)
      } else if (entry.isFile()) {
        rootFiles.push(entryName)
      }
    }
  } catch {
    // return partial
  }

  const fileCount = { count: 0 }
  const extensionMap = new Map<string, number>()

  try {
    await walkDirectory(workspacePath, fileCount, extensionMap)
  } catch {
    // return partial
  }

  // Build top-10 extension breakdown
  const sortedExtensions = Array.from(extensionMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  const extensionBreakdown: Record<string, number> = {}
  for (const [ext, count] of sortedExtensions) {
    extensionBreakdown[ext] = count
  }

  return {
    rootFiles,
    topLevelDirs,
    estimatedFileCount: fileCount.count,
    extensionBreakdown,
  }
}

async function globRelative(
  workspacePath: string,
  pattern: string,
  limit: number,
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `find . -type f -path "${pattern}" 2>/dev/null | head -${limit}`,
      {
        cwd: workspacePath,
        timeout: 5000,
      },
    )
    return stdout
      .split('\n')
      .map((l) => l.trim().replace(/^\.\//, ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

async function detectKeyFiles(workspacePath: string): Promise<KeyFile[]> {
  const keyFiles: KeyFile[] = []

  const simpleChecks: Array<{ file: string; role: string; description: string }> = [
    { file: 'pom.xml', role: 'build_config', description: 'Maven build configuration' },
    { file: 'package.json', role: 'build_config', description: 'Node.js package manifest and scripts' },
    { file: 'tsconfig.json', role: 'build_config', description: 'TypeScript compiler configuration' },
    { file: 'build.gradle', role: 'build_config', description: 'Gradle build configuration' },
    { file: 'build.gradle.kts', role: 'build_config', description: 'Gradle Kotlin DSL build configuration' },
    { file: 'go.mod', role: 'build_config', description: 'Go module definition' },
    { file: 'pyproject.toml', role: 'build_config', description: 'Python project configuration' },
    { file: 'requirements.txt', role: 'build_config', description: 'Python dependencies' },
    { file: 'src/main.ts', role: 'entry_point', description: 'TypeScript main entry point' },
    { file: 'src/index.ts', role: 'entry_point', description: 'TypeScript index entry point' },
    { file: 'main.ts', role: 'entry_point', description: 'TypeScript main entry point' },
    { file: 'src/app.ts', role: 'entry_point', description: 'Application bootstrap' },
    { file: 'src/server.ts', role: 'entry_point', description: 'Server entry point' },
    { file: '.env.example', role: 'env_config', description: 'Environment variable template' },
  ]

  for (const check of simpleChecks) {
    try {
      if (await fileExists(path.join(workspacePath, check.file))) {
        keyFiles.push({ path: check.file, role: check.role, description: check.description })
      }
    } catch {
      // skip
    }
  }

  // Spring Boot application entry point
  try {
    const springEntries = await globRelative(
      workspacePath,
      '**/src/main/java/**/*Application.java',
      1,
    )
    for (const entry of springEntries.slice(0, 1)) {
      keyFiles.push({
        path: entry,
        role: 'entry_point',
        description: 'Spring Boot application entry point',
      })
    }
  } catch {
    // skip
  }

  // .env.example variants
  try {
    const envExamples = await globRelative(workspacePath, '*.env.example', 3)
    for (const entry of envExamples) {
      if (!keyFiles.some((kf) => kf.path === entry)) {
        keyFiles.push({ path: entry, role: 'env_config', description: 'Environment variable template' })
      }
    }
  } catch {
    // skip
  }

  // Routes / API directories
  const routeDirs = ['src/routes', 'src/api']
  for (const dir of routeDirs) {
    try {
      if (await fileExists(path.join(workspacePath, dir))) {
        const entries = (await fs.readdir(path.join(workspacePath, dir), { withFileTypes: true })) as unknown as Dirent[]
        const files = entries
          .filter((e) => e.isFile())
          .slice(0, MAX_FILES_PER_EXT)
          .map((e) => `${dir}/${e.name as unknown as string}`)
        for (const file of files.slice(0, 5)) {
          keyFiles.push({ path: file, role: 'routes', description: `Route/API handler in ${dir}` })
        }
      }
    } catch {
      // skip
    }
  }

  // Schema / migrations
  try {
    const schemaFiles = await globRelative(workspacePath, '**/schema.sql', 3)
    for (const entry of schemaFiles.slice(0, 3)) {
      keyFiles.push({ path: entry, role: 'schema', description: 'Database schema definition' })
    }
  } catch {
    // skip
  }

  try {
    const migrationFiles = await globRelative(workspacePath, '**/migrations/*.sql', 3)
    for (const entry of migrationFiles.slice(0, 3)) {
      keyFiles.push({ path: entry, role: 'schema', description: 'Database migration script' })
    }
  } catch {
    // skip
  }

  return keyFiles
}

async function listMarkdownFilesInDir(
  workspacePath: string,
  relativeDir: string,
  limit: number,
): Promise<string[]> {
  try {
    const dirPath = path.join(workspacePath, relativeDir)
    const entries = (await fs.readdir(dirPath, {
      withFileTypes: true,
    })) as unknown as Dirent[]
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name as unknown as string)
      .filter((name) => /\.md$/i.test(name))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit)
      .map((name) => `${relativeDir}/${name}`)
  } catch {
    return []
  }
}

function previewGuidanceContent(
  rawContent: string,
  remainingTotalChars: number,
): { contentPreview: string; truncated: boolean } {
  const normalized = rawContent.replace(/\r\n/g, '\n').replace(/\0/g, '').trim()
  const maxChars = Math.max(
    0,
    Math.min(MAX_PROJECT_GUIDANCE_FILE_CHARS, remainingTotalChars),
  )
  if (normalized.length <= maxChars) {
    return { contentPreview: normalized, truncated: false }
  }
  return {
    contentPreview: normalized.slice(0, maxChars).trimEnd(),
    truncated: true,
  }
}

async function detectProjectGuidanceFiles(
  workspacePath: string,
): Promise<ProjectGuidanceFile[]> {
  const candidates: Array<{ path: string; kind: ProjectGuidanceKind }> = []
  const addCandidate = (candidate: {
    path: string
    kind: ProjectGuidanceKind
  }): void => {
    if (!candidates.some((existing) => existing.path === candidate.path)) {
      candidates.push(candidate)
    }
  }

  addCandidate({ path: '.clinerules', kind: 'clinerules' })
  addCandidate({ path: 'CLAUDE.md', kind: 'claude_md' })
  if (await fileIsFile(path.join(workspacePath, '.claude'))) {
    addCandidate({ path: '.claude', kind: 'claude_file' })
  }

  const markdownFiles = [
    ...(await listMarkdownFilesInDir(workspacePath, '.claude', 4)),
    ...(await listMarkdownFilesInDir(workspacePath, '.claude/rules', 4)),
  ]
  for (const guidancePath of markdownFiles) {
    addCandidate({ path: guidancePath, kind: 'claude_markdown' })
  }

  const guidanceFiles: ProjectGuidanceFile[] = []
  let remainingTotalChars = MAX_PROJECT_GUIDANCE_TOTAL_CHARS
  for (const candidate of candidates) {
    if (guidanceFiles.length >= MAX_PROJECT_GUIDANCE_FILES) {
      break
    }
    if (remainingTotalChars <= 0) {
      break
    }
    if (!(await fileIsFile(path.join(workspacePath, candidate.path)))) {
      continue
    }
    const rawContent = await readFileSafe(path.join(workspacePath, candidate.path))
    if (rawContent == null) {
      continue
    }
    const preview = previewGuidanceContent(rawContent, remainingTotalChars)
    remainingTotalChars -= preview.contentPreview.length
    guidanceFiles.push({
      path: candidate.path,
      kind: candidate.kind,
      contentPreview: preview.contentPreview,
      truncated: preview.truncated || rawContent.trim().length > preview.contentPreview.length,
    })
  }

  return guidanceFiles
}

export async function scanRepo(workspacePath: string): Promise<RepoScanResult> {
  try {
    const [
      techStack,
      projectStructure,
      keyFiles,
      projectGuidanceFiles,
    ] = await Promise.all([
      detectTechStack(workspacePath).catch(() => ({
        primaryLanguage: null,
        buildTool: null,
        testFramework: null,
        frameworks: [] as string[],
      })),
      detectProjectStructure(workspacePath).catch(() => ({
        rootFiles: [] as string[],
        topLevelDirs: [] as string[],
        estimatedFileCount: 0,
        extensionBreakdown: {} as Record<string, number>,
      })),
      detectKeyFiles(workspacePath).catch(() => [] as KeyFile[]),
      detectProjectGuidanceFiles(workspacePath).catch(
        () => [] as ProjectGuidanceFile[],
      ),
    ])

    return {
      scannedAt: new Date().toISOString(),
      workspacePath,
      techStack,
      projectStructure,
      keyFiles,
      projectGuidanceFiles,
    }
  } catch {
    return {
      scannedAt: new Date().toISOString(),
      workspacePath,
      techStack: {
        primaryLanguage: null,
        buildTool: null,
        testFramework: null,
        frameworks: [],
      },
      projectStructure: {
        rootFiles: [],
        topLevelDirs: [],
        estimatedFileCount: 0,
        extensionBreakdown: {},
      },
      keyFiles: [],
      projectGuidanceFiles: [],
    }
  }
}

export function formatScanForPrompt(scan: RepoScanResult): string {
  const { techStack, projectStructure, keyFiles } = scan
  const projectGuidanceFiles = scan.projectGuidanceFiles ?? []

  const langPart = techStack.primaryLanguage ?? 'unknown'
  const buildPart = techStack.buildTool ? `Build: ${techStack.buildTool}` : 'Build: unknown'
  const testPart = techStack.testFramework ? `Tests: ${techStack.testFramework}` : 'Tests: unknown'
  const frameworkPart =
    techStack.frameworks.length > 0
      ? `Frameworks: ${techStack.frameworks.join(', ')}`
      : 'Frameworks: none detected'

  const rootFilesPart =
    projectStructure.rootFiles.length > 0
      ? projectStructure.rootFiles.join(', ')
      : 'none'

  const topDirsPart =
    projectStructure.topLevelDirs.length > 0
      ? projectStructure.topLevelDirs.join(', ')
      : 'none'

  const extBreakdownPart = Object.entries(projectStructure.extensionBreakdown)
    .map(([ext, count]) => `${ext}: ${count}`)
    .join(', ') || 'none'

  const keyFileLines =
    keyFiles.length > 0
      ? keyFiles.map((f) => `- \`${f.path}\` — ${f.role}: ${f.description}`).join('\n')
      : '- none detected'

  const guidanceLines =
    projectGuidanceFiles.length > 0
      ? projectGuidanceFiles
          .map((file) => {
            const suffix = file.truncated ? ' (preview truncated)' : ''
            const preview = file.contentPreview || '(empty file)'
            const quotedPreview = preview
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')
            return [
              `### \`${file.path}\` — ${file.kind}${suffix}`,
              '',
              quotedPreview,
            ].join('\n')
          })
          .join('\n\n')
      : ''

  const guidanceSection =
    guidanceLines.length > 0
      ? [
          '',
          '## Project Guidance (Advisory)',
          '',
          'The following repo-local guidance files are soft conventions and navigation hints, not mandatory validation gates. Ticket acceptance criteria, deterministic grounding, security/compliance guardrails, and directly inspected code evidence take precedence when they conflict.',
          '',
          guidanceLines,
        ]
      : []

  return [
    '## Codebase Intelligence (pre-scanned)',
    '',
    `**Tech Stack**: ${langPart} | ${buildPart} | ${testPart} | ${frameworkPart}`,
    '',
    '**Project Structure**:',
    `- Root files: ${rootFilesPart}`,
    `- Top-level dirs: ${topDirsPart}`,
    `- Estimated files: ~${projectStructure.estimatedFileCount} | Top extensions: ${extBreakdownPart}`,
    '',
    '**Key Files**:',
    keyFileLines,
    ...guidanceSection,
    '',
    'Use this context to skip basic project discovery and focus on ticket-specific exploration.',
  ].join('\n')
}
