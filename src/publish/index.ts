// Getting one letter onto BitTorrent, in two steps that can each be retried:
//
//   stage — put the bytes on the webseed, build the torrent (url-list → that
//           webseed), write <story>.torrent beside the .thing, hand it to every
//           seed box. The boxes download from the webseed as from a peer.
//   poll  — ask the boxes how far they got. The letter is READY to announce
//           once one has all of it, or — when none has finished within
//           seedTimeoutMs — once the webseed still answers. A pointer is only
//           honest if something is serving it.
import { readFileSync, writeFileSync } from 'node:fs'
import type { PublishConfig } from '../config.js'
import type { Secrets } from '../secrets.js'
import type { BoxRecord, PublishRecord } from '../state.js'
import { createTorrent, magnetFor, seedFileName } from '../torrent.js'
import { Deluge } from './seedbox/deluge.js'
import { Qbittorrent } from './seedbox/qbittorrent.js'
import { Rtorrent } from './seedbox/rtorrent.js'
import { Transmission } from './seedbox/transmission.js'
import { type FetchLike, type SeedBox, type WebSeedStore, PublishError } from './types.js'
import { DirWebSeed, S3WebSeed, SshWebSeed } from './webseed.js'

export interface Publisher {
  webseed: WebSeedStore
  boxes: SeedBox[]
  trackers: string[]
  seedTimeoutMs: number
}

export interface PublishLog {
  info(m: string): void
  warn(m: string): void
}

export function createPublisher(cfg: PublishConfig, secrets: Secrets, fetchImpl?: FetchLike): Publisher {
  const f = fetchImpl ? { fetch: fetchImpl } : {}
  const w = cfg.webseed
  let webseed: WebSeedStore
  if (w.kind === 'dir') webseed = new DirWebSeed({ dir: w.dir, baseUrl: w.baseUrl, ...f })
  else if (w.kind === 'ssh') webseed = new SshWebSeed({ host: w.host, dir: w.dir, baseUrl: w.baseUrl, ...(w.port ? { port: w.port } : {}), ...f })
  else {
    if (!secrets.webseed) throw new PublishError("the 's3' webseed needs webseed.accessKeyId/secretAccessKey in the secrets file")
    webseed = new S3WebSeed({ ...w, ...secrets.webseed, ...f })
  }
  const boxes = cfg.seedboxes.map((b): SeedBox => {
    // qBittorrent and Deluge always ask for a password. Without this check a
    // name that doesn't match its secrets entry logs in with '' and comes back
    // as "login refused", which reads like a wrong password.
    if ((b.kind === 'qbittorrent' || b.kind === 'deluge') && secrets.seedboxes[b.name]?.password === undefined) {
      const have = Object.keys(secrets.seedboxes)
      throw new PublishError(
        `seed box ${b.name} (${b.kind}) needs a password, but ${secrets.file ?? 'the secrets file'} has no seedboxes.${b.name}.password` +
          ` (it has ${have.length ? have.map((n) => JSON.stringify(n)).join(', ') : 'no seed box entries'})`
      )
    }
    const s = secrets.seedboxes[b.name] ?? {}
    const auth = { ...(s.username !== undefined ? { username: s.username } : {}), ...(s.password !== undefined ? { password: s.password } : {}) }
    const box = ((): SeedBox => {
      switch (b.kind) {
        case 'qbittorrent':
          return new Qbittorrent({ ...b, username: s.username ?? 'admin', password: s.password ?? '', ...f })
        case 'transmission':
          return new Transmission({ ...b, ...auth, ...f })
        case 'deluge':
          return new Deluge({ ...b, password: s.password ?? '', ...f })
        case 'rtorrent':
          return new Rtorrent({ ...b, ...auth, ...f })
      }
    })()
    // Transmission and rTorrent may run without a login, so a missing entry is
    // allowed — but if the box then asks for one, say why none was sent.
    return secrets.seedboxes[b.name] ? box : withAuthHint(box, `no seedboxes.${b.name} entry in ${secrets.file ?? 'the secrets file'}, so no login was sent`)
  })
  return { webseed, boxes, trackers: cfg.trackers, seedTimeoutMs: cfg.seedTimeoutMs }
}

