// Where .thing files land: out/<siteId>/<date>-<slug>-<hash8>.thing, written
// atomically. Older versions of a story keep their own files.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArticleArgs } from './args.js'
import type { IrDocument } from './ir.js'
import type { MediaFailure } from './media.js'
import { slugify } from './util/slug.js'

export function outputFileName(args: ArticleArgs, envelopeHash: string): string {
  const date = args.published ?? args.retrieved ?? 'undated'
  return `${date}-${slugify(args.title, 60)}-${envelopeHash.slice(0, 8)}.thing`
}

export function writeFileAtomic(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export interface DebugSidecar {
  ir: IrDocument
  media: { failed: MediaFailure[]; skipped: MediaFailure[] }
  warnings: string[]
}

export interface WriteOutputsOptions {
  outDir: string
  siteId: string
  args: ArticleArgs
  tar: Uint8Array
  envelopeHash: string
  debug?: DebugSidecar
}

/** Write the bundle (and, with --debug, JSON sidecars). Returns the .thing path. */
export function writeOutputs(o: WriteOutputsOptions): string {
  const dir = join(o.outDir, o.siteId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, outputFileName(o.args, o.envelopeHash))
  writeFileAtomic(file, o.tar)
  if (o.debug) {
    const base = file.replace(/\.thing$/, '')
    writeFileAtomic(`${base}.args.json`, JSON.stringify(o.args, null, 2) + '\n')
    writeFileAtomic(`${base}.ir.json`, JSON.stringify(o.debug, null, 2) + '\n')
  }
  return file
}
