import { describe, expect, it } from 'vitest'
import { checkSeedBox } from '../src/publish/check.js'
import type { Publisher } from '../src/publish/index.js'
import type { SeedBox, WebSeedStore } from '../src/publish/types.js'
import type { TrackerWhitelist } from '../src/publish/whitelist.js'
import type { ScrapeResult } from '../src/tracker.js'

function rig(steps: (number | null)[], webseedUp = true, seeders: number[] = [1]) {
  const stored = new Map<string, Uint8Array>()
  const webseed: WebSeedStore = {
    kind: 'mem',
    put: async (n, b) => (stored.set(n, b), `https://w/${n}`),
    check: async () => webseedUp,
    remove: async (n) => void stored.delete(n)
  }
  const added = new Set<string>()
  let i = 0
  const box: SeedBox = {
    name: 'b',
    kind: 'fake',
    add: async (_m, h) => void added.add(h),
    progress: async () => steps[Math.min(i++, steps.length - 1)]!,
    remove: async (h) => void added.delete(h)
  }
  let t = 0
  const lines: string[] = []
  const listed = new Set<string>()
  const order: string[] = []
  const whitelist: TrackerWhitelist = {
    kind: 'mem',
    add: async (h) => (order.push(`whitelist ${added.size}`), void listed.add(h)),
    remove: async (h) => void listed.delete(h)
  }
  let s = 0
  const scrape = async (_a: string, h: string): Promise<ScrapeResult | null> =>
    listed.has(h) ? { complete: seeders[Math.min(s++, seeders.length - 1)]!, incomplete: 0, downloaded: 0 } : null
  const p: Publisher = { webseed, whitelist, boxes: [box], trackers: ['udp://t:1'], seedTimeoutMs: 1 }
  const run = (keep = false) =>
    checkSeedBox(p, box, {
      bytes: 40_000, timeoutMs: 10_000, trackerTimeoutMs: 5000, intervalMs: 1000, keep, scrape,
      say: (l) => lines.push(l), sleep: async (ms) => void (t += ms), now: () => t
    })
  return { run, stored, added, lines, listed, order }
}

describe('seedbox-check', () => {
  it('passes at 100% and cleans up after itself', async () => {
    const r = rig([0, 0.5, 1])
    const res = await r.run()
    expect(res.ok).toBe(true)
    expect(res.completeMs).toBe(2000)
    expect(r.stored.size).toBe(0)
    expect(r.added.size).toBe(0)
    expect(r.lines).toContain('b: 50.0%')
    expect(r.order).toEqual(['whitelist 0']) // whitelisted before the box had it
    expect(r.lines).toContain('tracker udp://t:1: 1 seeder, 0 leechers')
    expect(r.listed.size).toBe(0)
  })

  it('fails when a tracker never lists the box as a seeder', async () => {
    const r = rig([1], true, [0])
    expect((await r.run()).ok).toBe(false)
    expect(r.lines).toContain('tracker udp://t:1: no seeders yet')
    expect(r.lines.join('\n')).toMatch(/b never showed up as a seeder — is the infohash whitelisted/)
    expect(r.listed.size).toBe(0)
  })

  it('waits for a slow announce', async () => {
    const r = rig([1], true, [0, 0, 2])
    expect((await r.run()).ok).toBe(true)
    expect(r.lines).toContain('tracker udp://t:1: 2 seeders, 0 leechers')
  })
  it('fails at 0% with a hint, and fails early when the webseed does not answer', async () => {
    const stuck = rig([0])
    expect((await stuck.run()).ok).toBe(false)
    expect(stuck.lines.join('\n')).toMatch(/still 0%: can the box itself reach the webseed/)
    const down = rig([1], false)
    expect((await down.run()).ok).toBe(false)
    expect(down.added.size).toBe(0)
    expect(down.stored.size).toBe(0)
  })
  it('--keep leaves both in place', async () => {
    const r = rig([1])
    const res = await r.run(true)
    expect(r.added.has(res.infohash)).toBe(true)
    expect([...r.stored.keys()].sort()).toEqual([res.name, `${res.name}.torrent`])
    expect(r.listed.has(res.infohash)).toBe(true)
  })
})
