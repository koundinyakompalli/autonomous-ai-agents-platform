import { describe, expect, it } from 'vitest'
import { buildOneShotPullRequestTitle } from './pr-title.js'

describe('buildOneShotPullRequestTitle', () => {
  it('formats a normal PR title from jira key and ticket summary', () => {
    expect(
      buildOneShotPullRequestTitle({
        jiraKey: 'CPDEV-21090',
        ticketSummary: 'Style the cancel button red',
      }),
    ).toBe('OneShot - CPDEV-21090: Style the cancel button red')
  })

  it('formats a WIP PR title from jira key and ticket summary', () => {
    expect(
      buildOneShotPullRequestTitle({
        jiraKey: 'CPDEV-21090',
        ticketSummary: 'Style the cancel button red',
        wip: true,
      }),
    ).toBe('OneShot - CPDEV-21090: Style the cancel button red [WIP]')
  })

  it('normalizes whitespace and newlines in the ticket summary', () => {
    expect(
      buildOneShotPullRequestTitle({
        jiraKey: 'CPDEV-21090',
        ticketSummary: 'Style the cancel button\nred   in member search',
      }),
    ).toBe('OneShot - CPDEV-21090: Style the cancel button red in member search')
  })

  it('falls back to the jira key when the ticket summary is missing', () => {
    expect(
      buildOneShotPullRequestTitle({
        jiraKey: 'CPDEV-21090',
        ticketSummary: '   ',
      }),
    ).toBe('OneShot - CPDEV-21090')
  })
})
