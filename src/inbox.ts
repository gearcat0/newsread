// Sealed letters to the bot: subscribe, unsubscribe, list.
//
// A sealed event names nobody — every reader of the relay gets every one and
// tries to open it. So does the bot: check the event, check the bytes hash to
// its `x`, admit with the bot's unsealer, and silently drop anything that is
// not for it. What IS for it goes through admission like any letter; nothing
// on the event is believed.
import type { Config } from './config.js'
import type { Identity } from './identity.js'
import { buildReply, replyText } from './memo.js'
import { admitBundle, buildSealedEvent, cborToJs, hash, NOSTR_ENC_SCHEME, parseBundle, parseThingEvent, SEALED_TYPE, toHex, type NostrEvent } from './souspli.js'
import type { StateStore } from './state.js'
import { applyRequest, parseRequest } from './subscribe.js'

/** A sealed request is always inline (≤ 32 KiB); refuse anything bigger before decoding. */
const MAX_SEALED_BYTES = 32 * 1024

export type InboxOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'not-for-me' }
  | { kind: 'seen' }
  | { kind: 'stale'; author: string }
  | { kind: 'not-a-request'; author: string }
  | { kind: 'handled'; author: string; action: string; reply: NostrEvent | null }

export interface InboxCtx {
  config: Config
  identity: Identity
  state: StateStore
  now: () => Date
}

const MAX_FUTURE_S = 3600

/** Read one relay event. Pure but for the state it updates; the caller posts `reply`. */
export async function handleInboxEvent(raw: unknown, ctx: InboxCtx): Promise<InboxOutcome> {
  const parsed = parseThingEvent(raw, MAX_SEALED_BYTES)
  if ('error' in parsed) return { kind: 'ignored', reason: parsed.error }
  if (parsed.type !== SEALED_TYPE) return { kind: 'ignored', reason: `type ${parsed.type}` }
  if (!parsed.bundle) return { kind: 'ignored', reason: 'a sealed letter must be inline' }
  if (toHex(hash(parsed.bundle)) !== parsed.envelopeHash) return { kind: 'ignored', reason: 'bytes do not hash to x' }

  let r
  try {
    r = admitBundle(parseBundle(parsed.bundle), { unsealer: ctx.identity.unsealer })
  } catch (e) {
    return { kind: 'ignored', reason: `unreadable bundle: ${(e as Error).message}` }
  }
  if (r.status === 'not-for-me') return { kind: 'not-for-me' }
  if (r.status !== 'valid') return { kind: 'ignored', reason: r.status === 'invalid' ? r.reason : `unverifiable (${r.scheme})` }
  // A PUBLIC letter admits without the unsealer. Anyone holding one could post
  // it here dressed as sealed, so a request must really have been sealed —
  // i.e. written to us, not merely by its author.
  if (!r.sealed) return { kind: 'ignored', reason: 'not sealed' }

  const envelopeHash = toHex(r.envelopeHash)
  if (ctx.state.hasSeen(envelopeHash)) return { kind: 'seen' }
  const author = toHex(r.envelope.author.k)
  // Our own replies are sealed to us too; never answer ourselves.
  if (author === ctx.identity.addressHex) {
    ctx.state.markSeen(envelopeHash)
    return { kind: 'ignored', reason: 'our own letter' }
  }
  const args = cborToJs(r.manifest.args) as { to?: unknown; from?: unknown; subject?: unknown; message?: unknown } | null
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  // The type is a hint and the program hash differs across shell versions, so
  // recognise a memo by its shape: subject/message strings.
  const req = r.manifest.type === 'memo' && args && typeof args === 'object' ? parseRequest(str(args.subject), str(args.message)) : null
  ctx.state.markSeen(envelopeHash)
  if (!req) return { kind: 'not-a-request', author }

  const nowS = Math.floor(ctx.now().getTime() / 1000)
  // `created` is the author's claim. Clamp the future so a skewed clock cannot
  // freeze a subscription against the author's own later letters.
  const created = Math.min(r.envelope.created, nowS + MAX_FUTURE_S)
  const current = ctx.state.data.subscribers[author]
  if (current && created <= current.updated) return { kind: 'stale', author }

  const ek = r.envelope.author.e === NOSTR_ENC_SCHEME && r.envelope.author.ek?.length === 32 ? r.envelope.author.ek : undefined
  const known = ctx.config.sites.map((s) => s.id)
  let sites = current?.sites
  let unknown: string[] = []
  if (req.action !== 'list') {
    const applied = applyRequest(current, req, known, { ek: ek ? toHex(ek) : (current?.ek ?? ''), created, envelopeHash })
    unknown = applied.unknown
    sites = applied.next?.sites
    if (applied.next) ctx.state.data.subscribers[author] = applied.next
    else delete ctx.state.data.subscribers[author]
  }

  // No bound key, no way to answer privately: the change still stands.
  let reply: NostrEvent | null = null
  if (ek) {
    const text = replyText(ctx.config, { action: req.action, sites, unknown })
    const tar = await buildReply(ctx.identity, {
      recipient: ek,
      to: str(args?.from) ?? '',
      from: ctx.config.about.name,
      ...text,
      created: nowS
    })
    reply = await buildSealedEvent(tar, nowS)
  }
  return { kind: 'handled', author, action: req.action, reply }
}
