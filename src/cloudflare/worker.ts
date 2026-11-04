import { bytesToHex, rendezvousPath } from '@cherrystudio/relay-protocol'
import { DurableObject } from 'cloudflare:workers'

import { DurableRelayRuntime } from './runtime.js'

interface Env {
  RELAY: DurableObjectNamespace<RelayObject>
  RELAY_CONFIG?: string
}

function validate(request: Request): Response | undefined {
  const url = new URL(request.url)
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  if (url.search) return new Response('Query parameters are not accepted', { status: 400 })
  if (url.pathname === '/healthz') return Response.json({ status: 'ok' })
  if (url.pathname === '/readyz') return Response.json({ status: 'ready' })
  if (url.pathname !== rendezvousPath) return new Response('Not found', { status: 404 })
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response('WebSocket required', { status: 426 })
  return undefined
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const response = validate(request)
    if (response) return response
    // Stable for this deployment, not per HTTP request/user. Existing clients carry their target
    // only after upgrade, so spreading these sockets across arbitrary DOs would break rendezvous.
    return env.RELAY.get(env.RELAY.idFromName('relay-v1')).fetch(request)
  },
} satisfies ExportedHandler<Env>

export class RelayObject extends DurableObject<Env> {
  protected readonly relay: DurableRelayRuntime
  private alarmAt: number | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const overrides: unknown = env.RELAY_CONFIG === undefined ? {} : JSON.parse(env.RELAY_CONFIG)
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))
      throw new Error('Invalid RELAY_CONFIG')
    this.relay = new DurableRelayRuntime(
      {
        sockets: () => ctx.getWebSockets(),
        now: () => Date.now(),
        randomHex: (bytes) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes))),
        sha256: async (text) =>
          bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))),
      },
      overrides,
    )
    ctx.blockConcurrencyWhile(async () => {
      this.alarmAt = await ctx.storage.getAlarm()
      await this.flush()
    })
  }

  async fetch(request: Request): Promise<Response> {
    const response = validate(request)
    if (response) return response
    const rejected = this.relay.reserveUpgrade()
    if (rejected) {
      await this.flush()
      return new Response('Relay unavailable', { status: rejected })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    this.relay.open(pair[1])
    await this.flush()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.relay.message(socket, message)
    } finally {
      await this.flush()
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.relay.closed(socket)
    await this.flush()
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.relay.closed(socket)
    await this.flush()
  }

  async alarm(): Promise<void> {
    this.alarmAt = null
    this.relay.tick()
    await this.flush()
  }

  private async flush(): Promise<void> {
    try {
      this.relay.checkpoint()
      const deadline = this.relay.nextDeadline
      // Keep an already-earlier alarm. ACKs don't rewrite storage on every frame; a harmless
      // final alarm may wake once, then an idle listener/ready session has no recurring timer.
      if (deadline !== undefined && (this.alarmAt === null || deadline < this.alarmAt)) {
        this.alarmAt = Math.max(Date.now() + 1, deadline)
        await this.ctx.storage.setAlarm(this.alarmAt)
      }
    } catch {
      // Never keep using sockets after a failed checkpoint; reconnect with a fresh Noise stream.
      this.ctx.abort('Relay checkpoint failed')
    }
  }
}
