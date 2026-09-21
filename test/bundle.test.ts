import { describe, it, expect } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { buildArticle, contentHash, inspectBundle, BuildError } from '../src/bundle.js'
import { ethSigner } from '../src/identity.js'
import { admitBundle, parseBundle, cborToJs, programHashHex, toHex } from '../src/souspli.js'
import type { ArticleArgs } from '../src/args.js'
import { storyPath } from '../src/state.js'
import * as img from './helpers/images.js'
import { KiB } from '../src/util/bytes.js'

const signer = ethSigner(secp256k1.utils.randomSecretKey())
const args: ArticleArgs = {
  title: 'Scaffolding goes up on Monday',
  authors: ['A. Reporter'],
  publisher: 'The Example Times',
  published: '2026-09-03',
  retrieved: '2026-09-04',
  sourceUrl: 'https://example.com/story/1',
  language: 'en',
  blocks: [
    { kind: 'heading', text: 'What is happening' },
    { kind: 'paragraph', text: 'Contractors arrive at first light.' },
    { kind: 'image', name: 'img-1', caption: 'The north face', alt: 'Scaffolding', placement: 'full' },
    { kind: 'footnote', text: 'Per the works order.' }
  ]
}
const attachments = new Map([['img-1', { bytes: img.png(1), mime: 'image/png' }]])

describe('buildArticle', () => {
  it('produces a bundle Souspli admits as a valid article with the right program and attachments', async () => {
    const built = await buildArticle(signer, args, attachments, { path: storyPath(args.sourceUrl!), seq: 1 }, 1_756_944_000, 256 * KiB)
    const r = admitBundle(parseBundle(built.tar))
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect(r.manifest.type).toBe('article')
    expect(toHex(r.manifest.prog)).toBe(programHashHex())
    expect(built.programHash).toBe(programHashHex())
    expect(toHex(r.envelopeHash)).toBe(built.envelopeHash)
    expect(toHex(r.envelope.man)).toBe(built.manifestHash)
    expect(r.envelope.created).toBe(1_756_944_000)
    expect(r.envelope.path).toBe(storyPath(args.sourceUrl!))
    expect(r.envelope.seq).toBe(1)
    expect(r.envelope.prev).toBeUndefined()
    expect(r.manifest.att.get('img-1')?.m).toBe('image/png')
    expect(r.attachments.get('img-1')).toEqual(img.png(1))
    expect(cborToJs(r.manifest.args)).toEqual(args)
  })
  it('links versions with seq/prev and refuses oversize args', async () => {
    const v1 = await buildArticle(signer, args, attachments, { path: 'news/x/abc', seq: 1 }, 1, 256 * KiB)
    const v2 = await buildArticle(signer, { ...args, title: 'Edited' }, attachments, { path: 'news/x/abc', seq: 2, prev: v1.envelopeHash }, 2, 256 * KiB)
    const i = inspectBundle(v2.tar)
    expect(i.chain).toEqual({ path: 'news/x/abc', seq: 2, prev: v1.envelopeHash })
    await expect(buildArticle(signer, { ...args, blocks: [{ kind: 'paragraph', text: 'x'.repeat(3000) }] }, attachments, { path: 'p', seq: 1 }, 1, 1024)).rejects.toBeInstanceOf(BuildError)
  })
  it('contentHash ignores `retrieved` but not content or attachments', () => {
    const a = contentHash(args, attachments)
    expect(contentHash({ ...args, retrieved: '2030-01-01' }, attachments)).toBe(a)
    expect(contentHash({ ...args, title: 'x' }, attachments)).not.toBe(a)
    expect(contentHash(args, new Map([['img-1', { bytes: img.png(2), mime: 'image/png' }]]))).not.toBe(a)
    expect(contentHash(args, new Map([['img-1', { bytes: img.png(1), mime: 'image/jpeg' }]]))).not.toBe(a)
  })
  it('inspectBundle reports invalid input without throwing', () => {
    expect(inspectBundle(new Uint8Array(10)).status).toBe('invalid')
    const good = inspectBundle(new Uint8Array(0))
    expect(good.status).toBe('invalid')
  })
})
