import { Router } from 'express'
import { query } from '../db.js'

const router = Router()

interface AgentRow {
  id: number
  name: string
  task_type: string
}

interface TaskRow {
  id: number
  jira_number: string
  status: string
  agent_id: number
  agent_name: string
  customer_name: string
  branch: string
  source: string
  created_at: string
  updated_at: string
}

// GET /api/state
// Returns all configured agents + currently active/recent tasks
router.get('/', async (_req, res) => {
  try {
    const [agents, tasks] = await Promise.all([
      query<AgentRow>(`
        SELECT id, name, task_type
        FROM agents
        ORDER BY id
      `),
      query<TaskRow>(`
        SELECT
          tm.id,
          tm.jira_number,
          tm.status,
          tm.agent_id,
          a.name                                          AS agent_name,
          cb.customer                                     AS customer_name,
          cb.branch,
          tm.source,
          -- Return timestamps in UTC so client elapsed calculation is timezone-safe
          DATE_FORMAT(CONVERT_TZ(tm.created_at, @@session.time_zone, '+00:00'),
                      '%Y-%m-%dT%H:%i:%sZ')              AS created_at,
          DATE_FORMAT(CONVERT_TZ(tm.updated_at, @@session.time_zone, '+00:00'),
                      '%Y-%m-%dT%H:%i:%sZ')              AS updated_at
        FROM task_management tm
        JOIN agents            a  ON a.id  = tm.agent_id
        JOIN customer_branches cb ON cb.id = tm.customer_id
        WHERE
          tm.cancelled_at IS NULL
          AND (
            tm.status IN ('assigned', 'in_progress', 'posting_to_jira')
            OR (
              tm.status IN ('completed', 'posted_to_jira', 'failed')
              AND tm.updated_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
            )
          )
        ORDER BY tm.updated_at DESC
        LIMIT 50
      `),
    ])

    res.json({ agents, tasks })
  } catch (err) {
    console.error('[state] DB error:', err)
    res.status(500).json({ error: 'DB query failed' })
  }
})

export default router
