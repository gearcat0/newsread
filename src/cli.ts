// newsread <command> — see USAGE. Exit codes: 0 ok, 1 something failed, 2 usage.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, ConfigError, expandPath, genericSite, loadConfig, siteForUrl } from './config.js'
import { createHttpClient } from './http.js'
import { type Identity, loadOrCreateIdentity } from './identity.js'
import { StateStore } from './state.js'
import { Bot } from './bot.js'
import { RelayClient } from './nostr/relay.js'
import { checkSeedBox } from './publish/check.js'
import { createPublisher } from './publish/index.js'
import { PublishError } from './publish/types.js'
import { loadSecrets, SecretsError } from './secrets.js'
import { describeSites } from './subscribe.js'
import { programHashHex, THING_KIND } from './souspli.js'
import { type Inspection, inspectBundle } from './bundle.js'
import { ALLOWED_MIMES } from './sniff.js'
import { type Ctx, type Flags, type Logger, type Outcome, describe, processUrl, runSite } from './pipeline.js'
import { formatBytes, KiB } from './util/bytes.js'

const USAGE = `newsread — archive news articles as Souspli \`article\` things

usage:
  newsread init                              create newsread.config.ts, the signing key, out/ and state/
  newsread whoami                            print the author address articles are signed with
  newsread run [--site id] [--limit n] [--dry-run] [--refresh] [--debug]
                                             poll every configured feed and archive new stories
  newsread fetch <url> [--site id] [--dry-run] [--debug]
                                             archive one article now
  newsread inspect <file.thing> [--json]     admit a bundle and print what is inside
  newsread verify <dir>                      check every .thing under <dir> is a well-formed article

publishing (needs \`publish\` and \`relays\` in the config):
  newsread serve [--every 10m] [--site id]   run forever: scrape, publish to the seed boxes, announce on
                                             the relays, keep the about memo current, answer subscribers
  newsread publish                           one pass: stage, poll the seed boxes, announce what is ready
  newsread inbox                             read sealed letters to this account once, answer them
  newsread subscribers                       who is subscribed to what
  newsread relays                            check each relay answers; print the key to trust there
  newsread seedbox-check <box> [--timeout 3m] [--size 300k] [--keep]
                                             push a throwaway file through the webseed to one seed
                                             box and wait for 100% (nothing is announced)

global options:
  --config <path>    config module (default: newsread.config.ts)
  -h, --help
`

const CONFIG_SKELETON = `import { defineConfig } from './src/config.js'

// Sites you read. Everything except id/hosts/feeds is optional — see src/config.ts.
export default defineConfig({
  // outDir: 'out',
  // perHostDelayMs: 2000,
  sites: [
    // {
    //   id: 'example',
    //   publisher: 'The Example Times',
    //   hosts: ['example.com'],
    //   feeds: ['https://example.com/feed.xml'],
    //   removeSelectors: ['.newsletter-signup', '.related-stories'],
    //   urlFilter: (u) => !u.pathname.startsWith('/live/'),
    // },
  ]
})
`

function consoleLogger(debug: boolean): Logger {
  return {
    info: (m) => console.error(m),
    warn: (m) => console.error(`warn: ${m}`),
    debug: (m) => {
      if (debug) console.error(`debug: ${m}`)
    }
  }
}

async function createContext(config: Config, flags: Flags): Promise<{ ctx: Ctx; address: string; created: boolean; identity: Identity }> {
  const { identity, created } = loadOrCreateIdentity(expandPath(config.identityFile))
  const ctx: Ctx = {
    config,
    http: createHttpClient({
      userAgent: config.userAgent,
      perHostDelayMs: config.perHostDelayMs,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      defaultMaxBytes: config.maxHtmlBytes
    }),
    state: StateStore.load(expandPath(config.stateFile)),
    signer: identity.signer,
    ek: identity.nostr.pub,
    now: () => new Date(),
    log: consoleLogger(flags.debug),
    flags
  }
  return { ctx, address: identity.address, created, identity }
}

function createBot(ctx: Ctx, identity: Identity): Bot {
  const cfg = ctx.config
  const publisher = cfg.publish ? createPublisher(cfg.publish, loadSecrets(expandPath(cfg.secretsFile))) : undefined
  return new Bot({ config: cfg, identity, state: ctx.state, log: ctx.log, ...(publisher ? { publisher } : {}) })
}

