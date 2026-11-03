import { readEnvironment } from '../config.js'
import { BunRelayRuntime } from './runtime.js'

const settings = readEnvironment(process.env)
const runtime = new BunRelayRuntime({
  hostname: settings.hostname,
  port: settings.port,
  config: settings.config,
  ...(settings.certFile && settings.keyFile
    ? { tls: { cert: Bun.file(settings.certFile), key: Bun.file(settings.keyFile) } }
    : {}),
})
console.log(`Cherry Relay listening at ${runtime.server.url}`)

const stop = () => {
  void runtime
    .stop()
    .then(() => console.log('Cherry Relay stopped', runtime.getStats()))
    .catch(() => {
      console.error('Cherry Relay shutdown failed')
      process.exitCode = 1
    })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
