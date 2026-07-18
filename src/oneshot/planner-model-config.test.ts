import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('OneShot planner Terraform model config', () => {
  it('uses Opus 4.8 for the main planner while keeping scout model separate', async () => {
    const sharedTfvars = await readFile('terraform/shared.auto.tfvars', 'utf8')
    const variablesTf = await readFile('terraform/variables.tf', 'utf8')

    expect(sharedTfvars).toContain(
      'oneshot_planner_model_id                  = "us.anthropic.claude-opus-4-8"',
    )
    expect(variablesTf).toContain(
      'default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"',
    )
  })
})
