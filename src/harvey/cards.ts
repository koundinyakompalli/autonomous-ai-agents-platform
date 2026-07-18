/**
 * Harvey Adaptive Card Builders
 *
 * All card definitions for Harvey's Teams bot interface.
 * Each exported function returns a plain object ready for CardFactory.adaptiveCard().
 *
 * Design system:
 *   - Colored banner header (bleed: true) anchors each card's identity
 *   - style: 'accent'     → neutral/info (task queued, sessions, help)
 *   - style: 'good'       → success (result delivered)
 *   - style: 'warning'    → in-progress
 *   - style: 'attention'  → error/failure
 *   - style: 'emphasis'   → secondary info panels (slightly gray)
 *   - Monospace font for commands and IDs
 *   - color: 'Light' for text inside colored containers
 */

import type { AdminQueryResult } from './AdminQuery.js';

// ─── Agent identity ──────────────────────────────────────────────────────────

const AGENT_ICON: Record<string, string> = {
  DARCI:   '🔍',
  SCRIBE:  '📝',
  PRISM:   '💎',
  HERMES:  '⚙️',
  SENTRY:  '🛡️',
  BEACON:  '🔦',
  VERITAS: '📊',
  BCAT:    '🗂️',
};

const STATUS_ICON: Record<string, string> = {
  active:       '🟢',
  routing:      '🟡',
  task_created: '⏳',
  delivering:   '📬',
  delivered:    '✅',
  completed:    '✅',
  abandoned:    '⚪',
};

const agentIcon = (name: string) => AGENT_ICON[name?.toUpperCase()] ?? '🤖';

// ─── Schema constant ─────────────────────────────────────────────────────────

const SCHEMA = {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  version: '1.4',
};

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * Full-bleed colored banner: large icon left, title + subtitle right.
 * Use color: 'Light' on text inside to ensure contrast on colored backgrounds.
 */
