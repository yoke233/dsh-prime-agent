/** Packaged refine Skill provider for the Prime preset. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILL_RANK, } from '@deepseek-ai/dsh-skill';
const PROVIDER_NAME = 'prime-refine';
const SKILL_URL = new URL('../skills/refine/SKILL.md', import.meta.url);
const RESOURCE_BASE = {
    kind: 'directory',
    path: fileURLToPath(new URL('../skills/refine/', import.meta.url)),
};
const INVOCATION = { modelInvocable: true, userInvocable: false };
const CANDIDATE = {
    name: 'refine',
    description: 'Schedule stable, evidence-backed learning after repeated failures, reusable tactics, durable corrections, or incorrect learning entries.',
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_URL,
};
const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([CANDIDATE]),
    async get() {
        return {
            name: CANDIDATE.name,
            description: CANDIDATE.description,
            invocation: CANDIDATE.invocation,
            provider: CANDIDATE.provider,
            source: CANDIDATE.source,
            resourceBase: RESOURCE_BASE,
            content: await readFile(SKILL_URL, 'utf8'),
        };
    },
};
export const name = 'prime-refine-skill-provider';
export const inject = ['skills'];
export function apply(ctx) {
    ctx.skills.registerProvider(() => provider);
}
//# sourceMappingURL=refine-skill-provider.js.map