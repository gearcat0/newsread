import { describe, it, expect } from 'vitest'
import { defineConfig, ConfigError, siteForUrl, expandPath, genericSite, DEFAULTS } from '../src/config.js'

describe('defineConfig', () => {
  it('applies defaults and keeps sites', () => {
    const c = defineConfig({ perHostDelayMs: 10, media: { maxImages: 5 }, sites: [{ id: 'a', hosts: ['a.com'], feeds: [] }] })
    expect(c.perHostDelayMs).toBe(10)
    expect(c.timeoutMs).toBe(DEFAULTS.timeoutMs)
    expect(c.media.maxImages).toBe(5)
    expect(c.media.concurrency).toBe(3)
    expect(c.limits.maxBlocks).toBe(400)
    expect(c.sites[0]!.id).toBe('a')
  })
  it('validates ids, hosts and feeds', () => {
    expect(() => defineConfig({ sites: [{ id: 'Bad Id', hosts: ['x'], feeds: [] }] })).toThrow(ConfigError)
    expect(() => defineConfig({ sites: [{ id: 'a', hosts: [], feeds: [] }] })).toThrow(/hosts/)
    expect(() => defineConfig({ sites: [{ id: 'a', hosts: ['x'], feeds: ['ftp://x'] }] })).toThrow(/http/)
    expect(() => defineConfig({ sites: [{ id: 'a', hosts: ['x'], feeds: [] }, { id: 'a', hosts: ['y'], feeds: [] }] })).toThrow(/duplicate/)
  })
  it('siteForUrl matches hosts by suffix; genericSite fills in', () => {
    const c = defineConfig({ sites: [{ id: 'a', hosts: ['example.com'], feeds: [] }] })
    expect(siteForUrl(c, 'https://news.example.com/x')?.id).toBe('a')
    expect(siteForUrl(c, 'https://other.org/x')).toBeUndefined()
    expect(genericSite('https://other.org/x')).toEqual({ id: 'misc', hosts: ['other.org'], feeds: [] })
  })
  it('expandPath handles ~ and XDG', () => {
    expect(expandPath('~/x', '/cwd')).toMatch(/^\/.*\/x$/)
    expect(expandPath('rel/x', '/cwd')).toBe('/cwd/rel/x')
    expect(expandPath('$XDG_CONFIG_HOME/newsread/k', '/cwd')).toMatch(/\/newsread\/k$/)
  })
})

describe('publish, relays and scrape config', () => {
  const sites = [{ id: 'a', hosts: ['a.com'], feeds: [] }]
  const webseed = { kind: 'dir' as const, dir: '/srv/www', baseUrl: 'https://seed.example' }
  it('defaults: no publishing, no relays, scrape all', () => {
    const c = defineConfig({ sites })
    expect(c.publish).toBeUndefined()
    expect(c.relays).toEqual([])
    expect(c.scrape).toBe('all')
    expect(c.about.repostDays).toBe(7)
  })
  it('fills publish defaults and keeps seed boxes', () => {
    const c = defineConfig({ sites, relays: ['wss://r.example'], publish: { trackers: ['udp://t:1/announce'], webseed, seedboxes: [{ kind: 'transmission', name: 'tr', url: 'http://b:9091/transmission/rpc' }] } })
    expect(c.publish?.seedTimeoutMs).toBe(600_000)
    expect(c.publish?.backlogDays).toBe(2)
    expect(c.publish?.seedboxes[0]?.kind).toBe('transmission')
  })
  it('refuses what cannot work', () => {
    const p = (over: object) => () => defineConfig({ sites, publish: { trackers: ['udp://t:1/announce'], webseed, seedboxes: [], ...over } })
    expect(p({ trackers: [] })).toThrow(/tracker/)
    expect(p({ trackers: ['magnet:x'] })).toThrow(/tracker/)
    expect(p({ webseed: undefined })).toThrow(/webseed/)
    expect(p({ webseed: { kind: 's3', endpoint: 'https://e' } })).toThrow(/s3/)
    expect(p({ seedboxes: [{ kind: 'utorrent', name: 'x', url: 'http://x' }] })).toThrow(/unknown seed box/)
    expect(p({ seedboxes: [{ kind: 'deluge', name: 'a', url: 'http://x' }, { kind: 'deluge', name: 'a', url: 'http://y' }] })).toThrow(/duplicate/)
    expect(p({ seedboxes: [{ kind: 'qbittorrent', name: 'bad name', url: 'http://x' }] })).toThrow(/name/)
    expect(
      p({ webseed: { kind: 's3', endpoint: 'https://e', bucket: 'b', region: 'auto', publicBaseUrl: 'https://p' }, seedboxes: [{ kind: 'rtorrent', name: 'rt', url: 'http://x', directory: '/d' }] })
    ).toThrow(/rtorrent cannot use webseeds/)
    expect(() => defineConfig({ sites, relays: ['https://not-ws'] })).toThrow(/ws\(s\)/)
    expect(() => defineConfig({ sites, scrape: 'some' as 'all' })).toThrow(/scrape/)
  })
})
