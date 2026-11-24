// `newsread seedbox-check <box>`: one throwaway file through the whole path a
// letter takes — webseed, tracker whitelist, torrent, seed box, 100%, and the
// box showing up as a seeder on each tracker — and nothing announced.
// Each step says what it was doing when it failed, which is the point: "stuck
// at 0%" and "login refused" have different fixes.
import { randomBytes } from 'node:crypto'
import { createTorrent } from '../torrent.js'
import { type ScrapeResult, scrape as realScrape } from '../tracker.js'
import type { Publisher } from './index.js'
import type { SeedBox } from './types.js'

export interface CheckOptions {
  bytes: number
  timeoutMs: number
  intervalMs?: number
  /** Leave the torrent on the box and the file on the webseed. */
  keep?: boolean
  /** How long, after 100%, to wait for each tracker to list the box as a seeder (default 90 s). */
  trackerTimeoutMs?: number
  /** Skip the tracker step. */
  noTrackers?: boolean
  say: (line: string) => void
  scrape?: (announce: string, infohash: string) => Promise<ScrapeResult | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface CheckResult {
  ok: boolean
  name: string
  infohash: string
  /** ms from add to 100%, when it got there */
  completeMs?: number
  progress: number | null
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function checkSeedBox(p: Publisher, box: SeedBox, o: CheckOptions): Promise<CheckResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const bytes = new Uint8Array(randomBytes(o.bytes))
  const name = `check-${Buffer.from(randomBytes(4)).toString('hex')}.thing`
  const say = o.say
  let infohash = ''
  let progress: number | null = null
  let added = false
  let whitelisted = false
  const stored: string[] = []
  const done = (ok: boolean, completeMs?: number): CheckResult => ({ ok, name, infohash, progress, ...(completeMs !== undefined ? { completeMs } : {}) })

  try {
    let url: string
    try {
      url = await p.webseed.put(name, bytes)
      stored.push(name)
    } catch (e) {
      say(`webseed: could not store ${name}: ${errText(e)}`)
      return done(false)
    }
    say(`webseed: stored ${o.bytes} bytes at ${url}`)
    if (!(await p.webseed.check(url, bytes.length))) {
      say(`webseed: ${url} does not answer 200 with ${bytes.length} bytes from here — the box will not get it either`)
      return done(false)
    }
    say('webseed: answers')

    const t = createTorrent(bytes, { name, trackers: p.trackers, webseeds: [url] })
    infohash = t.infohash
    try {
      await p.webseed.put(`${name}.torrent`, t.metainfo)
      stored.push(`${name}.torrent`)
    } catch (e) {
      say(`webseed: could not store the .torrent: ${errText(e)}`)
      return done(false)
    }

    if (p.whitelist) {
      try {
        await p.whitelist.add(t.infohash)
        whitelisted = true
      } catch (e) {
        say(`whitelist: could not add ${t.infohash}: ${errText(e)}`)
        return done(false)
      }
      say(`whitelist: added ${t.infohash} (${p.whitelist.kind})`)
    }

    const addedAt = now()
    try {
      await box.add(t.metainfo, t.infohash, { name, bytes })
      added = true
    } catch (e) {
      say(`${box.name}: add failed: ${errText(e)}`)
      return done(false)
    }
    say(`${box.name}: added ${t.infohash} (${t.length} bytes, ${Math.ceil(t.length / t.pieceLength)} × ${t.pieceLength}-byte pieces)`)

    let last: number | null | undefined
    while (now() - addedAt < o.timeoutMs) {
      try {
        progress = await box.progress(t.infohash)
      } catch (e) {
        say(`${box.name}: progress failed: ${errText(e)}`)
        return done(false)
      }
      if (progress !== last) say(`${box.name}: ${progress === null ? 'does not list the torrent' : `${(progress * 100).toFixed(1)}%`}`)
      last = progress
      if (progress !== null && progress >= 1) {
        const ms = now() - addedAt
        say(`${box.name}: complete in ${(ms / 1000).toFixed(1)}s`)
        if (o.noTrackers || !p.trackers.length) return done(true, ms)
        return done(await seenOnTrackers(p.trackers, box.name, t.infohash, { ...o, sleep, now }), ms)
      }
      await sleep(o.intervalMs ?? 2000)
    }
    say(
      `${box.name}: not complete after ${Math.round(o.timeoutMs / 1000)}s` +
        (progress === 0 ? ' — still 0%: can the box itself reach the webseed URL? is the torrent queued or stopped in the client?' : '')
    )
    return done(false)
  } finally {
    if (!o.keep) {
      if (whitelisted) await p.whitelist!.remove(infohash).catch((e) => say(`whitelist: could not remove ${infohash}: ${errText(e)}`))
      if (added) await box.remove(infohash).then(() => say(`${box.name}: removed`), (e) => say(`${box.name}: remove failed: ${errText(e)}`))
      if (p.webseed.remove) for (const n of stored) await p.webseed.remove(n).catch((e) => say(`webseed: could not delete ${n}: ${errText(e)}`))
    } else if (infohash) say(`kept: ${infohash} on ${box.name}, ${stored.join(' and ')} on the webseed`)
  }
}

/** Wait for every tracker to list at least one seeder — the box we just filled. */
async function seenOnTrackers(
  trackers: string[],
  boxName: string,
  infohash: string,
  o: CheckOptions & { sleep: (ms: number) => Promise<void>; now: () => number }
): Promise<boolean> {
  const scrape = o.scrape ?? ((a: string, h: string) => realScrape(a, h, { timeoutMs: 10_000 }))
  let allSeen = true
  for (const tr of trackers) {
    const until = o.now() + (o.trackerTimeoutMs ?? 90_000)
    let last = ''
    let seen = false
    for (;;) {
      let line: string
      try {
        const r = await scrape(tr, infohash)
        if (r && r.complete >= 1) {
          o.say(`tracker ${tr}: ${r.complete} seeder${r.complete === 1 ? '' : 's'}, ${r.incomplete} leecher${r.incomplete === 1 ? '' : 's'}`)
          seen = true
          break
        }
        line = r ? `tracker ${tr}: no seeders yet` : `tracker ${tr}: does not list it yet`
      } catch (e) {
        line = `tracker ${tr}: ${errText(e)}`
      }
      if (line !== last) o.say(line)
      last = line
      if (o.now() >= until) break
      await o.sleep(o.intervalMs ?? 2000)
    }
    if (!seen) {
      o.say(`tracker ${tr}: ${boxName} never showed up as a seeder — is the infohash whitelisted, and can the box reach the tracker?`)
      allSeen = false
    }
  }
  return allSeen
}
