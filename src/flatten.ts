// IR → cage article args. This is the ONLY place the rich IR is lossy: inline
// links, emphasis, list structure, quotes, code and tables are reduced to the
// six block kinds cage renders. When cage gains inline links, change `inlineText`
// and the paragraph emitter here and nothing upstream.
import type { LimitsConfig } from './config.js'
import type { Inline, IrBlock, IrDocument } from './ir.js'
import { inlineText } from './ir.js'
import type { MediaResolution } from './media.js'
import { type ArticleArgs, type Block, encodedArgsBytes, isMediaBlock } from './args.js'
import { normalizeText } from './util/text.js'

export interface FlattenOptions {
  limits: LimitsConfig
  /** YYYY-MM-DD, when the scraper captured the page. */
  retrieved: string
}

export interface Flattened {
  args: ArticleArgs
  attachments: Map<string, { bytes: Uint8Array; mime: string }>
  warnings: string[]
}

const MAX_CODE_LINES = 40
const MAX_TABLE_ROWS = 30
const MAX_TABLE_COLS = 8

/** Split inline runs on double line breaks into separate paragraph texts. */
function paragraphTexts(inlines: readonly Inline[]): string[] {
  const parts: Inline[][] = [[]]
  let brRun = 0
  for (const i of inlines) {
    if (i.kind === 'br') {
      brRun++
      if (brRun === 2) {
        parts.push([])
        brRun = 0
        continue
      }
      parts[parts.length - 1]!.push(i)
      continue
    }
    brRun = 0
    parts[parts.length - 1]!.push(i)
  }
  return parts.map((p) => normalizeText(inlineText(p))).filter(Boolean)
}

class Emitter {
  readonly blocks: Block[] = []
  readonly warnings: string[] = []
  private deferredFootnotes: string[] = []
  private readonly title: string | undefined

  constructor(
    private readonly media: MediaResolution,
    title: string | undefined
  ) {
    this.title = title ? normalizeText(title).toLowerCase() : undefined
  }

  private push(b: Block): void {
    this.blocks.push(b)
    if (b.kind !== 'footnote' && this.deferredFootnotes.length) {
      for (const t of this.deferredFootnotes) this.blocks.push({ kind: 'footnote', text: t })
      this.deferredFootnotes = []
    }
  }

  footnote(text: string): void {
    const t = normalizeText(text)
    if (!t) return
    if (this.blocks.length === 0) this.deferredFootnotes.push(t)
    else this.blocks.push({ kind: 'footnote', text: t })
  }

  paragraph(text: string): void {
    const t = normalizeText(text)
    if (t) this.push({ kind: 'paragraph', text: t })
  }

  finish(): Block[] {
    // Footnotes with nothing before them mark the article body itself.
    for (const t of this.deferredFootnotes) this.blocks.push({ kind: 'footnote', text: t })
    this.deferredFootnotes = []
    return this.blocks
  }

  block(b: IrBlock, depth = 0): void {
    switch (b.kind) {
      case 'heading': {
        const t = normalizeText(inlineText(b.inlines))
        if (!t) return
        if (this.title && t.toLowerCase() === this.title) return
        this.push({ kind: b.level <= 2 ? 'heading' : 'subheading', text: t })
        return
      }
      case 'paragraph':
        for (const t of paragraphTexts(b.inlines)) this.paragraph(t)
        return
      case 'list': {
        const start = b.start ?? 1
        b.items.forEach((item, idx) => {
          const prefix = depth > 0 ? '– ' : b.ordered ? `${start + idx}. ` : '• '
          let first = true
          for (const child of item) {
            if (child.kind === 'paragraph') {
              const texts = paragraphTexts(child.inlines)
              for (const t of texts) {
                this.paragraph(first ? prefix + t : t)
                first = false
              }
            } else if (child.kind === 'list') {
              this.block(child, depth + 1)
            } else {
              if (first && child.kind !== 'figure' && child.kind !== 'video') {
                // A list item beginning with a non-paragraph block: emit the marker alone.
                this.paragraph(prefix.trim())
                first = false
              }
              this.block(child, depth + 1)
            }
          }
        })
        return
      }
      case 'blockquote': {
        const texts: string[] = []
        for (const child of b.children) {
          if (child.kind === 'paragraph') texts.push(...paragraphTexts(child.inlines))
          else if (child.kind === 'heading') texts.push(normalizeText(inlineText(child.inlines)))
          else this.block(child, depth + 1)
        }
        const clean = texts.filter(Boolean)
        clean.forEach((t, i) => {
          const quoted = `“${t}”`
          this.paragraph(i === clean.length - 1 && b.cite ? `${quoted} — ${b.cite}` : quoted)
        })
        return
      }
      case 'code': {
        const lines = b.text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length)
        const shown = lines.slice(0, MAX_CODE_LINES)
        for (const l of shown) this.push({ kind: 'paragraph', text: normalizeText(l) })
        if (lines.length > MAX_CODE_LINES) this.footnote(`Code listing truncated (${lines.length - MAX_CODE_LINES} more lines).`)
        return
      }
      case 'table': {
        const cols = Math.max(0, ...b.rows.map((r) => r.cells.length))
        if (b.rows.length > MAX_TABLE_ROWS || cols > MAX_TABLE_COLS) {
          this.footnote(`Table omitted (${b.rows.length} rows × ${cols} columns) — see the original.`)
          return
        }
        if (b.caption?.length) this.paragraph(inlineText(b.caption))
        for (const r of b.rows) {
          const cells = r.cells.map((c) => normalizeText(inlineText(c)))
          if (cells.every((c) => !c)) continue
          this.paragraph(cells.join(' | '))
        }
        return
      }
      case 'figure': {
        const m = this.media.byBlock.get(b)
        if (!m) {
          this.warnings.push(`image dropped: ${b.image.candidates[0]?.url ?? '(no candidates)'}`)
          return
        }
        let caption = normalizeText(inlineText(b.image.caption))
        if (b.image.credit) caption = caption ? `${caption} (${b.image.credit})` : b.image.credit
        this.push({ kind: 'image', name: m.name, caption, alt: normalizeText(b.image.alt), placement: 'full' })
        return
      }
      case 'video': {
        const m = this.media.byBlock.get(b)
        if (m) {
          this.push({ kind: 'video', name: m.name, caption: normalizeText(inlineText(b.caption)), alt: '', placement: 'full' })
          return
        }
        const url = b.sources[0]?.url
        this.footnote(url ? `Video not captured: ${url}` : 'Video not captured.')
        return
      }
      case 'embed':
        this.footnote(`Embedded content omitted: ${b.url}`)
        return
      case 'hr':
        return
    }
  }
}

