// Site and run configuration. A TypeScript module rather than JSON because
// per-site hooks are functions; `defineConfig` fills defaults and validates.
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ArticleMeta } from './ir.js'
import { KiB, MiB } from './util/bytes.js'
import { hostMatches, isHttpUrl } from './util/url.js'

export interface FetchOptions {
  headers?: Record<string, string>
  /** Reserved for a later Netscape cookies.txt loader. */
  cookieFile?: string
  /** Reserved for a later headless backend. */
  backend?: 'fetch'
}

export interface ImagePolicy {
  /** Only download images from these hosts (suffix match). */
  allowHosts?: string[]
  /** Skip candidate URLs matching any of these. */
  skipPatterns?: RegExp[]
  /** Skip images narrower than this when a width is known. */
  minWidth?: number
  maxImages?: number
  /** 'auto': insert the metadata lead image only if the body had none. */
  leadImage?: 'auto' | 'never' | 'always'
}

export interface Site {
  /** ^[a-z0-9][a-z0-9-]*$ — becomes the out/<id>/ directory. */
  id: string
  /** Authoritative publisher name; falls back to page metadata when absent. */
  publisher?: string
  /** Canonical URLs must be on one of these hosts (suffix match). */
  hosts: string[]
  feeds: string[]
  language?: string
  section?: string | ((doc: Document, url: URL) => string | undefined)
  /** CSS selector for the article body; bypasses Readability when it matches. */
  articleSelector?: string
  /** Junk to remove before extraction (promos, newsletter boxes, related links). */
  removeSelectors?: string[]
  /** Arbitrary DOM surgery before extraction. */
  prepare?: (doc: Document, url: URL) => void
  /** Override or post-process extracted metadata. */
  metadata?: Partial<ArticleMeta> | ((meta: ArticleMeta, doc: Document, url: URL) => ArticleMeta)
  imagePolicy?: ImagePolicy
  /** Return false to skip a discovered URL (live blogs, video pages, ...). */
  urlFilter?: (url: URL) => boolean
  /** Refetch the canonical URL once when it differs from the fetched page (AMP). Default true. */
  followCanonical?: boolean
  fetch?: FetchOptions
  /** Cap on new articles per run for this site. */
  maxPerRun?: number
  /** With `scrape: 'subscribed'`, scrape this site even when nobody has asked for it. */
  always?: boolean
}

export type WebSeedConfig =
  /** A directory some web server already serves at `baseUrl`. */
  | { kind: 'dir'; dir: string; baseUrl: string }
  /** The same, on another machine, written over ssh (key auth; `host` is user@host or a ~/.ssh/config alias). */
  | { kind: 'ssh'; host: string; dir: string; baseUrl: string; port?: number }
  /** An S3-compatible bucket. Credentials come from the secrets file. */
  | { kind: 's3'; endpoint: string; bucket: string; region: string; publicBaseUrl: string; prefix?: string }

/** A seed box's web API. Credentials come from the secrets file, under `name`. */
export type SeedBoxConfig =
  | { kind: 'qbittorrent'; name: string; url: string; savePath?: string; category?: string }
  | { kind: 'transmission'; name: string; url: string; downloadDir?: string }
  | { kind: 'deluge'; name: string; url: string; downloadLocation?: string }
  /** rTorrent cannot use webseeds: `directory` must be where the `dir` or `ssh` webseed writes, as rTorrent sees it. */
  | { kind: 'rtorrent'; name: string; url: string; directory: string }

export interface PublishConfig {
  /** Tracker announce URLs, in order. The shell adds none of its own, so these are what readers find peers with (plus DHT). */
  trackers: string[]
  webseed: WebSeedConfig
  seedboxes: SeedBoxConfig[]
  /** Announce once a box has the whole file; past this, announce on a reachable webseed alone. */
  seedTimeoutMs: number
  /** Only publish stories emitted within this many days — turning publishing on must not flood the relay with the archive. */
  backlogDays: number
}

export interface AboutConfig {
  /** Shown as the memo's From line. */
  name: string
  /** A paragraph about the bot, before the generated how-to. */
  description?: string
  /** Re-post the about memo when it is older than this, so new readers of the relay see it. */
  repostDays: number
}

export interface MediaConfig {
  concurrency: number
  maxImageBytes: number
  maxTotalBytes: number
  maxImages: number
  video: boolean
  maxVideoBytes: number
}

export interface LimitsConfig {
  /** Souspli's article.html MAX_BLOCKS. */
  maxBlocks: number
  /** Trim to this so articles stay editable in the shell (draft cap is 256 KiB). */
  targetArgsBytes: number
  /** Never emit above this. */
  hardArgsBytes: number
  /** Skip pages whose extracted body is shorter than this many characters. */
  minBodyChars: number
}

