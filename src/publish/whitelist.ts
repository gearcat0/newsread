// A tracker that tracks only what it is told to. opentracker as Ubuntu and
// Debian ship it is built whitelist-only: it answers for the infohashes listed
// in its whitelist file and re-reads the file on SIGHUP. So each infohash goes
// on the list before any seed box announces it, or the box's first announce is
// refused ("Requested download is not authorized for use with this tracker").
//
// We only edit the file. Reloading is the tracker host's job (a systemd .path
// unit watching the file, say), so newsread needs no right to signal anything.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { type SshRunner, runSsh, shellQuote, sshArgs } from './webseed.js'

export interface TrackerWhitelist {
  readonly kind: string
  /** Add the infohash if it is not already listed. */
  add(infohash: string): Promise<void>
  remove(infohash: string): Promise<void>
}

const HEX40 = /^[0-9a-f]{40}$/

function checkHash(h: string): string {
  if (!HEX40.test(h)) throw new Error(`whitelist: not a lowercase hex infohash: ${JSON.stringify(h)}`)
  return h
}

/** The whitelist file on this machine. */
export class FileWhitelist implements TrackerWhitelist {
  readonly kind = 'file'
  constructor(private readonly o: { file: string }) {}

  async add(infohash: string): Promise<void> {
    const h = checkHash(infohash)
    const lines = existsSync(this.o.file) ? readFileSync(this.o.file, 'utf8').split('\n') : []
    if (lines.includes(h)) return
    const text = lines.join('\n')
    appendFileSync(this.o.file, `${text && !text.endsWith('\n') ? '\n' : ''}${h}\n`)
  }

  async remove(infohash: string): Promise<void> {
    const h = checkHash(infohash)
    if (!existsSync(this.o.file)) return
    const lines = readFileSync(this.o.file, 'utf8').split('\n')
    if (!lines.includes(h)) return
    writeFileSync(this.o.file, lines.filter((l) => l !== h).join('\n'))
  }
}

export interface SshWhitelistOptions {
  host: string
  file: string
  port?: number
  timeoutMs?: number
  ssh?: SshRunner
}

/** The whitelist file on the tracker's machine, edited over ssh. */
export class SshWhitelist implements TrackerWhitelist {
  readonly kind = 'ssh'
  readonly #ssh: SshRunner
  constructor(private readonly o: SshWhitelistOptions) {
    sshArgs(o.host, o.port, '') // refuses a bad host now, not at the first publish
    this.#ssh = o.ssh ?? runSsh
  }

  // flock: newsread is one process, but `seedbox-check` may run beside `serve`.
  // The file is edited in place (never replaced) so a .path unit on it, and the
  // file's owner and mode, stay as the operator set them.
  #run(script: string): Promise<void> {
    const f = shellQuote(this.o.file)
    return this.#ssh(sshArgs(this.o.host, this.o.port, `flock ${f} sh -c ${shellQuote(script)}`), new Uint8Array(0), this.o.timeoutMs ?? 30_000)
  }

  add(infohash: string): Promise<void> {
    const h = checkHash(infohash)
    const f = shellQuote(this.o.file)
    return this.#run(`grep -qxF ${h} ${f} || { [ -z "$(tail -c1 ${f})" ] || echo >> ${f}; echo ${h} >> ${f}; }`)
  }

  remove(infohash: string): Promise<void> {
    const h = checkHash(infohash)
    const f = shellQuote(this.o.file)
    // grep -v exits 1 when nothing is left, which is not a failure here.
    // The copy goes to mktemp: newsread may write the file but not its directory.
    return this.#run(`! grep -qxF ${h} ${f} || { t=$(mktemp) && grep -vxF ${h} ${f} > "$t"; cat "$t" > ${f}; rm -f "$t"; }`)
  }
}
