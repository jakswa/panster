const nodeEnv = process.env['NODE_ENV'] ?? 'development'
const port = readPort()

export const env = {
  PORT: port,
  NODE_ENV: nodeEnv,
  PUBLIC_ORIGIN: readPublicOrigin(port),
  TURN_HOST: readTurnHost(),
  TURN_SHARED_SECRET: readTurnSharedSecret(),
  ASSET_VERSION:
    nodeEnv === 'production' ? mustGet('ASSET_VERSION') : String(Date.now()),
}

function readTurnSharedSecret() {
  const value = process.env['TURN_SHARED_SECRET']
  if (!value && nodeEnv === 'production') {
    throw new Error('Missing required environment variable: TURN_SHARED_SECRET')
  }
  if (
    nodeEnv === 'production' &&
    value &&
    (value.length < 32 || value.startsWith('replace-'))
  ) {
    throw new Error('TURN_SHARED_SECRET must be a strong secret')
  }
  return value ?? ''
}

function readTurnHost() {
  const value = process.env['TURN_HOST'] ?? 'turn.panster.click'
  if (value.length > 253 || !/^[a-z0-9.-]+$/i.test(value)) {
    throw new Error('TURN_HOST must be a hostname')
  }
  return value
}

function readPublicOrigin(port: number) {
  const raw = process.env['PUBLIC_ORIGIN'] ?? `http://localhost:${port}`
  const url = new URL(raw)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_ORIGIN must use http or https')
  }

  return url.origin
}

function mustGet(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readPort() {
  const raw = process.env['PORT'] ?? '3000'
  const port = Number(raw)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`)
  }

  return port
}
