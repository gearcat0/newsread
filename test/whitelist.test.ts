import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileWhitelist, SshWhitelist } from '../src/publish/whitelist.js'
import type { SshRunner } from '../src/publish/webseed.js'

const tmp = (): string => mkdtempSync(join(process.env['NEWSREAD_TEST_TMP'] ?? tmpdir(), 'newsread-wl-'))
const A = 'ab'.repeat(20)
const B = 'cd'.repeat(20)
const HEAD = '# opentracker whitelist\n# one hash per line\n'

describe('tracker whitelist', () => {
  it('file: adds once, removes, keeps the comments', async () => {
    const file = join(tmp(), 'whitelist.txt')
    writeFileSync(file, HEAD.trimEnd()) // no trailing newline, as an editor may leave it
    const w = new FileWhitelist({ file })
    await w.add(A)
    await w.add(A)
    await w.add(B)
    expect(readFileSync(file, 'utf8')).toBe(`${HEAD}${A}\n${B}\n`)
    await w.remove(A)
    await w.remove(A)
    expect(readFileSync(file, 'utf8')).toBe(`${HEAD}${B}\n`)
    await expect(w.add('AB'.repeat(20))).rejects.toThrow(/lowercase hex/)
  })

  it('ssh: the remote script does the same, run here through sh', async () => {
    const file = join(tmp(), "white list's.txt") // quoting, the hard way
    writeFileSync(file, HEAD.trimEnd())
    const commands: string[] = []
    // Run the command ssh would run remotely, locally.
    const ssh: SshRunner = async (args) => {
      expect(args.slice(-3, -1)).toEqual(['--', 'newsread@dev'])
      commands.push(args.at(-1)!)
      execFileSync('sh', ['-c', args.at(-1)!])
    }
    const w = new SshWhitelist({ host: 'newsread@dev', file, ssh })
    await w.add(A)
    await w.add(A)
    await w.add(B)
    expect(readFileSync(file, 'utf8')).toBe(`${HEAD}${A}\n${B}\n`)
    await w.remove(A)
    await w.remove(A)
    expect(readFileSync(file, 'utf8')).toBe(`${HEAD}${B}\n`)
    await w.remove(B)
    expect(readFileSync(file, 'utf8')).toBe(HEAD)
    expect(commands[0]).toMatch(/^flock /)
    expect(() => new SshWhitelist({ host: '-oProxyCommand=x', file, ssh })).toThrow(/bad ssh host/)
  })
})
