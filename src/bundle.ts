// Build, sign and self-verify an article bundle; inspect existing ones.
import {
  admitBundle, buildBundle, cborToJs, chainInfo, encode, fromHex, hash, jsToCbor, loadProgram, parseBundle,
  programHashHex, toHex, type Signer
} from './souspli.js'
import type { ArticleArgs } from './args.js'
import { toChecksumAddress } from './identity.js'
import { concatBytes, utf8 } from './util/bytes.js'

export interface Chain {
  path: string
  seq: number
  /** hex envelope hash of the previous version */
  prev?: string
}

export interface BuiltArticle {
  tar: Uint8Array
  envelopeHash: string
  manifestHash: string
  argsBytes: number
  programHash: string
}

export class BuildError extends Error {
  override name = 'BuildError'
}

export type Attachments = Map<string, { bytes: Uint8Array; mime: string }>

/** Hash of what the reader would see, independent of when we fetched it. */
export function contentHash(args: ArticleArgs, attachments: Attachments): string {
  const argsBytes = encode(jsToCbor({ ...args, retrieved: undefined }))
  const names = [...attachments.keys()].sort()
  const parts = [argsBytes]
  for (const n of names) {
    const a = attachments.get(n)!
    parts.push(utf8(`\n${n}:${a.mime}:`), hash(a.bytes))
  }
  return toHex(hash(concatBytes(...parts)))
}

export async function buildArticle(
  signer: Signer,
  args: ArticleArgs,
  attachments: Attachments,
  chain: Chain,
  created: number,
  hardArgsBytes: number
): Promise<BuiltArticle> {
  const cborArgs = jsToCbor(args)
  const argsBytes = encode(cborArgs).length
  if (argsBytes > hardArgsBytes) throw new BuildError(`args are ${argsBytes} bytes, above the ${hardArgsBytes}-byte cap`)
  const program = loadProgram()
  const tar = await buildBundle(signer, {
    program,
    type: 'article',
    args: cborArgs,
    attachments,
    created,
    path: chain.path,
    seq: chain.seq,
    ...(chain.prev ? { prev: fromHex(chain.prev) } : {})
  })
  const r = admitBundle(parseBundle(tar))
  if (r.status !== 'valid') throw new BuildError(`self-admission failed: ${r.status === 'invalid' ? r.reason : r.status}`)
  const programHash = toHex(r.manifest.prog)
  if (programHash !== programHashHex()) throw new BuildError('program hash mismatch after build')
  return { tar, envelopeHash: toHex(r.envelopeHash), manifestHash: toHex(r.envelope.man), argsBytes, programHash }
}

export interface Inspection {
  status: 'valid' | 'invalid' | 'unverifiable' | 'not-for-me'
  reason?: string
  envelopeHash?: string
  author?: { scheme: string; key: string; display: string }
  created?: number
  chain?: { path?: string; seq?: number; prev?: string }
  type?: string
  programHash?: string
  programMatches?: boolean
  attachments: { name: string; mime: string; size: number; sha256: string }[]
  args?: unknown
  argsBytes?: number
}

export function inspectBundle(tar: Uint8Array): Inspection {
  let r
  try {
    r = admitBundle(parseBundle(tar))
  } catch (e) {
    return { status: 'invalid', reason: (e as Error).message, attachments: [] }
  }
  if (r.status !== 'valid') {
    return { status: r.status, ...(r.status === 'invalid' ? { reason: r.reason } : {}), attachments: [] }
  }
  const key = toHex(r.envelope.author.k)
  const ci = chainInfo(r.envelope)
  const chain: Inspection['chain'] = {}
  if (ci.path !== undefined) chain.path = ci.path
  if (ci.seq !== undefined) chain.seq = ci.seq
  if (ci.prev !== undefined) chain.prev = toHex(ci.prev)
  const programHash = toHex(r.manifest.prog)
  return {
    status: 'valid',
    envelopeHash: toHex(r.envelopeHash),
    author: { scheme: r.envelope.author.s, key, display: r.envelope.author.s === 'eth-eip191' ? toChecksumAddress(key) : key },
    created: r.envelope.created,
    chain,
    type: r.manifest.type,
    programHash,
    programMatches: programHash === programHashHex(),
    attachments: [...r.manifest.att.entries()].map(([name, a]) => ({ name, mime: a.m, size: a.n, sha256: toHex(a.h) })),
    args: cborToJs(r.manifest.args),
    argsBytes: encode(r.manifest.args).length
  }
}
