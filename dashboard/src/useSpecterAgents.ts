import { useState, useEffect, useRef } from 'react'
import type { OfficeState } from './office/engine/officeState.js'
import { buildDynamicCatalog } from './office/layout/furnitureCatalog.js'
import { setFloorSprites } from './office/floorTiles.js'
import { setWallSprites } from './office/wallTiles.js'
import { setCharacterTemplates } from './office/sprites/spriteData.js'

// ── Types from /api/state ─────────────────────────────────────

export interface SpecterAgent {
  id: number
  name: string
  task_type: string
}

export interface SpecterTask {
  id: number
  jira_number: string
  status: 'assigned' | 'in_progress' | 'posting_to_jira' | 'completed' | 'posted_to_jira' | 'failed'
  agent_id: number
  agent_name: string
  customer_name: string
  branch: string
  source: string
  created_at: string
  updated_at: string
}

export interface AgentLabel {
  agentName: string
  jiraTicket?: string
  customer?: string
  branch?: string
  status?: string
  // Store the raw ISO string so NameTagOverlay can compute live elapsed
  createdAt?: string
  isFailed?: boolean
}

// ── ID conventions ────────────────────────────────────────────
// Base idle character per agent:         agentId  (1–9)
// Extra concurrent task character:       TASK_OFFSET + taskId
const TASK_OFFSET = 10_000

function taskCharId(taskId: number): number {
  return TASK_OFFSET + taskId
}

// ── Hook ──────────────────────────────────────────────────────

export interface SpecterAgentsState {
  characterIds: number[]
  agentLabels: Record<number, AgentLabel>
  layoutReady: boolean
}

