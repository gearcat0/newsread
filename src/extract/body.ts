// Body extraction: Readability (or a per-site selector) picks the article root;
// domToIr walks that root into the rich IR. Nothing here knows about cage.
import { Readability } from '@mozilla/readability'
import type { Site } from '../config.js'
import type { Inline, IrBlock, IrImage } from '../ir.js'
import { text as T } from '../ir.js'
import { imageCandidates } from './srcset.js'
import { isHidden, parseHtml, serializeDocument } from './dom.js'
import { normalizeLines, normalizeText } from '../util/text.js'
import { resolveHttp } from '../util/url.js'

export interface ReadabilityMeta {
  title?: string
  byline?: string
  excerpt?: string
  siteName?: string
  publishedTime?: string
  lang?: string
}

export interface BodyResult {
  root: Element
  via: 'selector' | 'readability'
  readability?: ReadabilityMeta
  textLength: number
}

/** Find the article root. Readability runs on a re-parsed copy because it
 *  mutates its input and we still need the original for metadata. */
export function extractBody(doc: Document, site: Site, url: string): BodyResult | undefined {
  if (site.articleSelector) {
    const el = doc.querySelector(site.articleSelector)
    if (el) return { root: el, via: 'selector', textLength: normalizeText(el.textContent ?? '').length }
  }
  const clone = parseHtml(serializeDocument(doc), url)
  let parsed: ReturnType<Readability<Element>['parse']>
  try {
    parsed = new Readability<Element>(clone, { serializer: (n) => n as Element, disableJSONLD: true, keepClasses: true }).parse()
  } catch {
    return undefined
  }
  if (!parsed?.content) return undefined
  const rd: ReadabilityMeta = {}
  if (parsed.title) rd.title = parsed.title
  if (parsed.byline) rd.byline = parsed.byline
  if (parsed.excerpt) rd.excerpt = parsed.excerpt
  if (parsed.siteName) rd.siteName = parsed.siteName
  if (parsed.publishedTime) rd.publishedTime = parsed.publishedTime
  if (parsed.lang) rd.lang = parsed.lang
  return { root: parsed.content, via: 'readability', readability: rd, textLength: normalizeText(parsed.textContent ?? '').length }
}

// ── DOM → IR ────────────────────────────────────────────────────────────────

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'button', 'form', 'input', 'select', 'textarea',
  'nav', 'link', 'meta', 'head', 'title', 'object', 'embed', 'map', 'area', 'dialog', 'menu', 'aside'
])
const HEADING: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
const INLINE = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
  'var', 'wbr', 'br', 'img', 'picture', 'source', 'ruby', 'rt', 'rp', 'output', 'meter', 'progress'
])
const EM = new Set(['em', 'i', 'cite', 'dfn', 'var'])
const STRONG = new Set(['strong', 'b'])
const CODE = new Set(['code', 'kbd', 'samp', 'tt'])
const CREDIT_SELECTOR = '[class*="credit" i], [class*="source" i], [class*="copyright" i], [class*="attribution" i], [class*="byline" i], small'

const ELEMENT = 1
const TEXT = 3

function tagOf(el: Element): string {
  return el.tagName.toLowerCase()
}

function hasBlockChildren(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    const t = tagOf(c)
    if (!INLINE.has(t) && !SKIP.has(t)) return true
  }
  return false
}

/** Collapse whitespace, merge adjacent text, drop empties, trim the edges. */
export function cleanInlines(inlines: Inline[]): Inline[] {
  const collapse = (list: Inline[]): Inline[] => {
    const out: Inline[] = []
    for (const i of list) {
      if (i.kind === 'text') {
        const t = i.text.replace(/\s+/g, ' ')
        if (!t) continue
        const last = out[out.length - 1]
        if (last && last.kind === 'text') last.text += t
        else out.push({ kind: 'text', text: t })
      } else if (i.kind === 'br') {
        out.push(i)
      } else {
        const children = collapse(i.children)
        if (children.length) out.push({ ...i, children })
      }
    }
    return out
  }
  let out = collapse(inlines)
  // trim the leading edge of the first text leaf and the trailing edge of the last
  const first = firstText(out)
  if (first) first.text = first.text.replace(/^\s+/, '')
  const last = lastText(out)
  if (last) last.text = last.text.replace(/\s+$/, '')
  out = collapse(out)
  while (out.length && out[0]!.kind === 'br') out.shift()
  while (out.length && out[out.length - 1]!.kind === 'br') out.pop()
  return out
}

