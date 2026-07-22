const nodeEnv = process.env['NODE_ENV'] ?? 'development'
const port = readPort()

export const env = {
  PORT: port,
  NODE_ENV: nodeEnv,
  PUBLIC_ORIGIN: readPublicOrigin(port),
  ASSET_VERSION:
    nodeEnv === 'production' ? mustGet('ASSET_VERSION') : String(Date.now()),
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
