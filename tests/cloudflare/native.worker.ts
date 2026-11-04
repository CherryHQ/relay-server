import worker, { RelayObject as ProductionRelayObject } from '../../src/cloudflare/worker.js'

export default {
  fetch(request: Request, env: Parameters<typeof worker.fetch>[1]) {
    if (new URL(request.url).pathname === '/__test/stats')
      return env.RELAY.get(env.RELAY.idFromName('relay-v1')).fetch(request)
    return worker.fetch(request, env)
  },
}

/** Test-only inspection. This class is never exported by the deployment entry point. */
export class RelayObject extends ProductionRelayObject {
  private readonly bootId = crypto.randomUUID()
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/stats')
      return Response.json({
        ...this.relay.getStats(),
        ownerEpoch: this.relay.ownerEpoch,
        bootId: this.bootId,
      })
    return super.fetch(request)
  }
}
