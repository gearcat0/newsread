import { afterEach, describe, expect, it } from 'vitest'
import { createSocket, type Socket } from 'node:dgram'
import { bencode } from '../src/torrent.js'
import { bdecode, httpScrape, scrapeUrlFor, TrackerRefused, udpScrape } from '../src/tracker.js'

const H = '0123456789abcdef0123456789abcdef01234567'
const raw = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'))

describe('bdecode', () => {
  it('reads what bencode writes, and refuses junk', () => {
    const v = bdecode(bencode({ a: 1, b: 'xy', c: [2, 'z'] }))
    expect(v).toBeInstanceOf(Map)
    const m = v as Map<string, unknown>
    expect(m.get('a')).toBe(1)
    expect(Buffer.from(m.get('b') as Uint8Array).toString()).toBe('xy')
    expect(() => bdecode(new TextEncoder().encode('i1'))).toThrow(/unterminated/)
    expect(() => bdecode(new TextEncoder().encode('5:ab'))).toThrow(/length/)
    expect(() => bdecode(new TextEncoder().encode('i1ei2e'))).toThrow(/trailing/)
  })
})

describe('scrape', () => {
  it('derives the scrape URL as BEP 48 says', () => {
    expect(scrapeUrlFor('http://t.example:6969/announce')).toBe('http://t.example:6969/scrape')
    expect(scrapeUrlFor('http://t.example/x/announce.php?k=1')).toBe('http://t.example/x/scrape.php?k=1')
    expect(scrapeUrlFor('http://t.example/a')).toBeNull()
  })

  it('http: sends the raw infohash and reads the counts', async () => {
    let asked = ''
    const reply = Buffer.concat([
      Buffer.from('d5:filesd20:'),
      Buffer.from(raw(H)),
      Buffer.from('d8:completei2e10:downloadedi5e10:incompletei1eeee')
    ])
    const f = (async (u: string) => ((asked = u), new Response(reply))) as typeof fetch
    expect(await httpScrape('http://t.example:6969/announce', H, { fetch: f })).toEqual({ complete: 2, incomplete: 1, downloaded: 5 })
    expect(asked).toBe(`http://t.example:6969/scrape?info_hash=${Array.from(raw(H), (b) => `%${b.toString(16).padStart(2, '0')}`).join('')}`)
    const none = (async () => new Response('d5:filesdee')) as unknown as typeof fetch
    expect(await httpScrape('http://t.example/announce', H, { fetch: none })).toBeNull()
    const no = (async () => new Response('d14:failure reason13:not whiteliste')) as unknown as typeof fetch
    await expect(httpScrape('http://t.example/announce', H, { fetch: no })).rejects.toThrow(TrackerRefused)
  })

  let server: Socket | undefined
  afterEach(() => server?.close())

  /** A BEP 15 tracker on localhost that drops the first packet of each kind. */
  async function udpTracker(answer: 'ok' | 'error'): Promise<number> {
    server = createSocket('udp4')
    const s = server
    const dropped = new Set<number>()
    s.on('message', (m, rinfo) => {
      const action = m.readUInt32BE(8)
      if (!dropped.has(action)) return void dropped.add(action)
      const tx = m.readUInt32BE(12)
      if (action === 0) {
        expect(m.readBigUInt64BE(0)).toBe(0x41727101980n)
        const r = Buffer.alloc(16)
        r.writeUInt32BE(0, 0)
        r.writeUInt32BE(tx, 4)
        r.writeBigUInt64BE(0x1234n, 8)
        s.send(r, rinfo.port, rinfo.address)
      } else if (answer === 'error') {
        const r = Buffer.concat([Buffer.alloc(8), Buffer.from('Requested download is not authorized for use with this tracker.')])
        r.writeUInt32BE(3, 0)
        r.writeUInt32BE(tx, 4)
        s.send(r, rinfo.port, rinfo.address)
      } else {
        expect(m.readBigUInt64BE(0)).toBe(0x1234n)
        expect(Buffer.from(m.subarray(16, 36)).toString('hex')).toBe(H)
        const r = Buffer.alloc(20)
        r.writeUInt32BE(2, 0)
        r.writeUInt32BE(tx, 4)
        r.writeUInt32BE(3, 8) // seeders
        r.writeUInt32BE(7, 12) // completed
        r.writeUInt32BE(1, 16) // leechers
        s.send(r, rinfo.port, rinfo.address)
      }
    })
    await new Promise<void>((r) => s.bind(0, '127.0.0.1', r))
    return s.address().port
  }

  it('udp: connects, scrapes, and resends what UDP lost', async () => {
    const port = await udpTracker('ok')
    expect(await udpScrape(`udp://127.0.0.1:${port}/announce`, H, { timeoutMs: 8000 })).toEqual({ complete: 3, downloaded: 7, incomplete: 1 })
  }, 15_000)

  it('udp: a refusal is a refusal, and silence is "no answer"', async () => {
    const port = await udpTracker('error')
    await expect(udpScrape(`udp://127.0.0.1:${port}`, H, { timeoutMs: 8000 })).rejects.toThrow(/not authorized/)
    server!.close()
    server = createSocket('udp4')
    await new Promise<void>((r) => server!.bind(0, '127.0.0.1', r))
    await expect(udpScrape(`udp://127.0.0.1:${server.address().port}`, H, { timeoutMs: 500 })).rejects.toThrow(/no answer/)
  }, 20_000)
})
