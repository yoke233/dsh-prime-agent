import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'prime-agent-tool-restrictions'
export const inject = ['tools']

export interface Config {
  /** Host-global tool names hidden from the calling Agent scope. */
  deny: string[]
}

export const Config: z<Config> = z.object({
  deny: z.array(z.string().min(1)).min(1),
})

/** Apply the preset-owned deny list to the calling Agent scope. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.restrict({ deny: config.deny })
}