function firstText(list: Inline[]): { kind: 'text'; text: string } | undefined {
  for (const i of list) {
    if (i.kind === 'text') return i
    if (i.kind !== 'br') {
      const f = firstText(i.children)
      if (f) return f
    }
  }
  return undefined
}

function lastText(list: Inline[]): { kind: 'text'; text: string } | undefined {
  for (let k = list.length - 1; k >= 0; k--) {
    const i = list[k]!
    if (i.kind === 'text') return i
    if (i.kind !== 'br') {
      const f = lastText(i.children)
      if (f) return f
    }
  }
  return undefined
}

class Walker {
  readonly warnings: string[] = []
  private run: Inline[] = []
  private pending: IrBlock[] = []

  constructor(private readonly base: URL) {}

  /** Walk `el`'s children as block content into `out`. */
  children(el: Node, out: IrBlock[]): void {
    for (const child of Array.from(el.childNodes)) this.node(child, out)
    this.flush(out)
  }

  private flush(out: IrBlock[]): void {
    const inl = cleanInlines(this.run)
    this.run = []
    if (inl.length) out.push({ kind: 'paragraph', inlines: inl })
    this.flushPending(out)
  }

  private flushPending(out: IrBlock[]): void {
    if (this.pending.length) {
      out.push(...this.pending)
      this.pending = []
    }
  }