function banner(icon: string, title: string, subtitle: string, style = 'accent'): any {
  return {
    type: 'Container',
    style,
    bleed: true,
    items: [
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'auto',
            verticalContentAlignment: 'Center',
            items: [{ type: 'TextBlock', text: icon, size: 'ExtraLarge' }],
          },
          {
            type: 'Column',
            width: 'stretch',
            verticalContentAlignment: 'Center',
            items: [
              {
                type: 'TextBlock',
                text: title,
                weight: 'Bolder',
                size: 'Large',
                color: 'Light',
                wrap: true,
              },
              ...(subtitle
                ? [{
                    type: 'TextBlock',
                    text: subtitle,
                    size: 'Small',
                    color: 'Light',
                    spacing: 'None',
                    wrap: true,
                  }]
                : []),
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Emphasis-colored row with N equal-width metric columns.
 * Each pair is [label, value].
 */
function metricsRow(pairs: Array<[string, string]>): any {
  return {
    type: 'Container',
    style: 'emphasis',
    spacing: 'None',
    items: [
      {
        type: 'ColumnSet',
        columns: pairs.map(([label, value]) => ({
          type: 'Column',
          width: 'stretch',
          items: [
            { type: 'TextBlock', text: label, size: 'Small', isSubtle: true, spacing: 'Small' },
            { type: 'TextBlock', text: value || '—', weight: 'Bolder', size: 'Default', spacing: 'None' },
          ],
        })),
      },
    ],
  };
}

/**
 * Monospace command label + description — used in the help card.
 */
function commandRow(cmd: string, desc: string): any {
  return {
    type: 'ColumnSet',
    spacing: 'Small',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        items: [{
          type: 'TextBlock',
          text: cmd,
          fontType: 'Monospace',
          size: 'Small',
          color: 'Accent',
          weight: 'Bolder',
        }],
      },
      {
        type: 'Column',
        width: 'stretch',
        items: [{
          type: 'TextBlock',
          text: desc,
          size: 'Small',
          isSubtle: true,
          wrap: true,
        }],
      },
    ],
  };
}

/**
 * Section divider with a bold title — used in the help card.
 */
function sectionHeader(title: string): any {
  return {
    type: 'TextBlock',
    text: title,
    weight: 'Bolder',
    size: 'Small',
    spacing: 'Medium',
    separator: true,
  };
}

// ─── Card builders ────────────────────────────────────────────────────────────

/**
 * Task submitted confirmation — sent immediately after task creation.
 */
export function buildTaskCreatedCard(agentName: string, taskManagementId: number): any {
  const icon = agentIcon(agentName);
  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      banner(icon, `${agentName} — Task Queued`, 'Your request is being processed', 'accent'),
      metricsRow([
        ['Agent', agentName],
        ['Task ID', `#${taskManagementId}`],
      ]),
      {
        type: 'TextBlock',
        text: "I'll ping you here the moment results are ready. Feel free to ask follow-up questions while you wait.",
        wrap: true,
        size: 'Small',
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
  };
}

/**
 * Result delivered — shown proactively when an agent finishes.
 * Includes duration/cost metrics and 👍 / 👎 feedback buttons.
 */
export function buildResultCard(
  agentName: string,
  customerName: string,
  duration: string,
  cost: string,
  sessionUuid: string,
): any {
  const icon = agentIcon(agentName);
  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      banner(icon, `${agentName} — Complete`, customerName, 'good'),
      metricsRow([
        ['⏱ Duration', duration],
        ['💰 Cost', cost],
      ]),
      {
        type: 'ActionSet',
        spacing: 'Medium',
        actions: [
          {
            type: 'Action.Submit',
            title: '👍  Helpful',
            style: 'positive',
            data: {
              msteams: {
                type: 'messageBack',
                text: `__feedback:positive:${sessionUuid}`,
                displayText: 'Marked helpful',
              },
            },
          },
          {
            type: 'Action.Submit',
            title: '👎  Not helpful',
            data: {
              msteams: {
                type: 'messageBack',
                text: `__feedback:negative:${sessionUuid}`,
                displayText: 'Marked not helpful',
              },
            },
          },
        ],
      },
    ],
  };
}

/**
 * Current task status — shown by /status command.
 */
export function buildStatusCard(
  task: {
    agent_name: string;
    customer_name: string;
    task_description: string;
    task_status?: string;
    status: string;
    updated_at?: string;
    created_at: string;
  },
  since: string,
): any {
  const tmStatus = task.task_status ?? task.status;
  const icon = agentIcon(task.agent_name);
  const desc = (task.task_description ?? 'No description').replace(/\n/g, ' ').substring(0, 120);

  const [statusLabel, headerStyle] =
    tmStatus === 'in_progress' ? ['In Progress', 'warning']
    : tmStatus === 'assigned'  ? ['Queued',      'accent']
    :                            ['Processing',  'accent'];

  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      banner(icon, `${task.agent_name} — ${statusLabel}`, task.customer_name, headerStyle),
      {
        type: 'Container',
        style: 'emphasis',
        spacing: 'None',
        items: [
          { type: 'TextBlock', text: desc, wrap: true, size: 'Small', spacing: 'Small' },
          { type: 'TextBlock', text: `Running for ${since}`, size: 'Small', isSubtle: true, spacing: 'Small' },
        ],
      },
      {
        type: 'TextBlock',
        text: "I'll notify you when done. Use `/cancel` to stop the task.",
        wrap: true,
        size: 'Small',
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
  };
}

/**
 * Sessions list — shown by /sessions command.
 * Each session gets a Continue button (or an "Active" badge if current).
 */
