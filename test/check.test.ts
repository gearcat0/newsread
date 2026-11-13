import { describe, expect, it } from 'vitest'
import { checkSeedBox } from '../src/publish/check.js'
import type { Publisher } from '../src/publish/index.js'
import type { SeedBox, WebSeedStore } from '../src/publish/types.js'

function rig(steps: (number | null)[], webseedUp = true) {
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
  const p: Publisher = { webseed, boxes: [box], trackers: ['udp://t:1'], seedTimeoutMs: 1 }
  const run = (keep = false) =>
    checkSeedBox(p, box, { bytes: 40_000, timeoutMs: 10_000, intervalMs: 1000, keep, say: (l) => lines.push(l), sleep: async (ms) => void (t += ms), now: () => t })
  return { run, stored, added, lines }
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
  })
})