export function useSpecterAgents(
  getOfficeState: () => OfficeState,
  defaultLayoutPromise: Promise<void>,
): SpecterAgentsState {
  const [characterIds, setCharacterIds] = useState<number[]>([])
  const [agentLabels, setAgentLabels] = useState<Record<number, AgentLabel>>({})
  const [layoutReady, setLayoutReady] = useState(false)

  // agentId → taskId currently running on the base character
  const baseTaskRef = useRef<Map<number, number>>(new Map())
  // taskId → true for tasks running as extra (non-base) characters
  const extraCharsRef = useRef<Set<number>>(new Set())
  // agentId → stable name
  const agentNamesRef = useRef<Map<number, string>>(new Map())

  // ── Load assets once ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function loadAssets() {
      try {
        const res = await fetch('/api/assets')
        if (!res.ok || cancelled) return
        const data = await res.json()

        if (data.catalog?.length) {
          buildDynamicCatalog({ catalog: data.catalog, sprites: data.sprites ?? {} })
        }
        if (data.floorSprites?.length) setFloorSprites(data.floorSprites)
        if (data.wallSprites?.length) setWallSprites(data.wallSprites)
        if (data.characterSprites?.length) setCharacterTemplates(data.characterSprites)
      } catch (e) {
        console.warn('[useSpecterAgents] Asset load failed, using fallback sprites:', e)
      }
    }

    loadAssets()
    return () => { cancelled = true }
  }, [])

  // ── Poll /api/state every 3s ─────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let initialized = false

    async function poll() {
      try {
        const res = await fetch('/api/state')
        if (!res.ok || cancelled) return
        const data: { agents: SpecterAgent[]; tasks: SpecterTask[] } = await res.json()
        const os = getOfficeState()

        // ── First poll: wait for layout, then seed idle characters ──
        if (!initialized) {
          // Wait for the default layout to be applied before placing characters
          await defaultLayoutPromise
          if (cancelled) return

          initialized = true

          for (const agent of data.agents) {
            agentNamesRef.current.set(agent.id, agent.name)
            if (!os.characters.has(agent.id)) {
              os.addAgent(agent.id)
              os.setAgentActive(agent.id, false)
            }
          }

          setCharacterIds(data.agents.map((a) => a.id))
          setLayoutReady(true)
        }

        // Sync agent names for any DB changes
        for (const agent of data.agents) {
          agentNamesRef.current.set(agent.id, agent.name)
        }

        // Active = running or about to run; exclude cancelled
        const activeTasks = data.tasks.filter(
          (t) => t.status === 'assigned' || t.status === 'in_progress' || t.status === 'posting_to_jira',
        )

        // Group by agent
        const tasksByAgent = new Map<number, SpecterTask[]>()
        for (const task of activeTasks) {
          const list = tasksByAgent.get(task.agent_id) ?? []
          list.push(task)
          tasksByAgent.set(task.agent_id, list)
        }

        // All active task IDs (used for cleanup)
        const activeTaskIdSet = new Set(activeTasks.map((t) => t.id))

        // ── Activate / deactivate base characters ──
        for (const agent of data.agents) {
          const tasks = tasksByAgent.get(agent.id) ?? []
          const firstTask = tasks[0]

          if (firstTask) {
            const currentBaseTask = baseTaskRef.current.get(agent.id)

            if (currentBaseTask !== firstTask.id) {
              // Base task changed (new task, or previous task completed)
              // If the new first task was an extra char, remove that extra char
              // so the base character takes it over (avoids duplicate)
              if (extraCharsRef.current.has(firstTask.id)) {
                extraCharsRef.current.delete(firstTask.id)
                const extraCharId = taskCharId(firstTask.id)
                os.removeAgent(extraCharId)
                setCharacterIds((prev) => prev.filter((id) => id !== extraCharId))
              }

              baseTaskRef.current.set(agent.id, firstTask.id)
              os.setAgentActive(agent.id, true)
            }

            // Spawn extra characters for tasks beyond the first
            for (let i = 1; i < tasks.length; i++) {
              const task = tasks[i]!
              if (!extraCharsRef.current.has(task.id)) {
                extraCharsRef.current.add(task.id)
                const charId = taskCharId(task.id)
                os.addAgent(charId)
                os.setAgentActive(charId, true)
                setCharacterIds((prev) => prev.includes(charId) ? prev : [...prev, charId])
              }
            }
          } else {
            // No active tasks — idle
            if (baseTaskRef.current.has(agent.id)) {
              baseTaskRef.current.delete(agent.id)
              os.setAgentActive(agent.id, false)
            }
          }
        }

        // ── Despawn extra characters for completed tasks ──
        for (const taskId of [...extraCharsRef.current]) {
          if (!activeTaskIdSet.has(taskId)) {
            extraCharsRef.current.delete(taskId)
            const charId = taskCharId(taskId)
            os.removeAgent(charId)
            setCharacterIds((prev) => prev.filter((id) => id !== charId))
          }
        }

        // ── Build labels for all characters ──
        const labels: Record<number, AgentLabel> = {}

        for (const agent of data.agents) {
          const taskId = baseTaskRef.current.get(agent.id)
          const task = taskId ? activeTasks.find((t) => t.id === taskId) : undefined

          // Also check if there's a recent failed task for this agent
          const failedTask = !task
            ? data.tasks.find((t) => t.agent_id === agent.id && t.status === 'failed')
            : undefined

          labels[agent.id] = {
            agentName: agent.name,
            jiraTicket: task?.jira_number ?? failedTask?.jira_number,
            customer: task?.customer_name ?? failedTask?.customer_name,
            branch: task?.branch ?? failedTask?.branch,
            status: task?.status ?? failedTask?.status,
            createdAt: task?.created_at ?? failedTask?.updated_at,
            isFailed: !!failedTask,
          }
        }

        // Labels for extra characters
        for (const taskId of extraCharsRef.current) {
          const task = activeTasks.find((t) => t.id === taskId)
          if (task) {
            labels[taskCharId(taskId)] = {
              agentName: agentNamesRef.current.get(task.agent_id) ?? task.agent_name,
              jiraTicket: task.jira_number,
              customer: task.customer_name,
              branch: task.branch,
              status: task.status,
              createdAt: task.created_at,
            }
          }
        }

        setAgentLabels(labels)
      } catch (e) {
        console.warn('[useSpecterAgents] Poll error:', e)
      }
    }

    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [getOfficeState, defaultLayoutPromise])

  return { characterIds, agentLabels, layoutReady }
}