export function buildSessionsCard(
  sessions: any[],
  timeAgo: (d: Date) => string,
): any {
  const rows = sessions.map((s: any, i: number) => {
    const icon = STATUS_ICON[s.status] ?? '⚪';
    const agent = s.agent_name ?? 'No task yet';
    const customer = s.customer_name ? ` · ${s.customer_name}` : '';
    const desc = (s.task_description ?? s.summary ?? 'New conversation')
      .replace(/\n/g, ' ')
      .substring(0, 75);
    const time = timeAgo(new Date(s.updated_at));
    const isCurrent = s.status === 'active' || s.status === 'routing' || s.status === 'task_created';

    return {
      type: 'Container',
      style: isCurrent ? 'accent' : 'default',
      separator: i > 0,
      spacing: 'Small',
      items: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'ColumnSet',
                  spacing: 'None',
                  columns: [
                    {
                      type: 'Column',
                      width: 'auto',
                      items: [{ type: 'TextBlock', text: icon, size: 'Small' }],
                    },
                    {
                      type: 'Column',
                      width: 'stretch',
                      items: [{
                        type: 'TextBlock',
                        text: `**${agent}**${customer}`,
                        weight: 'Bolder',
                        size: 'Small',
                        spacing: 'None',
                        wrap: false,
                        ...(isCurrent ? { color: 'Light' } : {}),
                      }],
                    },
                  ],
                },
                {
                  type: 'TextBlock',
                  text: desc,
                  size: 'Small',
                  isSubtle: true,
                  wrap: true,
                  spacing: 'None',
                  maxLines: 1,
                  ...(isCurrent ? { color: 'Light' } : {}),
                },
                {
                  type: 'TextBlock',
                  text: time + (isCurrent ? ' · **Active**' : ''),
                  size: 'Small',
                  isSubtle: true,
                  spacing: 'None',
                  ...(isCurrent ? { color: 'Light' } : {}),
                },
              ],
            },
            {
              type: 'Column',
              width: 'auto',
              verticalContentAlignment: 'Center',
              items: isCurrent
                ? [{ type: 'TextBlock', text: '← here', size: 'Small', color: 'Light', weight: 'Bolder' }]
                : [{
                    type: 'ActionSet',
                    actions: [{
                      type: 'Action.Submit',
                      title: 'Continue',
                      style: 'positive',
                      data: {
                        msteams: {
                          type: 'messageBack',
                          text: `__resume:${s.session_id}`,
                          displayText: 'Continue session',
                        },
                      },
                    }],
                  }],
            },
          ],
        },
      ],
    };
  });

  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      {
        type: 'Container',
        style: 'emphasis',
        bleed: true,
        items: [
          { type: 'TextBlock', text: '💬 Your Conversations', weight: 'Bolder', size: 'Medium' },
          {
            type: 'TextBlock',
            text: `${sessions.length} session${sessions.length === 1 ? '' : 's'} found`,
            size: 'Small',
            isSubtle: true,
            spacing: 'None',
          },
        ],
      },
      ...rows,
    ],
  };
}

/**
 * Welcome card — sent when the bot is first installed for a user.
 */
