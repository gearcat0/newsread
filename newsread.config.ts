import { defineConfig } from './src/config.js'

// Sites you read. Everything except id/hosts/feeds is optional — see src/config.ts.
export default defineConfig({
  sites: [
    {
      id: 'guardian',
      publisher: 'The Guardian',
      hosts: ['theguardian.com'],
      feeds: ['https://www.theguardian.com/world/rss'],
      urlFilter: (u) => !/\/live\/|\/video\/|\/gallery\/|\/audio\//.test(u.pathname)
    }
  ]
})
