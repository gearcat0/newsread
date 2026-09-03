// cage's article args, typed. Every scalar is a string; dates are YYYY-MM-DD.
import { encode, jsToCbor } from './cage.js'

export type TextKind = 'heading' | 'subheading' | 'paragraph' | 'footnote'
export type Placement = 'left' | 'right' | 'full'

export interface TextBlock {
  kind: TextKind
  text: string
}

export interface MediaBlock {
  kind: 'image' | 'video'
  name: string
  caption: string
  alt: string
  placement: Placement
}

export type Block = TextBlock | MediaBlock

export interface ArticleArgs {
  title?: string
  deck?: string
  byline?: string
  authors?: string[]
  publisher?: string
  section?: string
  location?: string
  published?: string
  updated?: string
  retrieved?: string
  sourceUrl?: string
  archiveUrl?: string
  language?: string
  rights?: string
  keywords?: string[]
  blocks: Block[]
}

/** Exact size of the canonical-CBOR encoding cage will store. */
export function encodedArgsBytes(args: ArticleArgs): number {
  return encode(jsToCbor(args)).length
}

export const isMediaBlock = (b: Block): b is MediaBlock => b.kind === 'image' || b.kind === 'video'
