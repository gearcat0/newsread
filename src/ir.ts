// Intermediate representation of an extracted article. Deliberately richer than
// cage's article args: inline links, emphasis, lists, quotes, tables and code
// all survive here. Only `flatten.ts` reduces this to cage blocks, so when cage
// gains inline links, that is the one module to change.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'em' | 'strong' | 'code' | 'sub' | 'sup'; children: Inline[] }
  | { kind: 'br' }

export interface ImageCandidate {
  url: string
  width?: number
  density?: number
}

export interface IrImage {
  candidates: ImageCandidate[]
  alt: string
  caption: Inline[]
  credit?: string
  width?: number
  height?: number
}

export type IrBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: IrBlock[][] }
  | { kind: 'blockquote'; children: IrBlock[]; cite?: string }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'table'; caption?: Inline[]; rows: { header: boolean; cells: Inline[][] }[] }
  | { kind: 'figure'; image: IrImage }
  | { kind: 'video'; sources: { url: string; mime?: string }[]; poster?: IrImage; caption: Inline[] }
  | { kind: 'embed'; url: string; caption: Inline[] }
  | { kind: 'hr' }

export interface ArticleMeta {
  title?: string
  deck?: string
  authors: string[]
  publisher?: string
  section?: string
  location?: string
  /** YYYY-MM-DD */
  published?: string
  /** YYYY-MM-DD */
  updated?: string
  language?: string
  rights?: string
  keywords: string[]
  /** Normalised canonical URL — the story's identity. */
  canonicalUrl: string
  /** The URL actually fetched (after redirects). */
  fetchedUrl: string
  leadImage?: IrImage
}

export interface IrDocument {
  meta: ArticleMeta
  blocks: IrBlock[]
  warnings: string[]
}

export const text = (t: string): Inline => ({ kind: 'text', text: t })

/** Plain text of inline runs with links reduced to their children. This is the
 *  seam that drops hrefs today; a link-aware emitter replaces its callers later. */
export function inlineText(inlines: readonly Inline[]): string {
  let out = ''
  for (const i of inlines) {
    switch (i.kind) {
      case 'text':
        out += i.text
        break
      case 'br':
        out += ' '
        break
      default:
        out += inlineText(i.children)
    }
  }
  return out
}

/** Every link in a run of inlines, in order (used by tests and future emitters). */
export function collectLinks(inlines: readonly Inline[], out: { href: string; text: string }[] = []): { href: string; text: string }[] {
  for (const i of inlines) {
    if (i.kind === 'link') {
      out.push({ href: i.href, text: inlineText(i.children) })
      collectLinks(i.children, out)
    } else if (i.kind !== 'text' && i.kind !== 'br') {
      collectLinks(i.children, out)
    }
  }
  return out
}