export interface Config {
  outDir: string
  stateFile: string
  identityFile: string
  userAgent: string
  perHostDelayMs: number
  timeoutMs: number
  maxHtmlBytes: number
  retries: number
  media: MediaConfig
  limits: LimitsConfig
  /** Publishing to BitTorrent; off when absent. */
  publish?: PublishConfig
  /** Relays to announce on and to read sealed subscribe letters from. */
  relays: string[]
  /** JSON file with seed box and webseed credentials (0600). */
  secretsFile: string
  about: AboutConfig
  /** 'subscribed': only scrape sites somebody has subscribed to (or marked `always`). */
  scrape: 'all' | 'subscribed'
  /** `serve`'s scrape interval. */
  serveEveryMs: number
  sites: Site[]
}

export type UserConfig = Partial<Omit<Config, 'sites' | 'media' | 'limits' | 'publish' | 'about'>> & {
  media?: Partial<MediaConfig>
  limits?: Partial<LimitsConfig>
  publish?: Partial<PublishConfig>
  about?: Partial<AboutConfig>
  sites: Site[]
}

export function xdgConfigHome(): string {
  const env = process.env['XDG_CONFIG_HOME']
  return env && env.trim() ? env : resolve(homedir(), '.config')
}

/** Expand a leading `~` and `$XDG_CONFIG_HOME`; resolve relative paths against cwd. */
export function expandPath(p: string, cwd: string = process.cwd()): string {
  let out = p
  if (out.startsWith('~/') || out === '~') out = resolve(homedir(), out.slice(2))
  out = out.replace(/^\$XDG_CONFIG_HOME(?=\/|$)/, xdgConfigHome())
  return isAbsolute(out) ? out : resolve(cwd, out)
}

export const DEFAULT_MEDIA: MediaConfig = {
  concurrency: 3,
  maxImageBytes: 8 * MiB,
  maxTotalBytes: 48 * MiB,
  maxImages: 40,
  video: false,
  maxVideoBytes: 24 * MiB
}

export const DEFAULT_LIMITS: LimitsConfig = {
  maxBlocks: 400,
  targetArgsBytes: 200 * KiB,
  hardArgsBytes: 256 * KiB,
  minBodyChars: 400
}

export const DEFAULTS: Omit<Config, 'sites'> = {
  outDir: 'out',
  stateFile: 'state/newsread.json',
  identityFile: '$XDG_CONFIG_HOME/newsread/identity.key',
  userAgent: 'newsread/0.1 (+personal archiver)',
  perHostDelayMs: 2000,
  timeoutMs: 20_000,
  maxHtmlBytes: 3 * MiB,
  retries: 1,
  media: DEFAULT_MEDIA,
  limits: DEFAULT_LIMITS,
  relays: [],
  secretsFile: '$XDG_CONFIG_HOME/newsread/secrets.json',
  about: { name: 'newsread', repostDays: 7 },
  scrape: 'all',
  serveEveryMs: 10 * 60_000
}

export const DEFAULT_SEED_TIMEOUT_MS = 10 * 60_000

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const SITE_ID = /^[a-z0-9][a-z0-9-]*$/

export function defineConfig(user: UserConfig): Config {
  if (!user || !Array.isArray(user.sites)) throw new ConfigError('config must have a `sites` array')
  const ids = new Set<string>()
  for (const s of user.sites) {
    if (!s || typeof s.id !== 'string' || !SITE_ID.test(s.id)) throw new ConfigError(`site id must match ${SITE_ID}: ${JSON.stringify(s?.id)}`)
    if (ids.has(s.id)) throw new ConfigError(`duplicate site id: ${s.id}`)
    ids.add(s.id)
    if (!Array.isArray(s.hosts) || s.hosts.length === 0) throw new ConfigError(`site ${s.id}: hosts must be a non-empty array`)
    if (!Array.isArray(s.feeds)) throw new ConfigError(`site ${s.id}: feeds must be an array`)
    for (const f of s.feeds) if (!isHttpUrl(f)) throw new ConfigError(`site ${s.id}: feed is not an http(s) URL: ${f}`)
  }
  for (const r of user.relays ?? []) if (!/^wss?:\/\/[^\s]+$/.test(r)) throw new ConfigError(`relay is not a ws(s) URL: ${r}`)
  if (user.scrape !== undefined && user.scrape !== 'all' && user.scrape !== 'subscribed') throw new ConfigError(`scrape must be 'all' or 'subscribed'`)
  const { sites, media, limits, publish, about, ...rest } = user
  return {
    ...DEFAULTS,
    ...stripUndefined(rest),
    media: { ...DEFAULT_MEDIA, ...stripUndefined(media ?? {}) },
    limits: { ...DEFAULT_LIMITS, ...stripUndefined(limits ?? {}) },
    about: { ...DEFAULTS.about, ...stripUndefined(about ?? {}) },
    ...(publish ? { publish: checkPublish(publish) } : {}),
    sites
  }
}

const BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function checkPublish(p: Partial<PublishConfig>): PublishConfig {
  const trackers = p.trackers ?? []
  for (const t of trackers) if (!/^(udp|https?|wss?):\/\/\S+$/.test(t)) throw new ConfigError(`publish: tracker is not a udp/http/ws URL: ${t}`)
  if (!trackers.length) throw new ConfigError('publish: at least one tracker is needed — the shell adds none of its own')
  const seedboxes = p.seedboxes ?? []
  const names = new Set<string>()
  for (const b of seedboxes) {
    if (!b || !['qbittorrent', 'transmission', 'deluge', 'rtorrent'].includes(b.kind)) throw new ConfigError(`publish: unknown seed box kind ${JSON.stringify((b as { kind?: unknown })?.kind)}`)
    if (!BOX_NAME.test(b.name ?? '')) throw new ConfigError(`publish: seed box name must match ${BOX_NAME}: ${JSON.stringify(b.name)}`)
    if (names.has(b.name)) throw new ConfigError(`publish: duplicate seed box name ${b.name}`)
    names.add(b.name)
    if (!isHttpUrl(b.url)) throw new ConfigError(`publish: seed box ${b.name}: url is not http(s)`)
    if (b.kind === 'rtorrent') {
      if (!b.directory) throw new ConfigError(`publish: seed box ${b.name}: rtorrent needs \`directory\``)
      if (p.webseed?.kind !== 'dir' && p.webseed?.kind !== 'ssh') throw new ConfigError(`publish: seed box ${b.name}: rtorrent cannot use webseeds, so it needs a 'dir' or 'ssh' webseed writing into its directory`)
    }
  }
  // The webseed is how the bytes reach the boxes at all (they fetch from it as
  // from a peer), and what keeps a pointer honest when no box has finished.
  const w = p.webseed
  if (!w) throw new ConfigError('publish: needs a webseed — it is how the seed boxes get the bytes')
  if (w.kind !== 'dir' && w.kind !== 'ssh' && w.kind !== 's3') throw new ConfigError(`publish: unknown webseed kind ${JSON.stringify((w as { kind?: unknown }).kind)}`)
  if (w.kind === 'dir' && (!w.dir || !isHttpUrl(w.baseUrl))) throw new ConfigError(`publish: webseed 'dir' needs dir and an http(s) baseUrl`)
  if (w.kind === 'ssh' && (!w.host || w.host.startsWith('-') || !w.dir?.startsWith('/') || !isHttpUrl(w.baseUrl))) {
    throw new ConfigError(`publish: webseed 'ssh' needs host, an absolute dir and an http(s) baseUrl`)
  }
  if (w.kind === 's3' && !(isHttpUrl(w.endpoint) && w.bucket && w.region && isHttpUrl(w.publicBaseUrl))) {
    throw new ConfigError(`publish: webseed 's3' needs endpoint, bucket, region and publicBaseUrl`)
  }
  return { trackers, seedboxes, seedTimeoutMs: p.seedTimeoutMs ?? DEFAULT_SEED_TIMEOUT_MS, backlogDays: p.backlogDays ?? 2, webseed: w }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

export async function loadConfig(path = 'newsread.config.ts'): Promise<Config> {
  const abs = expandPath(path)
  let mod: { default?: unknown }
  try {
    mod = (await import(pathToFileURL(abs).href)) as { default?: unknown }
  } catch (e) {
    throw new ConfigError(`cannot load config ${abs}: ${(e as Error).message}`)
  }
  if (!mod.default || typeof mod.default !== 'object') throw new ConfigError(`${abs} must default-export defineConfig({...})`)
  return defineConfig(mod.default as UserConfig)
}

/** The configured site whose hosts match this URL, if any. */
export function siteForUrl(config: Config, url: string | URL): Site | undefined {
  let host: string
  try {
    host = (typeof url === 'string' ? new URL(url) : url).hostname
  } catch {
    return undefined
  }
  return config.sites.find((s) => hostMatches(host, s.hosts))
}

/** A throwaway site for `fetch <url>` on an unconfigured host. */
export function genericSite(url: string | URL): Site {
  const u = typeof url === 'string' ? new URL(url) : url
  return { id: 'misc', hosts: [u.hostname], feeds: [] }
}
