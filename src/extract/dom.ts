// DOM construction is isolated here so the parser (linkedom today) can be
// swapped for jsdom in one file if a site ever needs it.
import { parseHTML } from 'linkedom'
import { resolveHttp } from '../util/url.js'

/** Parse HTML into a Document with an absolute <base href> for `url`. */
export function parseHtml(html: string, url: string): Document {
  const { document } = parseHTML(html)
  ensureBase(document, url)
  return document
}

function ensureBase(doc: Document, url: string): void {
  let head = doc.head
  if (!head) {
    head = doc.createElement('head')
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild)
  }
  const existing = head.querySelector('base[href]')
  if (existing) {
    existing.setAttribute('href', resolveHttp(existing.getAttribute('href'), url) ?? url)
    return
  }
  const base = doc.createElement('base')
  base.setAttribute('href', url)
  head.insertBefore(base, head.firstChild)
}

/** Effective base URL: the document's <base href> if any, else the fetched URL. */
export function baseUrlOf(doc: Document, fallback: string): URL {
  const href = doc.querySelector('base[href]')?.getAttribute('href')
  if (href) {
    try {
      return new URL(href, fallback)
    } catch {
      /* fall through */
    }
  }
  return new URL(fallback)
}

export function serializeDocument(doc: Document): string {
  return '<!DOCTYPE html>' + (doc.documentElement?.outerHTML ?? '')
}

/** Remove every element matching any selector. Returns how many were removed. */
export function removeAll(root: ParentNode, selectors: readonly string[]): number {
  let n = 0
  for (const sel of selectors) {
    let matches: Element[]
    try {
      matches = Array.from(root.querySelectorAll(sel))
    } catch {
      continue
    }
    for (const el of matches) {
      el.remove()
      n++
    }
  }
  return n
}

export function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  const style = el.getAttribute('style')
  return !!style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
}