export function buildWelcomeCard(): any {
  const agentRow = (icon: string, name: string, desc: string) => ({
    type: 'ColumnSet',
    spacing: 'Small',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        items: [{ type: 'TextBlock', text: icon, size: 'Default' }],
      },
      {
        type: 'Column',
        width: 'auto',
        items: [{
          type: 'TextBlock',
          text: name,
          weight: 'Bolder',
          size: 'Small',
          color: 'Accent',
          fontType: 'Monospace',
        }],
      },
      {
        type: 'Column',
        width: 'stretch',
        items: [{
          type: 'TextBlock',
          text: desc,
          size: 'Small',
          isSubtle: true,
          wrap: true,
        }],
      },
    ],
  });

  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      // Hero banner
      {
        type: 'Container',
        style: 'accent',
        bleed: true,
        items: [
          { type: 'TextBlock', text: '🤖  Harvey', weight: 'Bolder', size: 'ExtraLarge', color: 'Light' },
          {
            type: 'TextBlock',
            text: 'Product Factory · AI-powered engineering platform',
            size: 'Small',
            color: 'Light',
            spacing: 'None',
          },
        ],
      },
      // Intro line
      {
        type: 'TextBlock',
        text: 'Just describe what you need — I\'ll route it to the right agent and deliver results here.',
        wrap: true,
        size: 'Small',
        spacing: 'Medium',
      },
      // Agent roster
      {
        type: 'TextBlock',
        text: 'AVAILABLE AGENTS',
        weight: 'Bolder',
        size: 'Small',
        spacing: 'Medium',
        separator: true,
        isSubtle: true,
      },
      agentRow('🔍', 'DARCI',   'Defect root cause analysis'),
      agentRow('📝', 'SCRIBE',  'Code explanation & walkthroughs'),
      agentRow('💎', 'PRISM',   'Implementation planning'),
      agentRow('⚙️', 'HERMES',  'Config & system variable lookup'),
      agentRow('🛡️', 'SENTRY',  'MySQL execution review'),
      agentRow('📊', 'VERITAS', 'RCA report generation'),
      // Sessions vs tasks explainer
      {
        type: 'Container',
        style: 'emphasis',
        spacing: 'Medium',
        items: [
          {
            type: 'TextBlock',
            text: 'SESSIONS & TASKS',
            weight: 'Bolder',
            size: 'Small',
            isSubtle: true,
          },
          {
            type: 'TextBlock',
            text: 'A **session** is this conversation. After results are delivered you can ask follow-up questions or trigger another agent — all without losing context.',
            wrap: true,
            size: 'Small',
            spacing: 'Small',
          },
          {
            type: 'TextBlock',
            text: 'Use **/new** only when you want a completely fresh start.',
            wrap: true,
            size: 'Small',
            spacing: 'None',
          },
        ],
      },
      // Commands hint
      {
        type: 'TextBlock',
        text: 'Type **/help** to see all available commands.',
        size: 'Small',
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
  };
}

/**
 * Help card — shown by /help command.
 */
export function buildHelpCard(): any {
  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      {
        type: 'Container',
        style: 'accent',
        bleed: true,
        items: [
          { type: 'TextBlock', text: '🤖  Harvey', weight: 'Bolder', size: 'ExtraLarge', color: 'Light' },
          {
            type: 'TextBlock',
            text: 'AI-powered engineering platform · Product Factory',
            size: 'Small',
            color: 'Light',
            spacing: 'None',
          },
        ],
      },
      sectionHeader('📋 Tasks'),
      {
        type: 'TextBlock',
        text: 'Just describe what you need — Harvey routes to the right agent automatically.',
        size: 'Small',
        isSubtle: true,
        wrap: true,
        spacing: 'Small',
      },
      commandRow('/status',  'Check current task progress'),
      commandRow('/cancel',  'Cancel the running task'),
      commandRow('/history', 'Browse recent completed results'),
      sectionHeader('💬 Sessions'),
      commandRow('/sessions', 'View and resume previous conversations'),
      commandRow('/new',      'Start a fresh conversation'),
      sectionHeader('🔗 Sharing'),
      commandRow('/share', 'Get a 24h download link for the latest result'),
      {
        type: 'TextBlock',
        text: 'After a result is delivered, ask follow-up questions directly in chat.',
        size: 'Small',
        isSubtle: true,
        wrap: true,
        spacing: 'Medium',
      },
    ],
  };
}

/**
 * History card — shown by /history command.
 */
