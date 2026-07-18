# Specter Overview for Confluence

## What Specter is

Specter is an asynchronous AI-agent platform for engineering workflows. It routes work from JIRA and Microsoft Teams into specialized agent workers that analyze code, validate SQL, plan implementations, and deliver results back to the originating system.

## Main components

### Orchestrator

- polls JIRA for issues that match agent JQL
- enriches issues with customer and repository context
- creates durable task records
- posts completed JIRA results back to the issue

### Workers

- one worker family per agent type
- claim work from MySQL
- run analysis against shared EFS repositories
- write result markdown to S3

### Harvey

- Teams bot front door
- converts free-form user requests into the same durable task pipeline
- proactively delivers results back to chat

## Supported agent families

- DARCI: defect investigation
- SCRIBE: code explanation
- PRISM: implementation planning
- HERMES: configuration lookup
- SENTRY: SQL safety review
- BEACON: MOANA SQL validation
- BCAT-PLANNER: spreadsheet-driven planning
- BCAT-EXECUTOR: bulk ticket creation
- VERITAS: evidence-driven RCA generation

## Storage model

- MySQL stores task state, routing, and session metadata
- EFS stores shared repositories and per-task workspaces
- S3 stores task descriptions and result markdown artifacts

## Why the architecture matters

Specter is designed for durability and operational isolation:

- large prompts and results are not stored inline in MySQL
- workers can scale horizontally without direct orchestrator RPC
- JIRA and Teams both feed the same processing backbone
