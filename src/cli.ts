// newsread <command> — see USAGE. Exit codes: 0 ok, 1 something failed, 2 usage.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, ConfigError, expandPath, genericSite, loadConfig, siteForUrl } from './config.js'
import { createHttpClient } from './http.js'
import { loadOrCreateIdentity } from './identity.js'
import { StateStore } from './state.js'
import { programHashHex } from './cage.js'
import { type Inspection, inspectBundle } from './bundle.js'
import { ALLOWED_MIMES } from './sniff.js'
import { type Ctx, type Flags, type Logger, type Outcome, describe, processUrl, runSite } from './pipeline.js'
import { formatBytes, KiB } from './util/bytes.js'

const USAGE = `newsread — archive news articles as cage \`article\` things

usage:
  newsread init                              create newsread.config.ts, the signing key, out/ and state/
  newsread whoami                            print the author address articles are signed with
  newsread run [--site id] [--limit n] [--dry-run] [--refresh] [--debug]
                                             poll every configured feed and archive new stories
  newsread fetch <url> [--site id] [--dry-run] [--debug]
                                             archive one article now
  newsread inspect <file.thing> [--json]     admit a bundle and print what is inside
  newsread verify <dir>                      check every .thing under <dir> is a well-formed article

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

async function createContext(config: Config, flags: Flags): Promise<{ ctx: Ctx; address: string; created: boolean }> {
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
    now: () => new Date(),
    log: consoleLogger(flags.debug),
    flags
  }
  return { ctx, address: identity.address, created }
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
        json: { type: 'boolean' }
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
        console.log(`program: ${programHashHex()} (vendor/cage/samples/article.html)`)
        return 0
      }
      case 'whoami': {
        const config = await loadConfig(configPath)
        const { address } = await createContext(config, flags)
        console.log(address)
        return 0
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
