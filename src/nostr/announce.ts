// The kind-3400 events the bot posts. See Souspli's docs/how/protocol/relay-event.md.
//
// Every article is a POINTER: the article program alone is over the 32 KiB
// inline cap, so the event carries the envelope hash and a magnet, not bytes.
// It is signed by the bot's own Nostr key — the one every article binds as
// Author.ek — so a reader can tell "posted by the author" from "relayed by
// someone", and a subscribed shell can trust the pointer enough to fetch it.
//
// `thing-feed` is ours (provisional, like every thing-* tag): the site id, so a
// subscription can choose which sites to fetch without opening anything.
import { MAX_INLINE_BUNDLE, TAG, THING_KIND, type NostrEvent } from '../souspli.js'
import type { NostrIdentity } from '../identity.js'

export const FEED_TAG = 'thing-feed'

export interface PointerInput {
  envelopeHash: string
  type: string
  feed: string
  locator: string
  createdAt: number
}

export function pointerEvent(id: NostrIdentity, p: PointerInput): Promise<NostrEvent> {
  return id.signEvent({
    kind: THING_KIND,
    created_at: p.createdAt,
    content: '',
    tags: [
      [TAG.topic, 'thing'],
      [TAG.hash, p.envelopeHash],
      [TAG.type, p.type],
      [FEED_TAG, p.feed],
      [TAG.fetch, p.locator]
    ]
  })
}

/** A small public letter (the about memo) travels whole. */
export async function inlineEvent(id: NostrIdentity, bundle: Uint8Array, envelopeHash: string, type: string, createdAt: number): Promise<NostrEvent> {
  if (bundle.length > MAX_INLINE_BUNDLE) throw new Error(`${type} is ${bundle.length} bytes, over the ${MAX_INLINE_BUNDLE}-byte inline cap`)
  return id.signEvent({
    kind: THING_KIND,
    created_at: createdAt,
    content: Buffer.from(bundle.buffer, bundle.byteOffset, bundle.byteLength).toString('base64'),
    tags: [
      [TAG.topic, 'thing'],
      [TAG.hash, envelopeHash],
      [TAG.type, type]
    ]
  })
}