  private node(n: Node, out: IrBlock[]): void {
    if (n.nodeType === TEXT) {
      this.run.push(T(n.nodeValue ?? ''))
      return
    }
    if (n.nodeType !== ELEMENT) return
    const el = n as Element
    const tag = tagOf(el)
    if (SKIP.has(tag) || isHidden(el)) return

    const heading = HEADING[tag]
    if (heading) {
      this.flush(out)
      const inl = cleanInlines(this.inlines(el))
      if (inl.length) out.push({ kind: 'heading', level: heading, inlines: inl })
      this.flushPending(out)
      return
    }
    switch (tag) {
      case 'p': {
        this.flush(out)
        const inl = cleanInlines(this.inlines(el))
        if (inl.length) out.push({ kind: 'paragraph', inlines: inl })
        this.flushPending(out)
        return
      }
      case 'ul':
      case 'ol':
        this.flush(out)
        this.list(el, tag === 'ol', out)
        return
      case 'blockquote':
        this.flush(out)
        this.blockquote(el, out)
        return
      case 'pre': {
        this.flush(out)
        const code = normalizeLines(el.textContent ?? '')
        if (code) {
          const lang = /(?:language|lang)-([\w#+-]+)/.exec(el.querySelector('code')?.getAttribute('class') ?? el.getAttribute('class') ?? '')?.[1]
          out.push(lang ? { kind: 'code', text: code, language: lang } : { kind: 'code', text: code })
        }
        return
      }
      case 'table':
        this.flush(out)
        this.table(el, out)
        return
      case 'figure':
        this.flush(out)
        this.figure(el, out)
        return
      case 'img':
      case 'picture': {
        this.flush(out)
        const img = tag === 'img' ? el : el.querySelector('img')
        if (img) out.push({ kind: 'figure', image: this.image(img, [], undefined, el) })
        return
      }
      case 'video':
        this.flush(out)
        out.push(this.video(el, []))
        return
      case 'iframe': {
        this.flush(out)
        const src = resolveHttp(el.getAttribute('src') ?? el.getAttribute('data-src'), this.base)
        if (src) out.push({ kind: 'embed', url: src, caption: [] })
        return
      }
      case 'hr':
        this.flush(out)
        out.push({ kind: 'hr' })
        return
      case 'br':
        this.run.push({ kind: 'br' })
        return
    }
    if (INLINE.has(tag)) {
      this.run.push(...this.inlineNode(el))
      return
    }
    // Generic container: div, section, article, main, li, dd, header, footer, ...
    if (hasBlockChildren(el)) {
      this.flush(out)
      this.children(el, out)
    } else {
      this.flush(out)
      const inl = cleanInlines(this.inlines(el))
      if (inl.length) out.push({ kind: 'paragraph', inlines: inl })
      this.flushPending(out)
    }
  }

  private inlines(el: Node): Inline[] {
    const out: Inline[] = []
    for (const c of Array.from(el.childNodes)) out.push(...this.inlineNode(c))
    return out
  }

  private inlineNode(n: Node): Inline[] {
    if (n.nodeType === TEXT) return [T(n.nodeValue ?? '')]
    if (n.nodeType !== ELEMENT) return []
    const el = n as Element
    const tag = tagOf(el)
    if (SKIP.has(tag) || isHidden(el)) return []
    switch (tag) {
      case 'br':
        return [{ kind: 'br' }]
      case 'wbr':
        return []
      case 'img':
      case 'picture': {
        const img = tag === 'img' ? el : el.querySelector('img')
        if (img) this.pending.push({ kind: 'figure', image: this.image(img, [], undefined, el) })
        return []
      }
      case 'a': {
        const href = resolveHttp(el.getAttribute('href'), this.base)
        const children = this.inlines(el)
        return href ? [{ kind: 'link', href, children }] : children
      }
      case 'q':
        return [T('“'), ...this.inlines(el), T('”')]
      case 'sub':
        return [{ kind: 'sub', children: this.inlines(el) }]
      case 'sup':
        return [{ kind: 'sup', children: this.inlines(el) }]
    }
    if (EM.has(tag)) return [{ kind: 'em', children: this.inlines(el) }]
    if (STRONG.has(tag)) return [{ kind: 'strong', children: this.inlines(el) }]
    if (CODE.has(tag)) return [{ kind: 'code', children: this.inlines(el) }]
    if (!INLINE.has(tag)) {
      // A block element in inline context (li text, stray div in a p): keep its
      // text, separated by a line break so words do not run together.
      return [{ kind: 'br' }, ...this.inlines(el), { kind: 'br' }]
    }
    return this.inlines(el)
  }

  private list(el: Element, ordered: boolean, out: IrBlock[]): void {
    const items: IrBlock[][] = []
    for (const li of Array.from(el.children)) {
      if (tagOf(li) !== 'li') continue
      const blocks: IrBlock[] = []
      this.children(li, blocks)
      if (blocks.length) items.push(blocks)
    }
    if (!items.length) return
    const startAttr = parseInt(el.getAttribute('start') ?? '', 10)
    const block: IrBlock = { kind: 'list', ordered, items }
    if (ordered && Number.isFinite(startAttr) && startAttr !== 1) block.start = startAttr
    out.push(block)
  }

  private blockquote(el: Element, out: IrBlock[]): void {
    let cite = el.getAttribute('cite') ?? undefined
    for (const c of Array.from(el.querySelectorAll('cite, footer'))) {
      const t = normalizeText(c.textContent ?? '').replace(/^[—–-]\s*/, '')
      if (t && !cite) cite = t
      c.remove()
    }
    const children: IrBlock[] = []
    this.children(el, children)
    if (!children.length) return
    out.push(cite ? { kind: 'blockquote', children, cite } : { kind: 'blockquote', children })
  }

  private table(el: Element, out: IrBlock[]): void {
    const rows: { header: boolean; cells: Inline[][] }[] = []
    for (const tr of Array.from(el.querySelectorAll('tr'))) {
      const cellEls = Array.from(tr.children).filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th')
      if (!cellEls.length) continue
      const inThead = tagOf(tr.parentElement ?? el) === 'thead'
      const header = inThead || cellEls.every((c) => tagOf(c) === 'th')
      rows.push({ header, cells: cellEls.map((c) => cleanInlines(this.inlines(c))) })
    }
    if (!rows.length) return
    const capEl = el.querySelector('caption')
    const caption = capEl ? cleanInlines(this.inlines(capEl)) : []
    out.push(caption.length ? { kind: 'table', caption, rows } : { kind: 'table', rows })
  }

  private figure(el: Element, out: IrBlock[]): void {
    const figcaption = el.querySelector('figcaption')
    let credit: string | undefined
    let caption: Inline[] = []
    if (figcaption) {
      const creditEl = figcaption.querySelector(CREDIT_SELECTOR)
      if (creditEl && creditEl !== figcaption) {
        const t = normalizeText(creditEl.textContent ?? '')
        if (t) credit = t
        creditEl.remove()
      }
      caption = cleanInlines(this.inlines(figcaption))
    }
    const video = el.querySelector('video')
    if (video) {
      out.push(this.video(video, caption))
      return
    }
    const img = el.querySelector('img')
    if (img) {
      out.push({ kind: 'figure', image: this.image(img, caption, credit, el) })
      return
    }
    const iframe = el.querySelector('iframe')
    if (iframe) {
      const src = resolveHttp(iframe.getAttribute('src') ?? iframe.getAttribute('data-src'), this.base)
      if (src) out.push({ kind: 'embed', url: src, caption })
      return
    }
    figcaption?.remove()
    this.children(el, out)
  }

  private image(img: Element, caption: Inline[], credit: string | undefined, scope: Element): IrImage {
    let candidates = imageCandidates(img, this.base)
    if (!candidates.length) {
      // lazy-loaded with a data: placeholder and the real tag inside <noscript>
      const ns = scope.querySelector('noscript')?.textContent ?? ''
      const m = /<img[^>]+src=["']([^"']+)["']/i.exec(ns)
      const url = resolveHttp(m?.[1], this.base)
      if (url) candidates = [{ url }]
    }
    const image: IrImage = { candidates, alt: normalizeText(img.getAttribute('alt') ?? ''), caption }
    if (credit) image.credit = credit
    const w = parseInt(img.getAttribute('width') ?? '', 10)
    const h = parseInt(img.getAttribute('height') ?? '', 10)
    if (Number.isFinite(w) && w > 0) image.width = w
    if (Number.isFinite(h) && h > 0) image.height = h
    return image
  }

  private video(el: Element, caption: Inline[]): IrBlock {
    const sources: { url: string; mime?: string }[] = []
    const own = resolveHttp(el.getAttribute('src'), this.base)
    if (own) sources.push({ url: own })
    for (const s of Array.from(el.querySelectorAll('source'))) {
      const url = resolveHttp(s.getAttribute('src'), this.base)
      if (!url) continue
      const type = s.getAttribute('type')
      sources.push(type ? { url, mime: type } : { url })
    }
    const block: IrBlock = { kind: 'video', sources, caption }
    const poster = resolveHttp(el.getAttribute('poster'), this.base)
    if (poster) block.poster = { candidates: [{ url: poster }], alt: '', caption: [] }
    return block
  }
}

/** Convert an article root element into IR blocks. */
export function domToIr(root: Element, base: URL): { blocks: IrBlock[]; warnings: string[] } {
  const w = new Walker(base)
  const blocks: IrBlock[] = []
  w.children(root, blocks)
  while (blocks.length && blocks[0]!.kind === 'hr') blocks.shift()
  while (blocks.length && blocks[blocks.length - 1]!.kind === 'hr') blocks.pop()
  return { blocks, warnings: w.warnings }
}