function truncationNote(omitted: number, sourceUrl: string | undefined): Block {
  return {
    kind: 'footnote',
    text: `Article truncated: ${omitted} further block${omitted === 1 ? '' : 's'} omitted${sourceUrl ? `; see the original at ${sourceUrl}` : ''}.`
  }
}

export function flatten(ir: IrDocument, media: MediaResolution, opts: FlattenOptions): Flattened {
  const meta = ir.meta
  const em = new Emitter(media, meta.title)
  for (const b of ir.blocks) em.block(b)
  let blocks = em.finish()
  const warnings = [...ir.warnings, ...em.warnings]

  // The standfirst often reappears as the first body paragraph.
  if (meta.deck) {
    const firstText = blocks.find((b) => !isMediaBlock(b))
    if (firstText && firstText.kind === 'paragraph' && normalizeText(firstText.text).toLowerCase() === normalizeText(meta.deck).toLowerCase()) {
      blocks = blocks.filter((b) => b !== firstText)
    }
  }

  if (media.lead) {
    const lead = media.lead
    blocks.unshift({ kind: 'image', name: lead.name, caption: '', alt: normalizeText(meta.leadImage?.alt ?? ''), placement: 'full' })
  }

  const args: ArticleArgs = { blocks }
  if (meta.title) args.title = meta.title
  if (meta.deck) args.deck = meta.deck
  if (meta.authors.length) args.authors = meta.authors.slice(0, 64)
  if (meta.publisher) args.publisher = meta.publisher
  if (meta.section) args.section = meta.section
  if (meta.location) args.location = meta.location
  if (meta.published) args.published = meta.published
  if (meta.updated) args.updated = meta.updated
  args.retrieved = opts.retrieved
  args.sourceUrl = meta.canonicalUrl
  if (meta.language) args.language = meta.language
  if (meta.rights) args.rights = meta.rights
  if (meta.keywords.length) args.keywords = meta.keywords.slice(0, 64)

  // Caps: block count first, then encoded byte budget. Both trim from the end
  // and leave a footnote saying so.
  const { maxBlocks, targetArgsBytes } = opts.limits
  let omitted = 0
  const total = blocks.length
  if (blocks.length > maxBlocks) {
    omitted = blocks.length - (maxBlocks - 1)
    blocks = blocks.slice(0, maxBlocks - 1)
  }
  const sized = (): number => encodedArgsBytes({ ...args, blocks: omitted ? [...blocks, truncationNote(omitted, args.sourceUrl)] : blocks })
  while (blocks.length > 1 && sized() > targetArgsBytes) {
    blocks.pop()
    omitted++
  }
  if (omitted) {
    blocks.push(truncationNote(omitted, args.sourceUrl))
    warnings.push(`truncated: ${omitted} of ${total} blocks omitted to stay within limits`)
  }
  args.blocks = blocks

  // Only ship attachments that a surviving block references.
  const referenced = new Set(blocks.filter(isMediaBlock).map((b) => b.name))
  const attachments = new Map<string, { bytes: Uint8Array; mime: string }>()
  const all = [...media.byBlock.values(), ...(media.lead ? [media.lead] : [])]
  for (const m of all) if (referenced.has(m.name) && !attachments.has(m.name)) attachments.set(m.name, { bytes: m.bytes, mime: m.mime })

  return { args, attachments, warnings }
}
