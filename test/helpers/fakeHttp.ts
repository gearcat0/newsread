import type { HttpClient, HttpRequestOptions, HttpResponse } from '../../src/http.js'

export interface FakeRoute {
  status?: number
  headers?: Record<string, string>
  body?: Uint8Array | string
  /** Pretend the request was redirected here. */
  finalUrl?: string
}

export type FakeRoutes = Record<string, FakeRoute | ((opts: HttpRequestOptions) => FakeRoute)>

export interface FakeHttp extends HttpClient {
  calls: { url: string; opts: HttpRequestOptions }[]
  routes: FakeRoutes
}

const enc = new TextEncoder()

/** Deterministic HttpClient: exact-URL routes, 404 for anything else. */
export function fakeHttp(routes: FakeRoutes): FakeHttp {
  const calls: FakeHttp['calls'] = []
  return {
    calls,
    routes,
    async get(url, opts = {}) {
      calls.push({ url, opts })
      const r = routes[url]
      const route = typeof r === 'function' ? r(opts) : r
      if (!route) return { status: 404, url, headers: new Headers(), body: new Uint8Array(0) }
      const body = route.body === undefined ? new Uint8Array(0) : typeof route.body === 'string' ? enc.encode(route.body) : route.body
      if (opts.maxBytes !== undefined && body.length > opts.maxBytes) throw new Error(`response too large (${body.length} > ${opts.maxBytes} bytes)`)
      const res: HttpResponse = {
        status: route.status ?? 200,
        url: route.finalUrl ?? url,
        headers: new Headers(route.headers ?? {}),
        body
      }
      return res
    }
  }
}
