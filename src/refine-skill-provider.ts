/** Packaged refine Skill provider for the Prime preset. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'prime-refine'
const SKILL_URL = new URL('../skills/refine/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/refine/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: false } as const
const CANDIDATE: SkillCandidate = {
  name: 'refine',
  description: 'Schedule stable, evidence-backed learning after repeated failures, reusable tactics, durable corrections, or incorrect learning entries.',
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_URL, 'utf8'),
    }
  },
}

export const name = 'prime-refine-skill-provider'
export const inject = ['skills']

export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
