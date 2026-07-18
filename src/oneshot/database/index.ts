import type { Pool, PoolConnection } from 'mysql2/promise'
import { OneShotRunsDB } from './runs.js'
import { OneShotArtifactsDB } from './artifacts.js'
import { OneShotNotificationsDB } from './notifications.js'
import { OneShotRunEventsDB } from './events.js'
import { OneShotRunGroupsDB } from './run-groups.js'
import { OneShotWorkspaceLeasesDB } from './workspace-leases.js'
import { OneShotWorkspaceStateDB } from './workspace-state.js'
import { OneShotCandidateVersionsDB } from './candidate-versions.js'
import { OneShotGitHubCommandsDB } from './github-commands.js'

export type OneShotQueryExecutor = Pool | PoolConnection

export class OneShotDatabase {
  readonly runs: OneShotRunsDB
  readonly artifacts: OneShotArtifactsDB
  readonly notifications: OneShotNotificationsDB
  readonly events: OneShotRunEventsDB
  readonly runGroups: OneShotRunGroupsDB
  readonly workspaceLeases: OneShotWorkspaceLeasesDB
  readonly workspaceState: OneShotWorkspaceStateDB
  readonly candidateVersions: OneShotCandidateVersionsDB
  readonly githubCommands: OneShotGitHubCommandsDB

  constructor(pool: OneShotQueryExecutor) {
    this.runs = new OneShotRunsDB(pool)
    this.artifacts = new OneShotArtifactsDB(pool)
    this.notifications = new OneShotNotificationsDB(pool)
    this.events = new OneShotRunEventsDB(pool)
    this.runGroups = new OneShotRunGroupsDB(pool)
    this.workspaceLeases = new OneShotWorkspaceLeasesDB(pool)
    this.workspaceState = new OneShotWorkspaceStateDB(pool)
    this.candidateVersions = new OneShotCandidateVersionsDB(pool)
    this.githubCommands = new OneShotGitHubCommandsDB(pool)
  }
}

export { OneShotRunsDB } from './runs.js'
export { OneShotArtifactsDB } from './artifacts.js'
export { OneShotNotificationsDB } from './notifications.js'
export { OneShotRunEventsDB } from './events.js'
export { OneShotRunGroupsDB } from './run-groups.js'
export { OneShotWorkspaceLeasesDB } from './workspace-leases.js'
export { OneShotWorkspaceStateDB } from './workspace-state.js'
export { OneShotCandidateVersionsDB } from './candidate-versions.js'
export { OneShotGitHubCommandsDB } from './github-commands.js'
