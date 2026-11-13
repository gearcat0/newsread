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

## Publishing: articles to Souspli readers as they are fetched

`newsread serve` runs forever. It scrapes on an interval, puts every new article
on BitTorrent, announces it on a Nostr relay, and answers readers who write to it
asking to subscribe.

```
scrape ─▶ .thing ─▶ webseed (HTTPS) ─▶ .torrent (url-list → webseed) ─▶ seed boxes
       ─▶ one box has it all (or the webseed answers, after seedTimeoutMs)
       ─▶ kind-3400 pointer on the relay, signed by this account's relay key
relay  ─▶ sealed memo "subscribe guardian" ─▶ subscriber list ─▶ sealed reply
```

Why it is shaped like this:

- **Every article is a pointer.** The article program alone is over the 32 KiB
  inline cap, so the relay event carries the hash and a magnet, never the bytes.
- **The webseed is load-bearing.** It is how the bytes reach the seed boxes: they
  download from it as if it were a peer. It is also a source that always answers.
  The `.torrent` is published beside the file and named in the magnet as `xs=`.
  Without that, a reader who reaches no peer would wait for metadata forever, since
  a webseed serves bytes, not metadata. This was checked against the shell's own
  webtorrent, with no swarm.
- **Readers join the same swarm.** The torrent is single-file, named
  `article-<hash8>.thing`, with create-torrent's piece length. A Souspli reader who
  turns on seeding produces the **same infohash** (`test/torrent.test.ts` pins
  vectors from create-torrent 6.1.3).
- **Every article binds this account's relay key** (`Author.ek`, derived exactly as
  the Souspli keyring does). That is what lets a reader write privately to the bot,
  and what a subscribed reader's app checks a pointer against.

### What a reader does

1. Adds the relay in **File → Relays…**. The bot's **about memo** appears in their
   feed; it is small enough to travel whole. Each article appears as an offer with a
   **Fetch** button.
2. In **People**, presses **Subscribe…** on this account. Their app then fetches new
   articles as they are announced, from the feeds they choose. The same dialog
   starts a private memo, `subscribe guardian`, which they publish and send through
   the relay.
3. The bot answers with a sealed memo confirming what they will get.

Requests (subject, or first line of a private memo): `subscribe all`,
`subscribe <site> …`, `unsubscribe all`, `unsubscribe <site> …`, `list`. A request
must be **sealed to the bot**. A public memo, even one signed by the reader, is
ignored, because anyone could replay it. For each reader, the letter they wrote
latest wins.

With `scrape: 'subscribed'`, only sites somebody subscribed to (or marked
`always: true`) are scraped.

### Configure

```ts
export default defineConfig({
  relays: ['wss://news-relay.example.org'],
  about: { name: 'Example News', description: 'World news from the Guardian.' },
  scrape: 'subscribed',
  publish: {
    trackers: ['udp://tracker.example.org:6969/announce', 'udp://tracker.opentrackr.org:1337/announce'],
    // where the bytes are served from: a directory a web server serves…
    webseed: { kind: 'dir', dir: '/srv/www/things', baseUrl: 'https://seed.example.org/things' },
    // …or such a directory on another machine, written over ssh (key auth, no prompts;
    // one bounded ssh per file, so a dropped link fails the put rather than hanging):
    // webseed: { kind: 'ssh', host: 'newsread@seed', dir: '/srv/www/things', baseUrl: 'https://seed.example.org/things' },
    // …or an S3-compatible bucket (R2, B2, MinIO, AWS) with a public URL:
    // webseed: { kind: 's3', endpoint: 'https://<acct>.r2.cloudflarestorage.com', bucket: 'things',
    //            region: 'auto', publicBaseUrl: 'https://seed.example.org' },
    seedboxes: [
      { kind: 'qbittorrent', name: 'box1', url: 'http://box1:8080', savePath: '/data/things' },
      { kind: 'transmission', name: 'box2', url: 'http://box2:9091/transmission/rpc' },
      { kind: 'deluge', name: 'box3', url: 'http://box3:8112' },
      // rTorrent cannot download from webseeds: point it at the `dir` or `ssh` webseed's directory
      { kind: 'rtorrent', name: 'box4', url: 'https://box4/RPC2', directory: '/srv/www/things' }
    ],
    // seedTimeoutMs: 600000,   announce on the webseed alone if no box finishes by then
    // backlogDays: 2,          never publish the old archive when publishing is first turned on
  },
  sites: [ /* … */ ]
})
```

Credentials go in `$XDG_CONFIG_HOME/newsread/secrets.json`, mode **0600**. newsread
refuses to read it if anyone else can:

```json
{
  "seedboxes": { "box1": { "username": "admin", "password": "…" }, "box3": { "password": "…" } },
  "webseed": { "accessKeyId": "…", "secretAccessKey": "…" }
}
```

### The relay

Use a separate deployment of Souspli's relay (`relay/` in that repo, environment
`news`). Then put this account's relay key in its `TRUSTED_PUBKEYS`, so a burst of
articles is never rate-limited:

```sh
pnpm newsread relays     # checks each relay answers; prints the key to trust
```

### Commands

```sh
pnpm newsread serve [--every 10m] [--site id]   # the daemon
pnpm newsread publish        # one pass: stage, poll the boxes, announce what is ready
pnpm newsread inbox          # read sealed letters once and answer them (for cron)
pnpm newsread subscribers [--json]
pnpm newsread whoami         # the author address, and the relay key
```

State, including what is staged, announced, who subscribed and the relay cursors,
is kept in `state/newsread.json` (v2; a v1 file migrates on load). Each step
resumes where it stopped.

### Checking a seed box

```sh
pnpm newsread seedbox-check box1 [--timeout 3m] [--size 300k] [--keep]
```

This pushes a throwaway file through the same path a letter takes: onto the
webseed, into a torrent, onto that one box, and on to 100%. Then it removes both,
unless you pass `--keep`. Nothing is announced. Each failure names its step: the
webseed did not answer, the login was refused, or the box is stuck at 0%. Stuck
at 0% almost always means the box cannot reach the webseed URL, or the client
queued or stopped the torrent.

Live-tested against qBittorrent 4.6.3, Transmission 4.0.5, Deluge 2.1.2
(libtorrent 2.0.10) and rTorrent 0.9.8 behind nginx. Each passed with a 300 KB
and a 5 MiB file, a repeated add, and a repeated remove.

Things that went wrong while setting these up, and what newsread now says:

- A box name that doesn't match its `secrets.json` entry. qBittorrent and
  Deluge stop with `seed box <name> needs a password, but <file> has no
  seedboxes.<name>.password (it has …)`. Transmission and rTorrent can run
  without a login, so for them a 401 gets `(no seedboxes.<name> entry …, so no
  login was sent)` added.
- A Deluge password copied from `web.conf`. That is `pwd_sha1`, a salted hash;
  the Web UI wants the password itself.
- A JSON slip in `secrets.json`. The error gives the line and column, never the
  file's contents.
- rTorrent behind nginx answering 403 to a correct login. nginx can't open its
  `auth_basic_user_file`; check the name and that `www-data` can read it.

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