/** Append `hint` to the errors of `box` that are an HTTP 401. */
export function withAuthHint(box: SeedBox, hint: string): SeedBox {
  const wrap = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p
    } catch (e) {
      if (e instanceof Error && /: HTTP 401\b/.test(e.message)) throw new PublishError(`${e.message} (${hint})`)
      throw e
    }
  }
  return {
    name: box.name,
    kind: box.kind,
    add: (m, h, o) => wrap(box.add(m, h, o)),
    progress: (h) => wrap(box.progress(h)),
    remove: (h) => wrap(box.remove(h))
  }
}

export interface StageInput {
  tar: Uint8Array
  envelopeHash: string
  type: string
  /** the .thing on disk; the .torrent is written beside it */
  outFile: string
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function addToBox(box: SeedBox, rec: PublishRecord, metainfo: Uint8Array, bytes: Uint8Array | undefined, now: Date, log: PublishLog): Promise<BoxRecord> {
  try {
    await box.add(metainfo, rec.infohash, { name: rec.name, bytes: bytes ?? new Uint8Array(0) })
    return { added: now.toISOString(), progress: 0 }
  } catch (e) {
    log.warn(`${box.name}: could not add ${rec.name}: ${errText(e)}`)
    return { error: errText(e) }
  }
}

export async function stage(p: Publisher, input: StageInput, now: Date, log: PublishLog): Promise<PublishRecord> {
  const name = seedFileName(input.type, input.envelopeHash)
  const webseedUrl = await p.webseed.put(name, input.tar)
  const t = createTorrent(input.tar, { name, trackers: p.trackers, webseeds: [webseedUrl], creationDate: Math.floor(now.getTime() / 1000) })
  const torrentFile = input.outFile.replace(/\.thing$/, '') + '.torrent'
  writeFileSync(torrentFile, t.metainfo)
  // The .torrent goes beside the bytes so a magnet can name it as `xs`.
  const torrentUrl = await p.webseed.put(`${name}.torrent`, t.metainfo)
  const rec: PublishRecord = {
    envelopeHash: input.envelopeHash,
    infohash: t.infohash,
    magnet: magnetFor(t, p.trackers, [webseedUrl], torrentUrl),
    name,
    length: t.length,
    torrentFile,
    webseedUrl,
    staged: now.toISOString(),
    boxes: {},
    announced: {}
  }
  for (const box of p.boxes) rec.boxes[box.name] = await addToBox(box, rec, t.metainfo, input.tar, now, log)
  log.info(`staged ${name} (${t.infohash}) on ${p.boxes.length} seed box${p.boxes.length === 1 ? '' : 'es'}`)
  return rec
}

export type Readiness = 'ready' | 'waiting'

/** Refresh `rec.boxes` in place and say whether the letter may be announced. */
export async function poll(p: Publisher, rec: PublishRecord, now: Date, log: PublishLog): Promise<Readiness> {
  let metainfo: Uint8Array | undefined
  for (const box of p.boxes) {
    const prev = rec.boxes[box.name] ?? {}
    if (!prev.added) {
      // Never got onto this box (it was down, or added to config later): retry.
      metainfo ??= new Uint8Array(readFileSync(rec.torrentFile))
      rec.boxes[box.name] = await addToBox(box, rec, metainfo, undefined, now, log)
      continue
    }
    try {
      const progress = await box.progress(rec.infohash)
      if (progress === null) {
        // The box lost it (removed by hand, client reset): add it again next poll.
        rec.boxes[box.name] = { error: 'not on the box any more' }
      } else rec.boxes[box.name] = { added: prev.added, progress }
    } catch (e) {
      rec.boxes[box.name] = { ...prev, error: errText(e) }
    }
  }
  if (Object.values(rec.boxes).some((b) => (b.progress ?? 0) >= 1)) return 'ready'
  const waited = now.getTime() - Date.parse(rec.staged)
  if (p.boxes.length === 0 || waited >= p.seedTimeoutMs) {
    if (rec.webseedUrl && (await p.webseed.check(rec.webseedUrl, rec.length))) {
      if (p.boxes.length) log.warn(`${rec.name}: no seed box finished in ${Math.round(waited / 1000)}s; announcing on the webseed alone`)
      return 'ready'
    }
  }
  return 'waiting'
}
