import { app } from './app'
import { websocket } from './realtime/signaling'
import { env } from './utils/env'

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
}
