// Asking a tracker what it knows about one infohash: a scrape. Used to check
// that the seed boxes really announced to our tracker — a box that seeds but
// cannot reach the tracker is invisible to every reader without DHT.
//
//   http(s)://…/announce → …/scrape?info_hash=<20 raw bytes, %-encoded>
//   udp://host:port      → BEP 15: connect, then scrape
import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'

export interface ScrapeResult {
  /** seeders */
  complete: number
  /** leechers */
  incomplete: number
  downloaded: number
}

/** Thrown when the tracker answered with a refusal, as opposed to not answering. */
export class TrackerRefused extends Error {
  override name = 'TrackerRefused'
}

type BValue = number | Uint8Array | BValue[] | Map<string, BValue>

/** Just enough bencode decoding for a tracker reply. Keys come back as latin1. */
export function bdecode(buf: Uint8Array): BValue {
  let i = 0
  const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1')
  const fail = (m: string): never => {
    throw new Error(`bdecode: ${m} at byte ${i}`)
  }
  const value = (depth: number): BValue => {
    if (depth > 32) fail('nested too deep')
    const c = buf[i]
    if (c === 0x69) {
      const end = buf.indexOf(0x65, i)
      if (end < 0) fail('unterminated integer')
      const s = latin1(buf.subarray(i + 1, end))
      if (!/^-?\d+$/.test(s)) fail('bad integer')
      i = end + 1
      return Number(s)
    }
    if (c === 0x6c || c === 0x64) {
      i++
      const list: BValue[] = []
      const dict = new Map<string, BValue>()
      while (buf[i] !== 0x65) {
        if (i >= buf.length) fail('unterminated list')
        if (c === 0x6c) list.push(value(depth + 1))
        else {
          const k = value(depth + 1)
          if (!(k instanceof Uint8Array)) fail('dict key is not a string')
          dict.set(latin1(k as Uint8Array), value(depth + 1))
        }
      }
      i++
      return c === 0x6c ? list : dict
    }
    const colon = buf.indexOf(0x3a, i)
    if (colon < 0) fail('expected a value')
    const len = Number(latin1(buf.subarray(i, colon)))
    if (!Number.isSafeInteger(len) || len < 0 || colon + 1 + len > buf.length) fail('bad string length')
    i = colon + 1 + len
    return buf.subarray(colon + 1, i)
  }
  const v = value(0)
  if (i !== buf.length) fail('trailing bytes')
  return v
}

const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))
const num = (v: BValue | undefined): number => (typeof v === 'number' ? v : 0)

/** BEP 48: the scrape URL is the announce URL with its last `announce` replaced. */
export function scrapeUrlFor(announce: string): string | null {
  const u = new URL(announce)
  const last = u.pathname.lastIndexOf('/')
  const tail = u.pathname.slice(last + 1)
  if (!tail.startsWith('announce')) return null
  u.pathname = `${u.pathname.slice(0, last + 1)}scrape${tail.slice('announce'.length)}`
  return u.toString()
}

export async function httpScrape(announce: string, infohash: string, o: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<ScrapeResult | null> {
  const url = scrapeUrlFor(announce)
  if (!url) throw new Error(`${announce}: cannot derive a scrape URL (the path does not end in /announce)`)
  const q = Array.from(hexToBytes(infohash), (b) => `%${b.toString(16).padStart(2, '0')}`).join('')
  const res = await (o.fetch ?? fetch)(`${url}${url.includes('?') ? '&' : '?'}info_hash=${q}`, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const v = bdecode(new Uint8Array(await res.arrayBuffer()))
  if (!(v instanceof Map)) throw new Error(`${url}: reply is not a dictionary`)
  const reason = v.get('failure reason')
  if (reason instanceof Uint8Array) throw new TrackerRefused(Buffer.from(reason).toString('utf8'))
  const files = v.get('files')
  if (!(files instanceof Map)) return null
  const entry = files.get(Buffer.from(hexToBytes(infohash)).toString('latin1'))
  if (!(entry instanceof Map)) return null
  return { complete: num(entry.get('complete')), incomplete: num(entry.get('incomplete')), downloaded: num(entry.get('downloaded')) }
}

const PROTOCOL_ID = 0x41727101980n

export async function udpScrape(announce: string, infohash: string, o: { timeoutMs?: number } = {}): Promise<ScrapeResult> {
  const u = new URL(announce)
  const port = Number(u.port)
  if (u.protocol !== 'udp:' || !port) throw new Error(`${announce}: not a udp://host:port tracker`)
  const sock = createSocket('udp4')
  const deadline = Date.now() + (o.timeoutMs ?? 10_000)
  try {
    const ask = (req: Buffer, txid: number): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        // UDP drops packets: resend every 2 s until the deadline.
        const send = (): void => sock.send(req, port, u.hostname.replace(/^\[|\]$/g, ''), (e) => e && reject(e))
        const resend = setInterval(send, 2000)
        const timer = setTimeout(() => done(new Error(`${announce}: no answer`)), Math.max(0, deadline - Date.now()))
        const onMsg = (m: Buffer): void => {
          if (m.length >= 8 && m.readUInt32BE(4) === txid) done(undefined, m)
        }
        const done = (e?: Error, m?: Buffer): void => {
          clearInterval(resend)
          clearTimeout(timer)
          sock.off('message', onMsg)
          if (e) reject(e)
          else resolve(m!)
        }
        sock.on('message', onMsg)
        send()
      })
    const refused = (m: Buffer): never => {
      throw new TrackerRefused(m.subarray(8).toString('utf8'))
    }

    const tx1 = randomBytes(4).readUInt32BE(0)
    const connect = Buffer.alloc(16)
    connect.writeBigUInt64BE(PROTOCOL_ID, 0)
    connect.writeUInt32BE(0, 8)
    connect.writeUInt32BE(tx1, 12)
    const r1 = await ask(connect, tx1)
    if (r1.readUInt32BE(0) === 3) refused(r1)
    if (r1.readUInt32BE(0) !== 0 || r1.length < 16) throw new Error(`${announce}: bad connect reply`)

    const tx2 = randomBytes(4).readUInt32BE(0)
    const scrape = Buffer.alloc(36)
    r1.copy(scrape, 0, 8, 16) // connection id
    scrape.writeUInt32BE(2, 8)
    scrape.writeUInt32BE(tx2, 12)
    Buffer.from(hexToBytes(infohash)).copy(scrape, 16)
    const r2 = await ask(scrape, tx2)
    if (r2.readUInt32BE(0) === 3) refused(r2)
    if (r2.readUInt32BE(0) !== 2 || r2.length < 20) throw new Error(`${announce}: bad scrape reply`)
    return { complete: r2.readUInt32BE(8), downloaded: r2.readUInt32BE(12), incomplete: r2.readUInt32BE(16) }
  } finally {
    sock.close()
  }
}

/** Scrape whichever kind of tracker this is. null: the tracker does not list the infohash. */
export function scrape(announce: string, infohash: string, o: { timeoutMs?: number } = {}): Promise<ScrapeResult | null> {
  if (announce.startsWith('udp:')) return udpScrape(announce, infohash, o)
  if (/^https?:/.test(announce)) return httpScrape(announce, infohash, o)
  return Promise.reject(new Error(`${announce}: can only scrape udp and http(s) trackers`))
}
