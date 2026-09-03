// MIME from magic bytes. The response content-type is ignored entirely: cage
// serves attachments under nosniff, so a mislabelled blob simply does not
// render, and an allowlist keeps SVG/HTML out of the bundle.

const ascii = (b: Uint8Array, off: number, s: string): boolean => {
  if (b.length < off + s.length) return false
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false
  return true
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'])
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'm4v ', 'M4V ', 'mmp4', 'qt  '])

export function sniffMime(b: Uint8Array): string | undefined {
  if (b.length < 12) return undefined
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif'
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp'
  if (ascii(b, 0, 'BM')) return 'image/bmp'
  if (ascii(b, 4, 'ftyp')) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!)
    if (AVIF_BRANDS.has(brand)) return 'image/avif'
    if (HEIC_BRANDS.has(brand)) return 'image/heic'
    if (MP4_BRANDS.has(brand) || brand.startsWith('mp4') || brand.startsWith('3gp')) return 'video/mp4'
    return undefined
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  return undefined
}

export const isImageMime = (m: string | undefined): m is string => !!m && m.startsWith('image/')
export const isVideoMime = (m: string | undefined): m is string => !!m && m.startsWith('video/')

export const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/heic', 'video/mp4', 'video/webm'
])
