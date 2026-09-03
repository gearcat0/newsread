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
