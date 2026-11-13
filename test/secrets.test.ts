import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '../src/config.js'
import { createPublisher } from '../src/publish/index.js'
import { loadSecrets } from '../src/secrets.js'

const tmp = (): string => mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-secrets-'))

function publishConfig(seedboxes: object[]) {
  return defineConfig({
    sites: [],
    publish: { trackers: ['udp://t:1/announce'], webseed: { kind: 'dir', dir: '/srv/w', baseUrl: 'https://w' }, seedboxes: seedboxes as never }
  }).publish!
}

describe('secrets', () => {
  it('loads entries, remembers its file, and refuses a file others can read', () => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, JSON.stringify({ seedboxes: { dl: { password: 'p' } } }), { mode: 0o600 })
    expect(loadSecrets(file)).toEqual({ file, seedboxes: { dl: { password: 'p' } } })
    chmodSync(file, 0o644)
    expect(() => loadSecrets(file)).toThrow(/readable by others/)
  })

  it('a syntax error says where, and never repeats the file', () => {
    const file = join(tmp(), 'secrets.json')
    // V8 quotes the input in some of its messages; this is one.
    writeFileSync(file, '{"seedboxes": {"rt": {"password": hunter2}}}', { mode: 0o600 })
    let msg = ''
    try {
      loadSecrets(file)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/not valid JSON/)
    expect(msg).not.toContain('hunter2')
    writeFileSync(file, '{\n  "seedboxes": {\n    "a": { "password": "hunter2" }\n    "b": {}\n  }\n}', { mode: 0o600 })
    expect(() => loadSecrets(file)).toThrow(/not valid JSON at line 4 column 5/)
  })

  it('a user name with a stray space is refused, without showing it', () => {
    const file = join(tmp(), 'secrets.json')
    writeFileSync(file, JSON.stringify({ seedboxes: { rt: { username: ' rtorrent', password: 'p' } } }), { mode: 0o600 })
    expect(() => loadSecrets(file)).toThrow(/seedboxes\.rt\.username starts or ends with whitespace$/)
    const missing = join(tmp(), 'missing.json')
    expect(loadSecrets(missing)).toEqual({ file: missing, seedboxes: {} })
  })

  it('a qBittorrent or Deluge box with no password entry is an error naming what the file has', () => {
    const secrets = { file: '/home/u/.config/newsread/secrets.json', seedboxes: { deluge: { password: 'p' }, qbt: { password: 'q' } } }
    expect(() => createPublisher(publishConfig([{ kind: 'deluge', name: 'dl', url: 'http://dev:8112' }]), secrets)).toThrow(
      'seed box dl (deluge) needs a password, but /home/u/.config/newsread/secrets.json has no seedboxes.dl.password (it has "deluge", "qbt")'
    )
    expect(() => createPublisher(publishConfig([{ kind: 'qbittorrent', name: 'box', url: 'http://b' }]), { seedboxes: {} })).toThrow(
      /seed box box \(qbittorrent\) needs a password, but the secrets file has no seedboxes\.box\.password \(it has no seed box entries\)/
    )
    // an explicit empty password is the operator's choice, not a typo
    expect(createPublisher(publishConfig([{ kind: 'qbittorrent', name: 'qbt', url: 'http://b' }]), { seedboxes: { qbt: { password: '' } } }).boxes).toHaveLength(1)
  })

  it('Transmission and rTorrent may run without a login', () => {
    const p = createPublisher(
      publishConfig([
        { kind: 'transmission', name: 'tr', url: 'http://b:9091/transmission/rpc' },
        { kind: 'rtorrent', name: 'rt', url: 'http://b/RPC2', directory: '/srv/w' }
      ]),
      { seedboxes: {} }
    )
    expect(p.boxes.map((b) => b.name)).toEqual(['tr', 'rt'])
  })
})
