import { Hono } from 'hono'
import { env } from '../utils/env'

export const homeRoutes = new Hono()

homeRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'private, no-cache')
  return c.var.render('home', {
    title: 'Panster · Music, passed around',
    description:
      'Start a peer-to-peer listening room where friends take turns playing local MP3s. Nothing gets uploaded to Panster.',
    canonicalUrl: new URL('/', env.PUBLIC_ORIGIN).href,
  })
})
