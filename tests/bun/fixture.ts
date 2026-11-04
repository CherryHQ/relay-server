import { randomBytes } from 'node:crypto'

import { RelayStream, respondToRelayProbe } from '@cherrystudio/relay-client'
import {
  assertReadyMatches,
  type ClientControl,
  parseRelayReady,
  parseServerControl,
  type RelaySelection,
  type ServerControl,
} from '@cherrystudio/relay-protocol'
import { defaultLogger } from '@libp2p/logger'

import { type BunRelayOptions, BunRelayRuntime } from '../../src/bun/runtime.js'

export async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Condition timed out')
    await Bun.sleep(5)
  }
}

export class RawPeer {
  readonly socket: WebSocket
  readonly opened: Promise<void>
  readonly closed: Promise<CloseEvent>
  private readonly messages: (string | Uint8Array)[] = []
  private capture = true
  autoReceipts = true

  constructor(url: string, ca?: string) {
    this.socket = new WebSocket(url, { perMessageDeflate: false, ...(ca ? { tls: { ca } } : {}) })
    this.socket.binaryType = 'arraybuffer'
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true })
      this.socket.addEventListener('error', () => reject(new Error('Socket failed to open')), { once: true })
      this.socket.addEventListener('close', () => reject(new Error('Socket closed before opening')), {
        once: true,
      })
    })
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', resolve, { once: true }))
    this.socket.addEventListener('message', (event) => {
      if (
        this.capture &&
        this.autoReceipts &&
        typeof event.data === 'string' &&
        respondToRelayProbe(this.socket, event.data)
      )
        return
      if (this.capture)
        this.messages.push(
          typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer),
        )
    })
  }

  send(message: ClientControl | Uint8Array): void {
    this.socket.send(message instanceof Uint8Array ? message : JSON.stringify(message))
  }

  async control<T extends ServerControl['type']>(type: T): Promise<Extract<ServerControl, { type: T }>> {
    const index = () =>
      this.messages.findIndex(
        (message) => typeof message === 'string' && parseServerControl(message).type === type,
      )
    await until(() => index() !== -1)
    const message = this.messages.splice(index(), 1)[0]
    if (typeof message !== 'string') throw new Error('Missing control')
    return parseServerControl(message) as Extract<ServerControl, { type: T }>
  }

  async binary(): Promise<Uint8Array> {
    const index = () => this.messages.findIndex((message) => message instanceof Uint8Array)
    await until(() => index() !== -1)
    const message = this.messages.splice(index(), 1)[0]
    if (!(message instanceof Uint8Array)) throw new Error('Missing binary')
    return message
  }

  stream(selection: RelaySelection): Promise<RelayStream> {
    this.capture = false
    this.messages.length = 0
    // Install synchronously before start. A promise continuation after ready can miss pipelined DATA.
    return new Promise((resolve, reject) => {
      const fail = () => {
        cleanup()
        reject(new Error('Connection ended before ready'))
      }
      const message = (event: MessageEvent) => {
        try {
          if (typeof event.data !== 'string') throw new Error('Expected ready')
          assertReadyMatches(parseRelayReady(event.data), selection)
          cleanup()
          resolve(
            new RelayStream(this.socket, {
              limits: selection.limits,
              log: defaultLogger().forComponent('runtime-test'),
            }),
          )
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      const timer = setTimeout(fail, 2000)
      const cleanup = () => {
        clearTimeout(timer)
        this.socket.removeEventListener('message', message)
        this.socket.removeEventListener('close', fail)
        this.socket.removeEventListener('error', fail)
      }
      this.socket.addEventListener('message', message)
      this.socket.addEventListener('close', fail)
      this.socket.addEventListener('error', fail)
    })
  }
}

export function runtimeFixture(options: BunRelayOptions & { ca?: string } = {}) {
  const runtime = new BunRelayRuntime({ ...options, hostname: '127.0.0.1', port: 0 })
  const peers = new Set<RawPeer>()
  const url = `${options.tls ? 'wss' : 'ws'}://127.0.0.1:${runtime.server.port}/v1/relay`
  const open = async (message?: ClientControl) => {
    const peer = new RawPeer(url, options.ca)
    peers.add(peer)
    await peer.opened
    if (message) peer.send(message)
    return peer
  }
  const listen = async (hostKey = randomBytes(32).toString('hex')) => {
    const peer = await open({ v: 1, type: 'listen', hostKey })
    const info = await peer.control('listening')
    return { peer, info, hostKey }
  }
  const pending = async (host: Awaited<ReturnType<typeof listen>>) => {
    const app = await open({ v: 1, type: 'connect', targetId: host.info.targetId })
    const selection = await app.control('pending')
    const offer = await host.peer.control('offer')
    return { app, selection, offer }
  }
  const attach = async (offer: Awaited<ReturnType<typeof pending>>['offer']) => {
    const desktop = await open({
      v: 1,
      type: 'attach',
      sessionId: offer.sessionId,
      ownerEpoch: offer.ownerEpoch,
      ticket: offer.ticket,
    })
    const selection = await desktop.control('pending')
    assertReadyMatches({ ...selection, type: 'ready' }, offer)
    return desktop
  }
  const pair = async (host: Awaited<ReturnType<typeof listen>>) => {
    const request = await pending(host)
    const desktop = await attach(request.offer)
    const start: ClientControl = {
      v: 1,
      type: 'start',
      sessionId: request.selection.sessionId,
      ownerEpoch: request.selection.ownerEpoch,
    }
    return {
      ...request,
      desktop,
      async ready() {
        request.app.send(start)
        desktop.send(start)
        await Promise.all([request.app.control('ready'), desktop.control('ready')])
      },
      async streams() {
        const appStream = request.app.stream(request.selection)
        const desktopStream = desktop.stream(request.selection)
        request.app.send(start)
        desktop.send(start)
        return Promise.all([desktopStream, appStream])
      },
    }
  }
  return {
    runtime,
    url,
    open,
    listen,
    pending,
    attach,
    pair,
    async dispose() {
      for (const peer of peers) peer.socket.terminate()
      await runtime.stop(0)
    },
  }
}