export function buildHistoryCard(
  history: any[],
  timeAgo: (d: Date) => string,
): any {
  const rows = history.map((h: any, i: number) => {
    const agent = h.agent_name ?? 'Agent';
    const icon = agentIcon(agent);
    const customer = h.customer_name ? ` · ${h.customer_name}` : '';
    const desc = (h.task_description ?? 'No description').replace(/\n/g, ' ').substring(0, 80);
    const time = timeAgo(new Date(h.completed_at ?? h.updated_at));

    return {
      type: 'Container',
      separator: i > 0,
      spacing: 'Small',
      items: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'auto',
              verticalContentAlignment: 'Center',
              items: [{ type: 'TextBlock', text: icon, size: 'Medium', spacing: 'Small' }],
            },
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'TextBlock',
                  text: `**${agent}**${customer}`,
                  weight: 'Bolder',
                  size: 'Small',
                  wrap: false,
                  spacing: 'Small',
                },
                {
                  type: 'TextBlock',
                  text: desc,
                  size: 'Small',
                  isSubtle: true,
                  wrap: true,
                  spacing: 'None',
                  maxLines: 2,
                },
                {
                  type: 'TextBlock',
                  text: time,
                  size: 'Small',
                  isSubtle: true,
                  spacing: 'None',
                },
              ],
            },
            {
              type: 'Column',
              width: 'auto',
              verticalContentAlignment: 'Center',
              items: [{
                type: 'ActionSet',
                actions: [{
                  type: 'Action.Submit',
                  title: '⬇ Get',
                  data: {
                    msteams: {
                      type: 'messageBack',
                      text: `__download:${h.tm_id}`,
                      displayText: 'Download result',
                    },
                  },
                }],
              }],
            },
          ],
        },
      ],
    };
  });

  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      {
        type: 'Container',
        style: 'emphasis',
        bleed: true,
        items: [
          { type: 'TextBlock', text: '🗂  Recent Results', weight: 'Bolder', size: 'Medium' },
          {
            type: 'TextBlock',
            text: `Last ${history.length} completed task${history.length === 1 ? '' : 's'}`,
            size: 'Small',
            isSubtle: true,
            spacing: 'None',
          },
        ],
      },
      ...rows,
    ],
  };
}

/**
 * Admin query result card — shown by /admin <question>.
 * Error, empty, and data states each get distinct visual treatment.
 */
export function buildAdminResultCard(question: string, result: AdminQueryResult): any {
  const MAX_VAL = 45;
  const truncate = (v: unknown) => {
    const s = v == null ? '—' : String(v);
    return s.length > MAX_VAL ? s.substring(0, MAX_VAL - 1) + '…' : s;
  };

  const headerContainer: any = {
    type: 'Container',
    style: 'emphasis',
    bleed: true,
    items: [
      {
        type: 'TextBlock',
        text: '🔍  Admin Query',
        size: 'Small',
        color: 'Accent',
        weight: 'Bolder',
      },
      {
        type: 'TextBlock',
        text: question,
        wrap: true,
        weight: 'Bolder',
        size: 'Medium',
        spacing: 'None',
      },
    ],
  };

  if (result.ok === false) {
    const errorMsg = result.error;
    return {
      type: 'AdaptiveCard', ...SCHEMA,
      body: [
        headerContainer,
        {
          type: 'Container',
          style: 'attention',
          spacing: 'Small',
          items: [
            { type: 'TextBlock', text: `❌  ${errorMsg}`, wrap: true, color: 'Light' },
          ],
        },
      ],
    };
  }

  const { rows } = result;

  if (rows.length === 0) {
    return {
      type: 'AdaptiveCard', ...SCHEMA,
      body: [
        headerContainer,
        {
          type: 'Container',
          style: 'warning',
          spacing: 'Small',
          items: [{ type: 'TextBlock', text: 'No rows returned.', color: 'Light' }],
        },
      ],
    };
  }

  const columns = Object.keys(rows[0]);

  const rowContainers = rows.map((row: any, i: number) => ({
    type: 'Container',
    style: i % 2 === 0 ? 'default' : 'emphasis',
    separator: i > 0,
    spacing: 'None',
    items: [{
      type: 'FactSet',
      facts: columns.map((col: string) => ({ title: col, value: truncate(row[col]) })),
    }],
  }));

  const rowLabel = rows.length === 50
    ? 'Showing first 50 rows'
    : `${rows.length} row${rows.length === 1 ? '' : 's'}`;

  return {
    type: 'AdaptiveCard', ...SCHEMA,
    body: [
      headerContainer,
      ...rowContainers,
      {
        type: 'TextBlock',
        text: rowLabel,
        size: 'Small',
        color: 'Good',
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
  };
}
