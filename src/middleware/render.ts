import { Eta } from 'eta'
import { createMiddleware } from 'hono/factory'
import type { Renderer } from '../app-types'
import { env } from '../utils/env'
import { paths } from '../utils/paths'

const eta = new Eta({
  views: paths.views,
  cache: env.NODE_ENV === 'production',
})

export const renderMiddleware = createMiddleware<{
  Variables: {
    render: Renderer
  }
}>(async (c, next) => {
  c.set('render', async (template, data = {}) => {
    const html = await eta.renderAsync(template, {
      ...data,
      assetVersion: env.ASSET_VERSION,
    })

    return c.html(html)
  })

  await next()
})