/** `10m`, `90s`, `1h`, or plain milliseconds. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2] ?? 'ms'
  return Math.round(n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1))
}

function needRelays(config: Config): boolean {
  if (config.relays.length) return true
  console.error('no relays configured — add `relays: [\'wss://…\']` to the config')
  return false
}

/** Run until SIGINT/SIGTERM. Scrape ticks and publish polls never overlap themselves. */
async function serve(ctx: Ctx, bot: Bot, everyMs: number, onlySite: string | undefined): Promise<number> {
  const log = ctx.log
  let stopping = false
  let wake: (() => void) | undefined
  const stop = (): void => {
    if (stopping) return
    stopping = true
    log.info('stopping…')
    wake?.()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const nap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })

  await bot.postAbout().catch((e: Error) => log.warn(`about memo: ${e.message}`))
  bot.listen()
  // Seed boxes finish downloading in seconds to minutes; poll them far more
  // often than we scrape so an article is announced as soon as it is served.
  const pollMs = 30_000
  const poller = setInterval(() => {
    bot.publishPending().catch((e: Error) => log.warn(`publish: ${e.message}`))
  }, pollMs)
  poller.unref()
  let lastAbout = Date.now()
  while (!stopping) {
    const sites = bot.sitesToScrape().filter((s) => !onlySite || s.id === onlySite)
    if (!sites.length) log.info('nothing to scrape (no subscribers yet, and no site is marked always)')
    for (const site of sites) {
      if (stopping) break
      try {
        await runSite(site, ctx)
      } catch (e) {
        log.warn(`[${site.id}] ${(e as Error).message}`)
      }
      await bot.publishPending().catch((e: Error) => log.warn(`publish: ${e.message}`))
    }
    if (Date.now() - lastAbout > 3_600_000) {
      lastAbout = Date.now()
      await bot.postAbout().catch((e: Error) => log.warn(`about memo: ${e.message}`))
    }
    if (!stopping) await nap(everyMs)
  }
  clearInterval(poller)
  bot.close()
  ctx.state.save()
  return 0
}

export interface VerifyResult {
  file: string
  ok: boolean
  problems: string[]
  inspection: Inspection
}

export function verifyFile(file: string): VerifyResult {
  const insp = inspectBundle(new Uint8Array(readFileSync(file)))
  const problems: string[] = []
  if (insp.status !== 'valid') problems.push(`admission: ${insp.status}${insp.reason ? ` (${insp.reason})` : ''}`)
  else {
    if (insp.type !== 'article') problems.push(`type is ${JSON.stringify(insp.type)}, not "article"`)
    if (!insp.programMatches) problems.push(`program hash ${insp.programHash} is not the vendored article.html (${programHashHex()})`)
    for (const a of insp.attachments) {
      if (!/^(img|vid)-\d+$/.test(a.name)) problems.push(`attachment name ${JSON.stringify(a.name)} is not img-N / vid-N`)
      if (!ALLOWED_MIMES.has(a.mime)) problems.push(`attachment ${a.name} has MIME ${a.mime}`)
    }
    if ((insp.argsBytes ?? 0) > 256 * KiB) problems.push(`args are ${formatBytes(insp.argsBytes ?? 0)}, above the 256 KiB draft cap`)
    const args = insp.args as { blocks?: unknown } | undefined
    if (!args || typeof args !== 'object' || !Array.isArray(args.blocks)) problems.push('args.blocks is not an array')
    const names = new Set(insp.attachments.map((a) => a.name))
    for (const b of (args?.blocks as { kind?: string; name?: string }[] | undefined) ?? []) {
      if ((b.kind === 'image' || b.kind === 'video') && b.name && !names.has(b.name)) problems.push(`block references missing attachment ${b.name}`)
    }
  }
  return { file, ok: problems.length === 0, problems, inspection: insp }
}

export function listThings(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && p.endsWith('.thing')) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

export function verifyDirectory(dir: string): VerifyResult[] {
  return listThings(dir).map(verifyFile)
}

