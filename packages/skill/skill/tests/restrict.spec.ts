import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry, {
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

function candidate(name: string, rank = 100): SkillCandidate {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'memory',
    source: 'memory',
    rank,
    locator: { content: `${name} body` },
  }
}

class MemoryProvider implements SkillProvider {
  readonly name = 'memory'

  constructor(private readonly candidates: SkillCandidate[]) {}

  async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
    return this.candidates
  }

  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    return { ...candidate, content: (candidate.locator as { content: string }).content }
  }
}

/** The skills service as the given scope's caller resolves it (scope contexts declare no inject). */
function scopedSkills(ctx: Context): SkillRegistry {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('skills service missing')
  return skills
}

async function seed(provider: SkillProvider = new MemoryProvider([candidate('alpha'), candidate('beta'), candidate('gamma')])): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  ctx.skills.registerProvider(() => provider)
  return ctx
}

describe('SkillRegistry.restrict', () => {
  it('filters catalog listings and body loads for the calling scope only', async () => {
    const ctx = await seed()
    const preset = createScope(ctx, { preset: 'narrow' })

    scopedSkills(preset.ctx).restrict({ allow: ['alpha', 'gamma'] })

    const scoped = scopeOf(preset.ctx)
    expect((await ctx.skills.list({ scope: scoped })).map(skill => skill.name)).toEqual(['alpha', 'gamma'])
    expect((await ctx.skills.get('beta', { scope: scoped }))).toBeUndefined()
    expect((await ctx.skills.get('alpha', { scope: scoped }))?.content).toBe('alpha body')
    // Unscoped readers (host projections) keep the unfiltered catalog.
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['alpha', 'beta', 'gamma'])
    await preset.dispose()
  })

  it('lifts on dispose', async () => {
    const ctx = await seed()
    const preset = createScope(ctx, { preset: 'lift' })
    const scoped = scopeOf(preset.ctx)

    const dispose = scopedSkills(preset.ctx).restrict({ allow: ['alpha'] })
    expect((await ctx.skills.list({ scope: scoped })).map(skill => skill.name)).toEqual(['alpha'])

    dispose()
    expect((await ctx.skills.list({ scope: scoped })).map(skill => skill.name)).toEqual(['alpha', 'beta', 'gamma'])
    await preset.dispose()
  })

  it('intersects along the scope chain', async () => {
    const ctx = await seed()
    const parent = createScope(ctx, { preset: 'parent' })
    const child = createScope(ctx, { preset: 'child' })
    bindScopeParent(scopeOf(child.ctx) as object, scopeOf(parent.ctx) as object)

    scopedSkills(parent.ctx).restrict({ allow: ['alpha', 'beta'] })
    scopedSkills(child.ctx).restrict({ allow: ['beta', 'gamma'] })

    expect((await ctx.skills.list({ scope: scopeOf(parent.ctx) })).map(skill => skill.name)).toEqual(['alpha', 'beta'])
    expect((await ctx.skills.list({ scope: scopeOf(child.ctx) })).map(skill => skill.name)).toEqual(['beta'])
    expect(await ctx.skills.get('alpha', { scope: scopeOf(child.ctx) })).toBeUndefined()
    await child.dispose()
    await parent.dispose()
  })

  it('keeps the scope’s own registrations visible', async () => {
    const ctx = await seed()
    const preset = createScope(ctx, { preset: 'owns' })
    scopedSkills(preset.ctx).register({ name: 'agent-local', description: 'Agent local', source: 'runtime', content: 'local body' })

    scopedSkills(preset.ctx).restrict({ allow: ['alpha'] })

    expect((await ctx.skills.list({ scope: scopeOf(preset.ctx) })).map(skill => skill.name)).toEqual(['agent-local', 'alpha'])
    await preset.dispose()
  })

  it('keeps names discovery never produces inert and hides everything on an empty allow', async () => {
    const ctx = await seed()
    const preset = createScope(ctx, { preset: 'inert' })
    const scoped = scopeOf(preset.ctx)

    expect(() => scopedSkills(preset.ctx).restrict({ allow: ['ghost-skill'] })).not.toThrow()
    expect(await ctx.skills.list({ scope: scoped })).toEqual([])

    const empty = createScope(ctx, { preset: 'empty' })
    scopedSkills(empty.ctx).restrict({ allow: [] })
    expect(await ctx.skills.list({ scope: scopeOf(empty.ctx) })).toEqual([])
    await empty.dispose()
    await preset.dispose()
  })

  it('requires a scoped context and an explicit allow array', async () => {
    const ctx = await seed()
    // Context-global restriction would mask every agent.
    expect(() => ctx.skills.restrict({ allow: ['alpha'] })).toThrow(/scoped context/)
    const preset = createScope(ctx, { preset: 'invalid' })
    expect(() => scopedSkills(preset.ctx).restrict({} as unknown as { allow: readonly string[] })).toThrow(/allow/)
    expect(() => scopedSkills(preset.ctx).restrict({ allow: ['alpha', 3] } as unknown as { allow: readonly string[] })).toThrow(/non-empty strings/)
    await preset.dispose()
  })

  it('invalidates cached discovery when a restriction changes', async () => {
    const ctx = await seed()
    const preset = createScope(ctx, { preset: 'cache' })
    const scoped = scopeOf(preset.ctx)

    expect((await ctx.skills.list({ scope: scoped })).map(skill => skill.name)).toEqual(['alpha', 'beta', 'gamma'])
    const dispose = scopedSkills(preset.ctx).restrict({ allow: ['gamma'] })
    expect((await ctx.skills.list({ scope: scoped })).map(skill => skill.name)).toEqual(['gamma'])
    dispose()
    expect((await ctx.skills.list({ scope: scoped })).map(skill => skill.name)).toEqual(['alpha', 'beta', 'gamma'])
    await preset.dispose()
  })
})
