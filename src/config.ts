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
  /** cage's article.html MAX_BLOCKS. */
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
  sites: Site[]
}

export type UserConfig = Partial<Omit<Config, 'sites' | 'media' | 'limits'>> & {
  media?: Partial<MediaConfig>
  limits?: Partial<LimitsConfig>
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
  limits: DEFAULT_LIMITS
}

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
  const { sites, media, limits, ...rest } = user
  return {
    ...DEFAULTS,
    ...stripUndefined(rest),
    media: { ...DEFAULT_MEDIA, ...stripUndefined(media ?? {}) },
    limits: { ...DEFAULT_LIMITS, ...stripUndefined(limits ?? {}) },
    sites
  }
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
