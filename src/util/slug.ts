/** Filesystem-friendly slug: ASCII lowercase, hyphen-separated, cut on a hyphen
 *  boundary at `max` chars. Falls back to `untitled`. */
export function slugify(input: string | undefined, max = 60): string {
  const base = (input ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base) return 'untitled'
  if (base.length <= max) return base
  const cut = base.slice(0, max)
  const dash = cut.lastIndexOf('-')
  return (dash > max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/g, '') || 'untitled'
}
