# Plan 02: Configuration and Runtime Alignment

## Problem

Specter's configuration model is split across several competing sources:

- `DB_*` and `MYSQL_*`
- `BEDROCK_MODEL` and `BEDROCK_MODEL_ID`
- multiple path defaults for EFS and repositories
- mixed worker entrypoints in `package.json`
- Dockerfile defaults that do not fully match the current repo layout

This is survivable in one environment and fragile everywhere else.

## Current symptoms

- `src/config/index.ts` still defaults to `/mnt/efs/repos`
- `scripts/entrypoint.sh` still defaults to `/mnt/efs/repos`
- orchestrator and workers mostly use `DB_*`, while `src/config/index.ts` still models `MYSQL_*`
- package scripts mix `dist/worker-main.js` with `dist/orchestrator/workers/index.js`

## Goals

- define one canonical env surface per service
- align code, scripts, Dockerfiles, `.env.example`, and Terraform around that surface
- make `worker-main` the only supported worker runtime path
- add startup validation so configuration mistakes fail immediately

## Proposed target state

- one config module used by orchestrator, workers, and Harvey
- one set of canonical env names
- legacy aliases supported temporarily but logged as deprecated
- one worker entrypoint pattern in scripts and deploys

## Work breakdown

### 1. Publish the canonical config contract

- database env vars
- Bedrock/model env vars
- EFS path env vars
- service bind/env vars
- agent-specific env vars like BEACON and BCAT

### 2. Refactor code to consume the same config layer

- orchestrator
- worker runtime
- Harvey
- direct Bedrock callers

### 3. Normalize scripts and Dockerfiles

- make `npm run worker` plus `WORKER_TYPE=<type>` the standard path
- retire or label legacy worker scripts
- align Docker defaults with `/mnt/efs/specter-repo/...`

### 4. Add validation and deprecation warnings

- fail when required config is absent
- warn when legacy aliases are being used

## Deliverables

- unified config module
- updated scripts and entrypoints
- deprecation matrix for old env names
- docs and Terraform alignment

## Success criteria

- fresh local setup can follow one documented env contract
- Dockerfiles, Terraform, and `.env.example` all point to the same path and model variables
- only one worker runtime path is officially supported

## Dependencies

- should start alongside Plan 01 because secret and config boundaries overlap

## Out of scope

- replacing `.env` with a full remote config service