function printInspection(i: Inspection, file: string): void {
  console.log(`${file}`)
  console.log(`  status:     ${i.status}${i.reason ? ` — ${i.reason}` : ''}`)
  if (i.status !== 'valid') return
  console.log(`  author:     ${i.author!.display} (${i.author!.scheme})`)
  console.log(`  created:    ${new Date((i.created ?? 0) * 1000).toISOString()}`)
  console.log(`  envelope:   ${i.envelopeHash}`)
  if (i.chain?.path) console.log(`  chain:      ${i.chain.path} seq=${i.chain.seq ?? '?'}${i.chain.prev ? ` prev=${i.chain.prev.slice(0, 16)}…` : ''}`)
  console.log(`  type:       ${i.type}`)
  console.log(`  program:    ${i.programHash} ${i.programMatches ? '(matches vendored article.html)' : '(DOES NOT match vendored article.html)'}`)
  console.log(`  args:       ${formatBytes(i.argsBytes ?? 0)}`)
  if (i.attachments.length) {
    console.log('  attachments:')
    for (const a of i.attachments) console.log(`    ${a.name.padEnd(8)} ${a.mime.padEnd(12)} ${formatBytes(a.size).padStart(10)}  ${a.sha256.slice(0, 16)}…`)
  }
  const args = i.args as Record<string, unknown> | null
  if (args && typeof args === 'object') {
    for (const k of ['title', 'deck', 'authors', 'publisher', 'section', 'location', 'published', 'updated', 'retrieved', 'sourceUrl', 'language', 'rights', 'keywords']) {
      if (args[k] !== undefined) console.log(`  ${(k + ':').padEnd(12)}${Array.isArray(args[k]) ? (args[k] as string[]).join(', ') : String(args[k])}`)
    }
    const blocks = (args['blocks'] as { kind: string; text?: string; name?: string; caption?: string }[] | undefined) ?? []
    console.log(`  blocks (${blocks.length}):`)
    for (const b of blocks) {
      const body = b.text ?? `${b.name ?? ''}${b.caption ? ` — ${b.caption}` : ''}`
      console.log(`    ${b.kind.padEnd(10)} ${body.length > 90 ? body.slice(0, 89) + '…' : body}`)
    }
  }
}

