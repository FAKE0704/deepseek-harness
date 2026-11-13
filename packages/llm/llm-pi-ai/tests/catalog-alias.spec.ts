import { describe, expect, it } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { Model, OpenAICompletionsCompat } from '@earendil-works/pi-ai'
import { resolveProfiles } from '../src/config.ts'

/**
 * Catalog-aliased routes: a route whose key names no catalog provider resolves
 * its defaults (endpoint, protocol, model entries with compat) from a named
 * installed provider. The motivation is a second account on one vendor — the
 * route key must stay unique while the vendor's withheld compat (zai's
 * tool-stream handling and thinking format) still applies.
 */

type ZaiModel = Model<'openai-completions'> & { compat?: Partial<OpenAICompletionsCompat> }

/** A zai catalog model carrying the withheld tool-stream compat, whichever id ships it. */
function zaiToolStreamModel(): ZaiModel {
  const models = getBuiltinModels('zai') as ZaiModel[]
  const hit = models.find(model => model.compat?.zaiToolStream === true)
  expect(hit, 'installed zai catalog is expected to ship a zaiToolStream model').toBeDefined()
  return hit!
}

describe('catalogProvider alias', () => {
  it('an aliased route inherits the named vendor\'s catalog compat', () => {
    const catalogModel = zaiToolStreamModel()
    const resolved = resolveProfiles({
      'config-second-zai': {
        apiKeyEnv: 'ALIAS_TEST_KEY',
        catalogProvider: 'zai',
        models: [{ id: catalogModel.id }],
      },
    })
    const profile = resolved.get('config-second-zai')!
    expect(profile.piProvider).toBeDefined()
    const [model] = profile.piProvider!.getModels() as readonly ZaiModel[]
    expect(model).toBeDefined()
    expect(model!.id).toBe(catalogModel.id)
    // Route key stays the dict key, not the vendor id — uniqueness is the point.
    expect(model!.provider).toBe('config-second-zai')
    // Defaults come from the aliased catalog entry: endpoint, protocol, compat.
    expect(model!.baseUrl).toBe(catalogModel.baseUrl)
    expect(model!.api).toBe(catalogModel.api)
    expect(model!.compat?.zaiToolStream).toBe(true)
    expect(model!.compat?.thinkingFormat).toBe('zai')
    expect(model!.contextWindow).toBe(catalogModel.contextWindow)
  })

  it('an alias to a provider the catalog does not ship is refused', () => {
    expect(() => resolveProfiles({
      'config-second': {
        catalogProvider: 'not-a-vendor',
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
      },
    })).toThrow(/does not ship/)
  })

  it('an empty alias is refused at the profile boundary', () => {
    expect(() => resolveProfiles({
      'config-second': { catalogProvider: '', api: 'openai-completions', models: [{ id: 'm' }] },
    })).toThrow(/empty catalogProvider/)
  })

  it('absent alias keeps the historical lookups byte-for-byte', () => {
    // A route key the catalog does not describe still demands an explicit api.
    expect(() => resolveProfiles({
      'config-second': { models: [{ id: 'm' }] },
    })).toThrow(/needs an api/)
    // A catalog-named route still serves the installed catalog unchanged.
    const resolved = resolveProfiles({ zai: {} })
    const served = resolved.get('zai')!.piProvider!.getModels().map(model => model.id)
    expect(served).toEqual(getBuiltinModels('zai').map(model => model.id).sort())
  })
})
