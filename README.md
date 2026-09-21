# newsread

A small, personal news archiver. It polls the RSS/Atom feeds of sites you read,
extracts each article, and writes it as a signed **`.thing`** bundle in the
`article` format that [Souspli](https://github.com/souspli/souspli) renders
(see [souspli.org](https://souspli.org)). Low
volume by design: one host at a time, a pause between requests, no crawling.

```
feeds ─▶ fetch ─▶ extract (Readability + JSON-LD/OG) ─▶ rich IR ─▶ download images
      ─▶ flatten to Souspli blocks ─▶ build + sign ─▶ self-verify ─▶ out/<site>/*.thing
```

## Setup

Requires Node ≥ 24 and pnpm.

```sh
git clone --recurse-submodules <this repo>   # or: git submodule update --init --depth 1
pnpm install
pnpm newsread init        # writes newsread.config.ts, creates the signing key, prints your author address
```

`vendor/souspli` is a git submodule pinned to a specific Souspli commit. The
scraper imports Souspli's `src/format` (canonical CBOR, bundle building, signing)
directly from it and ships `vendor/souspli/samples/article.html` byte-for-byte as
every article's program. **Bumping the submodule can change that program hash**,
and the reader groups things by `(type, program hash)`, so bump deliberately and
check the hash `newsread init` prints. The vendored code is Apache-2.0; see
`vendor/souspli/LICENSE` and `NOTICE`.

## Configure

Edit `newsread.config.ts`. Each site needs an `id`, the `hosts` its canonical
URLs live on, and its `feeds`; everything else is optional:

```ts
import { defineConfig } from './src/config.js'

export default defineConfig({
  sites: [
    {
      id: 'example',
      publisher: 'The Example Times',
      hosts: ['example.com'],
      feeds: ['https://example.com/world/rss'],
      removeSelectors: ['.newsletter-signup', '.related-stories'],
      urlFilter: (u) => !u.pathname.startsWith('/live/'),
      // articleSelector: 'article .body',    // bypass Readability
      // imagePolicy: { minWidth: 300, leadImage: 'always' },
      // prepare: (doc, url) => { ... },       // arbitrary DOM surgery before extraction
      // metadata: (meta) => ({ ...meta, section: 'World' }),
    }
  ]
})
```

Global options (with defaults) are in `src/config.ts`: `outDir: 'out'`,
`stateFile: 'state/newsread.json'`, `identityFile: '$XDG_CONFIG_HOME/newsread/identity.key'`,
`perHostDelayMs: 2000`, `timeoutMs: 20000`, `maxHtmlBytes: 3 MiB`, media caps,
and the block/byte limits that keep articles editable in the shell.

## Use

```sh
pnpm newsread run                       # poll every feed, archive what is new
pnpm newsread run --site example --limit 3 --dry-run
pnpm newsread fetch https://example.com/story/123   # one article, now
pnpm newsread inspect out/example/2026-09-03-some-story-1a2b3c4d.thing
pnpm newsread verify out                # every .thing admits as a well-formed article
pnpm newsread whoami                    # the author address the shell will show
```

Get an article into Souspli the way you get any thing in: double-click the
`.thing`, drag it into the window, **Open file…**, or paste
`file:///absolute/path/to/story.thing` in the omnibar. The feed row reads
`article`, the address `whoami` printed, and the article's title as the reader
sanitises it (one line, at most 80 characters, check-mark characters removed).

Re-running is cheap and idempotent. A story whose content has not changed emits
nothing; one that has changed becomes the next version in its chain
(`path`/`seq`/`prev` on the envelope). The reader collapses a chain to its latest
version, so a re-scraped story stays one row instead of piling up duplicates. Add `--refresh` to re-check stories already archived.
`--debug` writes `.args.json` and `.ir.json` sidecars beside each `.thing`.

## What survives, what does not

Souspli's article body is six block kinds of plain text plus named image/video
attachments. The extractor keeps a richer intermediate representation
(`src/ir.ts` — inline links, emphasis, lists, quotes, tables, code) and only
`src/flatten.ts` reduces it. Today that means:

- **Inline links are dropped** (the text stays; the href does not). This is a
  known gap in the format; when Souspli grows link support, `flatten.ts` is the
  one module to change.
- Lists become `• ` / `1. ` paragraphs; blockquotes are quoted; tables become
  ` | `-joined rows (large ones are footnoted instead); code becomes one
  paragraph per line.
- Images are downloaded, MIME-sniffed from their bytes, de-duplicated and
  attached as `img-1, img-2, …`. Failed images are dropped, not placeholdered.
- Videos and embeds become footnotes with their URL unless `media.video` is on
  and the video is a direct MP4/WebM file under the cap.
- Everything in the args is a string, dates are `YYYY-MM-DD` as the publisher
  wrote them (no timezone shifting), and `retrieved` is the local date you ran.

Metadata (`publisher`, `authors`, `published`, `sourceUrl`, …) is recorded as
found. Souspli shows it as a claim, and it is one.

## Politeness

Requests to one host are serialised with a gap (`perHostDelayMs`); feeds use
`ETag`/`Last-Modified` so an unchanged feed costs one 304; bodies are capped and
5xx/429 are retried once honouring `Retry-After`. The scraper does not read
`robots.txt` — it fetches, on your behalf, pages you would otherwise open in a
browser. Keep it to sites you actually read.

## Development

```sh
pnpm typecheck
pnpm test          # vitest, no network
```
