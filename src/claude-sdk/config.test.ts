// src/claude-sdk/config.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveToolSet,
  TOOL_SETS,
  deregisterRepo,
  getRepoPath,
  REPO_REGISTRY,
} from './config.js'
import { registerRepoFromPath } from './index.js'

describe('resolveToolSet precedence', () => {
  it('honors explicit allowedTools override above everything', () => {
    const tools = resolveToolSet({
      allowedTools: ['Read'],
      permissionLevel: 'analysis',
      agentType: 'darci',
    })
    expect(tools).toEqual(['Read'])
  })

  it('honors permissionLevel when no allowedTools, independent of agentType', () => {
    const tools = resolveToolSet({
      permissionLevel: 'code_exploration',
      agentType: 'darci',
    })
    expect(tools).toEqual(TOOL_SETS.code_exploration)
  })

  it('falls back to agentType default when no override or level', () => {
    const tools = resolveToolSet({ agentType: 'darci' })
    expect(tools).toEqual(TOOL_SETS.analysis)
  })

  it('returns code_exploration when nothing is provided', () => {
    const tools = resolveToolSet({})
    expect(tools).toEqual(TOOL_SETS.code_exploration)
  })

  it('treats empty allowedTools as not-provided (falls through)', () => {
    const tools = resolveToolSet({
      allowedTools: [],
      permissionLevel: 'read_only',
    })
    expect(tools).toEqual(TOOL_SETS.read_only)
  })
})

describe('repo registration', () => {
  beforeEach(() => {
    // Clear registry between tests
    for (const k of Object.keys(REPO_REGISTRY)) delete REPO_REGISTRY[k]
  })

  it('two distinct paths with the same basename produce different IDs', () => {
    const a = registerRepoFromPath('/mnt/efs/oneshot/1/workspace')
    const b = registerRepoFromPath('/mnt/efs/oneshot/2/workspace')
    expect(a).not.toBe(b)
    expect(a.startsWith('workspace_')).toBe(true)
    expect(b.startsWith('workspace_')).toBe(true)
    expect(getRepoPath(a)).toBe('/mnt/efs/oneshot/1/workspace')
    expect(getRepoPath(b)).toBe('/mnt/efs/oneshot/2/workspace')
  })

  it('explicit ID is used verbatim', () => {
    const id = registerRepoFromPath('/tmp/x', 'oneshot-run-CPDEV-1-planner')
    expect(id).toBe('oneshot-run-CPDEV-1-planner')
    expect(getRepoPath(id)).toBe('/tmp/x')
  })

  it('deregisterRepo removes the entry', () => {
    const id = registerRepoFromPath('/tmp/y', 'foo')
    deregisterRepo(id)
    expect(() => getRepoPath(id)).toThrow(/Unknown repoId/)
  })

  it('deregisterRepo on unknown id is a no-op', () => {
    expect(() => deregisterRepo('never-registered')).not.toThrow()
  })

  it('hash suffix is stable for the same path', () => {
    const a = registerRepoFromPath('/mnt/efs/same/path')
    deregisterRepo(a)
    const b = registerRepoFromPath('/mnt/efs/same/path')
    expect(a).toBe(b)
  })
})
