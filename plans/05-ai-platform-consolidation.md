# Plan 05: AI Platform Consolidation

## Problem

Specter currently has two AI integration styles:

- the shared Claude Agent SDK runner in `src/claude-sdk`
- several direct Bedrock callers in orchestrator and Harvey code

That creates fragmentation in:

- model selection
- retries and timeouts
- budget controls
- telemetry
- prompt conventions

## Current hotspots

- `src/orchestrator/RepoAnalyzer.ts`
- `src/orchestrator/TaskDescriptionGenerator.ts`
- `src/harvey/IntakeAgent.ts`
- `src/harvey/AdminQuery.ts`

## Goals

- create one AI gateway for non-agent model calls
- keep Claude SDK-based agent execution centralized
- standardize timeout, retry, logging, and model configuration
- support prompt versioning and call tracing consistently

## Proposed target state

Introduce an `ai/` layer with explicit clients such as:

- `AgentExecutionClient` for Claude SDK runs
- `StructuredCompletionClient` for direct Bedrock structured generations
- `PromptRegistry` for reusable prompt templates and version labels

## Work breakdown

### 1. Define a unified invocation contract

- prompt input
- model selection
- response parsing
- timeout/retry policy
- telemetry hooks

### 2. Migrate direct Bedrock callers

- repo analysis
- task description generation
- Harvey intake
- admin SQL generation

### 3. Standardize model configuration

- one canonical env/config surface
- explicit defaults per use case
- optional budget classes by call type

### 4. Add call tracing

- correlation IDs
- timing
- model id
- failure classification

## Deliverables

- new AI gateway module
- migration of direct Bedrock callers
- removal of repeated Bedrock client setup and repeated env fallbacks

## Success criteria

- direct model calls no longer construct their own client/config logic ad hoc
- model changes can be made centrally
- AI failures can be observed consistently across orchestrator, workers, and Harvey

## Dependencies

- Plan 02 helps by standardizing model/env configuration

## Out of scope

- changing the core agent execution model away from Claude Agent SDK