function summarize(outcomes: Outcome[]): string {
  const n = (k: Outcome['kind']): number => outcomes.filter((o) => o.kind === k).length
  return `${n('emitted')} emitted, ${n('unchanged')} unchanged, ${n('skipped')} skipped, ${n('failed')} failed`
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        site: { type: 'string' },
        limit: { type: 'string' },
        'dry-run': { type: 'boolean' },
        refresh: { type: 'boolean' },
        debug: { type: 'boolean' },
        json: { type: 'boolean' },
        every: { type: 'string' },
        timeout: { type: 'string' },
        size: { type: 'string' },
        keep: { type: 'boolean' }
      }
    })
  } catch (e) {
    console.error((e as Error).message)
    console.error(USAGE)
    return 2
  }
  const { values, positionals } = parsed
  const [cmd, ...rest] = positionals
  if (values.help || !cmd) {
    console.log(USAGE)
    return values.help ? 0 : 2
  }
  const configPath = values.config ?? 'newsread.config.ts'
  const flags: Flags = { dryRun: !!values['dry-run'], debug: !!values.debug, refresh: !!values.refresh }

  try {
    switch (cmd) {
      case 'init': {
        const abs = resolve(configPath)
        if (existsSync(abs)) console.error(`config exists: ${abs}`)
        else {
          writeFileSync(abs, CONFIG_SKELETON)
          console.error(`wrote ${abs} — add your sites to it`)
        }
        const config = await loadConfig(abs)
        const { address, created } = await createContext(config, flags)
        mkdirSync(expandPath(config.outDir), { recursive: true })
        console.error(`${created ? 'created' : 'using'} identity ${expandPath(config.identityFile)}`)
        console.log(`author:  ${address}`)
        console.log(`program: ${programHashHex()} (vendor/souspli/samples/article.html)`)
        return 0
      }
      case 'whoami': {
        const config = await loadConfig(configPath)
        const { address, identity } = await createContext(config, flags)
        console.log(address)
        console.log(`nostr ${identity.nostr.pubHex}`)
        return 0
      }
      case 'serve': {
        const config = await loadConfig(configPath)
        if (!needRelays(config)) return 2
        if (!config.publish) console.error('warn: no `publish` config — articles will be archived but not announced')
        const everyMs = values.every !== undefined ? parseDuration(values.every) : config.serveEveryMs
        if (everyMs === undefined || everyMs < 1000) {
          console.error(`--every: not a duration: ${values.every}`)
          return 2
        }
        const { ctx, identity } = await createContext(config, flags)
        if (values.site && !config.sites.some((s) => s.id === values.site)) {
          console.error(`no site with id ${JSON.stringify(values.site)}`)
          return 2
        }
        console.error(`serving as ${identity.address} (nostr ${identity.nostr.pubHex}) on ${config.relays.join(', ')}`)
        return await serve(ctx, createBot(ctx, identity), everyMs, values.site)
      }
      case 'publish': {
        const config = await loadConfig(configPath)
        if (!needRelays(config)) return 2
        if (!config.publish) {
          console.error('no `publish` config — see the README')
          return 2
        }
        const { ctx, identity } = await createContext(config, flags)
        const bot = createBot(ctx, identity)
        try {
          const n = await bot.publishPending()
          const left = ctx.state.pendingPublish(config.relays).length
          console.error(`${n} announced; ${left} still pending (run again, or use serve)`)
        } finally {
          bot.close()
        }
        return 0
      }
      case 'inbox': {
        const config = await loadConfig(configPath)
        if (!needRelays(config)) return 2
        const { ctx, identity } = await createContext(config, flags)
        const bot = createBot(ctx, identity)
        try {
          const outs = await bot.readInboxOnce()
          const handled = outs.filter((o) => o.kind === 'handled')
          for (const o of handled) if (o.kind === 'handled') console.log(`${o.action.padEnd(12)} ${o.author}`)
          console.error(`${outs.length} event${outs.length === 1 ? '' : 's'} read, ${handled.length} request${handled.length === 1 ? '' : 's'} answered`)
        } finally {
          bot.close()
        }
        return 0
      }
      case 'subscribers': {
        const config = await loadConfig(configPath)
        const state = StateStore.load(expandPath(config.stateFile))
        const subs = Object.entries(state.data.subscribers)
        if (values.json) console.log(JSON.stringify(state.data.subscribers, null, 2))
        else for (const [k, s] of subs) console.log(`0x${k}  ${describeSites(s.sites)}  (since ${new Date(s.updated * 1000).toISOString()})`)
        console.error(`${subs.length} subscriber${subs.length === 1 ? '' : 's'}`)
        return 0
      }
      case 'relays': {
        const config = await loadConfig(configPath)
        if (!needRelays(config)) return 2
        const { identity } = await createContext(config, flags)
        let bad = 0
        for (const url of config.relays) {
          const r = new RelayClient(url, { connectTimeoutMs: 10_000 })
          let mine = 0
          const res = await r.fetchStored([{ kinds: [THING_KIND], authors: [identity.nostr.pubHex], limit: 5 }], () => void mine++, 15_000)
          r.close()
          if (res === 'eose') console.log(`ok    ${url}  (${mine ? `has posts from this account` : 'nothing from this account yet'})`)
          else {
            bad++
            console.log(`FAIL  ${url}  (no answer)`)
          }
        }
        console.error(`this account's relay key: ${identity.nostr.pubHex}`)
        console.error('on a relay from souspli/relay, add it to TRUSTED_PUBKEYS so a burst of articles is never rate-limited')
        return bad ? 1 : 0
      }
      case 'seedbox-check': {
        const config = await loadConfig(configPath)
        if (!config.publish) {
          console.error('no `publish` config — see the README')
          return 2
        }
        const want = rest[0]
        const publisher = createPublisher(config.publish, loadSecrets(expandPath(config.secretsFile)))
        const box = publisher.boxes.find((b) => b.name === want)
        if (!box) {
          console.error(`no seed box ${JSON.stringify(want ?? '')} — configured: ${publisher.boxes.map((b) => b.name).join(', ') || 'none'}`)
          return 2
        }
        const timeoutMs = parseDuration(values.timeout ?? '3m')
        const size = /^(\d+)(k|m)?$/i.exec(values.size ?? '300k')
        if (timeoutMs === undefined || !size) {
          console.error('bad --timeout or --size')
          return 2
        }
        const bytes = Number(size[1]) * (size[2]?.toLowerCase() === 'm' ? 1 << 20 : size[2] ? 1024 : 1)
        if (bytes < 1 || bytes > 64 << 20) {
          console.error('--size must be between 1 byte and 64m')
          return 2
        }
        const r = await checkSeedBox(publisher, box, { bytes, timeoutMs, keep: !!values.keep, say: (l) => console.log(l) })
        console.log(r.ok ? `ok    ${box.name} (${box.kind})` : `FAIL  ${box.name} (${box.kind})`)
        return r.ok ? 0 : 1
      }
      case 'run': {
        const config = await loadConfig(configPath)
        const { ctx } = await createContext(config, flags)
        const sites = values.site ? config.sites.filter((s) => s.id === values.site) : config.sites
        if (values.site && !sites.length) {
          console.error(`no site with id ${JSON.stringify(values.site)}; known: ${config.sites.map((s) => s.id).join(', ') || '(none)'}`)
          return 2
        }
        if (!sites.length) {
          console.error('no sites configured — edit newsread.config.ts')
          return 2
        }
        const limit = values.limit !== undefined ? Number(values.limit) : undefined
        const all: Outcome[] = []
        for (const site of sites) all.push(...(await runSite(site, ctx, limit !== undefined && Number.isFinite(limit) ? { limit } : {})))
        for (const o of all) if (o.kind === 'emitted') for (const w of o.warnings) ctx.log.debug(`  ${w}`)
        console.error(summarize(all))
        return all.some((o) => o.kind === 'failed') ? 1 : 0
      }
      case 'fetch': {
        const url = rest[0]
        if (!url) {
          console.error('fetch: missing <url>')
          return 2
        }
        const config = await loadConfig(configPath)
        const { ctx } = await createContext(config, flags)
        const site = (values.site ? config.sites.find((s) => s.id === values.site) : undefined) ?? siteForUrl(config, url) ?? genericSite(url)
        if (values.site && site.id !== values.site) {
          console.error(`no site with id ${JSON.stringify(values.site)}`)
          return 2
        }
        const o = await processUrl(url, site, ctx)
        console.error(`[${site.id}] ${describe(o)}`)
        if (o.kind === 'emitted') for (const w of o.warnings) console.error(`  warning: ${w}`)
        return o.kind === 'failed' ? 1 : 0
      }
      case 'inspect': {
        const file = rest[0]
        if (!file) {
          console.error('inspect: missing <file.thing>')
          return 2
        }
        const insp = inspectBundle(new Uint8Array(readFileSync(file)))
        if (values.json) console.log(JSON.stringify(insp, null, 2))
        else printInspection(insp, file)
        return insp.status === 'valid' ? 0 : 1
      }
      case 'verify': {
        const dir = rest[0]
        if (!dir) {
          console.error('verify: missing <dir>')
          return 2
        }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          console.error(`verify: not a directory: ${dir}`)
          return 2
        }
        const results = verifyDirectory(dir)
        let bad = 0
        for (const r of results) {
          if (r.ok) console.log(`ok    ${r.file}`)
          else {
            bad++
            console.log(`FAIL  ${r.file}`)
            for (const p of r.problems) console.log(`        ${p}`)
          }
        }
        console.error(`${results.length} file${results.length === 1 ? '' : 's'}, ${bad} failed`)
        return bad ? 1 : 0
      }
      default:
        console.error(`unknown command: ${cmd}`)
        console.error(USAGE)
        return 2
    }
  } catch (e) {
    if (e instanceof ConfigError) console.error(`config: ${e.message}`)
    // Setup problems the message already explains; a stack would only bury it.
    else if (e instanceof PublishError || e instanceof SecretsError) console.error(`error: ${e.message}`)
    else console.error(`error: ${(e as Error).stack ?? (e as Error).message}`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && /(^|[\\/])cli\.(ts|js|mts|mjs)$/.test(process.argv[1])
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e)
      process.exit(1)
    }
  )
}
