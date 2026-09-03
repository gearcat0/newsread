// Politeness primitives. HostLimiter serialises requests to one host with a
// minimum gap between them (HTML and images share the same queue); Semaphore
// bounds concurrency across hosts.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface HostQueue {
  tail: Promise<void>
  last: number
}

export class HostLimiter {
  private readonly queues = new Map<string, HostQueue>()
  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const key = host.toLowerCase()
    const q = this.queues.get(key) ?? { tail: Promise.resolve(), last: -Infinity }
    this.queues.set(key, q)
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const prev = q.tail
    q.tail = mine
    await prev
    try {
      const wait = q.last + this.minGapMs - this.now()
      if (wait > 0) await sleep(wait)
      return await fn()
    } finally {
      q.last = this.now()
      release()
    }
  }
}

export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const sem = new Semaphore(Math.max(1, limit))
  return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))))
}
