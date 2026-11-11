// An in-memory NIP-01 relay behind a SocketFactory: stores what it is sent,
// answers REQ with stored matches then EOSE, pushes live events to open
// subscriptions, and lets a test refuse posts.
import type { Filter, SocketFactory, SocketLike } from '../../src/nostr/relay.js'
import type { NostrEvent } from '../../src/souspli.js'

type Listener = (ev?: { data: unknown }) => void

export interface FakeRelay {
  factory: SocketFactory
  events: NostrEvent[]
  /** posts the relay answered OK false to */
  refused: NostrEvent[]
  /** return a message to refuse an event */
  refuse?: (ev: NostrEvent) => string | undefined
  /** inject an event as if another client posted it */
  inject(ev: NostrEvent): void
  connections: number
}

function matches(ev: NostrEvent, f: Filter): boolean {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.since !== undefined && ev.created_at < f.since) return false
  if (f.until !== undefined && ev.created_at > f.until) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(v)) continue
    const name = k.slice(1)
    if (!ev.tags.some((t) => t[0] === name && v.includes(t[1]!))) return false
  }
  return true
}

export function fakeRelay(): FakeRelay {
  const subs = new Map<string, { send: (s: string) => void; filters: Filter[] }>()
  const relay: FakeRelay = {
    events: [],
    refused: [],
    connections: 0,
    inject(ev) {
      relay.events.push(ev)
      for (const [id, s] of subs) if (s.filters.some((f) => matches(ev, f))) s.send(JSON.stringify(['EVENT', id.split('\u0000')[1], ev]))
    },
    factory: () => {
      relay.connections++
      const listeners: Record<string, Listener[]> = {}
      const emit = (type: string, arg?: { data: unknown }): void => listeners[type]?.forEach((fn) => fn(arg))
      const conn = Math.random().toString(36)
      const toClient = (s: string): void => queueMicrotask(() => emit('message', { data: s }))
      const ws: SocketLike & { readyState: number } = {
        readyState: 0,
        send(data: string) {
          const msg = JSON.parse(data) as unknown[]
          if (msg[0] === 'EVENT') {
            const ev = msg[1] as NostrEvent
            const why = relay.refuse?.(ev)
            if (why) {
              relay.refused.push(ev)
              toClient(JSON.stringify(['OK', ev.id, false, why]))
              return
            }
            const dup = relay.events.some((e) => e.id === ev.id)
            toClient(JSON.stringify(['OK', ev.id, true, dup ? 'duplicate: have it' : '']))
            if (!dup) relay.inject(ev)
          } else if (msg[0] === 'REQ') {
            const id = msg[1] as string
            const filters = msg.slice(2) as Filter[]
            subs.set(`${conn}\u0000${id}`, { send: toClient, filters })
            for (const ev of relay.events) if (filters.some((f) => matches(ev, f))) toClient(JSON.stringify(['EVENT', id, ev]))
            toClient(JSON.stringify(['EOSE', id]))
          } else if (msg[0] === 'CLOSE') subs.delete(`${conn}\u0000${msg[1] as string}`)
        },
        close() {
          ws.readyState = 3
          for (const k of [...subs.keys()]) if (k.startsWith(`${conn}\u0000`)) subs.delete(k)
          queueMicrotask(() => emit('close'))
        },
        addEventListener(type: string, fn: Listener) {
          ;(listeners[type] ??= []).push(fn)
        }
      } as SocketLike & { readyState: number }
      queueMicrotask(() => {
        ws.readyState = 1
        emit('open')
      })
      return ws
    }
  }
  return relay
}
