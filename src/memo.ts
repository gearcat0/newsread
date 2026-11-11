// The bot's two kinds of memo: its public about letter, and the sealed replies
// it sends a subscriber. Both use Souspli's own memo program, shipped
// byte-for-byte, so they render as ordinary memos.
import type { Config } from './config.js'
import type { Identity } from './identity.js'
import { admitBundle, buildBundle, buildSealedBundle, hash, jsToCbor, loadMemoProgram, NOSTR_ENC_SCHEME, parseBundle, toHex } from './souspli.js'
import { describeSites } from './subscribe.js'
import type { SiteChoice } from './state.js'
import { utf8 } from './util/bytes.js'

export interface MemoArgs {
  to: string
  from: string
  subject: string
  message: string
}

/** The text of the about memo. Its hash decides whether it needs re-posting. */
export function aboutArgs(config: Config): MemoArgs {
  const sites = config.sites.map((s) => `  • ${s.id}${s.publisher ? ` — ${s.publisher}` : ''}`).join('\n')
  const relays = config.relays.map((r) => `  ${r}`).join('\n')
  const message = [
    config.about.description,
    'This account publishes news articles as Souspli letters, as soon as they are fetched. Each one is announced on the relay below and served over BitTorrent.',
    `Sites:\n${sites || '  (none yet)'}`,
    [
      'To subscribe, write this account a PRIVATE memo — People → Write privately…, or New → Memo with this account in To — whose subject is one of:',
      '  subscribe all',
      `  subscribe ${config.sites
        .slice(0, 2)
        .map((s) => s.id)
        .join(' ') || '<site>'}`,
      '  unsubscribe all   (or: unsubscribe <site> …)',
      '  list              (what you are subscribed to)',
      'You will get a private memo back confirming it. Subscribing also tells this account which sites people want, so it fetches those.'
    ].join('\n'),
    `Relay:\n${relays || '  (none configured)'}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return { to: 'Readers', from: config.about.name, subject: `${config.about.name}: news as letters`, message }
}

export function memoContentHash(a: MemoArgs): string {
  return toHex(hash(utf8(JSON.stringify([a.to, a.from, a.subject, a.message]))))
}

export interface BuiltMemo {
  tar: Uint8Array
  envelopeHash: string
}

const enc = (id: Identity) => ({ e: NOSTR_ENC_SCHEME, ek: id.nostr.pub })

export async function buildAbout(
  id: Identity,
  args: MemoArgs,
  chain: { path: string; seq: number; prev?: string },
  created: number
): Promise<BuiltMemo> {
  const tar = await buildBundle(id.signer, {
    program: loadMemoProgram(),
    type: 'memo',
    args: jsToCbor({ ...args, enclosures: [] }),
    created,
    path: chain.path,
    seq: chain.seq,
    ...(chain.prev ? { prev: Uint8Array.from(Buffer.from(chain.prev, 'hex')) } : {}),
    enc: enc(id)
  })
  const r = admitBundle(parseBundle(tar))
  if (r.status !== 'valid') throw new Error(`about memo did not self-admit: ${r.status}`)
  return { tar, envelopeHash: toHex(r.envelopeHash) }
}

export interface ReplyInput {
  /** the subscriber's Author.ek (32 bytes) */
  recipient: Uint8Array
  /** their display name, if their memo said one */
  to: string
  from: string
  subject: string
  message: string
  created: number
}

/** A memo sealed to the subscriber and to the bot (so the bot could read its own copy). */
export async function buildReply(id: Identity, r: ReplyInput): Promise<Uint8Array> {
  return buildSealedBundle(id.signer, [r.recipient, id.nostr.pub], {
    program: loadMemoProgram(),
    type: 'memo',
    args: jsToCbor({ to: r.to, from: r.from, subject: r.subject, message: r.message, enclosures: [] }),
    created: r.created,
    enc: enc(id)
  })
}

export function replyText(
  config: Config,
  outcome: { action: 'subscribe' | 'unsubscribe' | 'list'; sites: SiteChoice | undefined; unknown: string[] }
): { subject: string; message: string } {
  const now = describeSites(outcome.sites)
  const lines: string[] = []
  if (outcome.action === 'list') lines.push(outcome.sites ? `You are subscribed to ${now}.` : 'You are not subscribed to anything.')
  else if (outcome.sites) lines.push(`Done. You are now subscribed to ${now}.`)
  else lines.push('Done. You are no longer subscribed to anything.')
  if (outcome.unknown.length) {
    lines.push(`Not a site here: ${outcome.unknown.join(', ')}. Sites: ${config.sites.map((s) => s.id).join(', ') || '(none)'}.`)
  }
  if (outcome.sites) {
    lines.push(
      `New articles are announced on ${config.relays.join(', ') || 'the relay'}. To have your app fetch them as they appear, open this account in People and choose Subscribe…; otherwise each one waits for you to press Fetch.`
    )
  }
  return { subject: outcome.action === 'list' ? 'Your subscription' : `Re: ${outcome.action}`, message: lines.join('\n\n') }
}
