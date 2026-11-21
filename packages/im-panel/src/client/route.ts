/**
 * The page's own route: `#im/<tab>` opens a tab, `#im` the overview. Any other hash belongs to the shell or another
 * plugin and is left alone.
 *
 * @module dsh-im-panel/client/route
 */

import { useCallback, useEffect, useState } from 'react'

const PREFIX = '#im'

/**
 * The tab a hash names.
 * @param hash - defaults to `location.hash`.
 * @returns the tab id, `overview` for `#im` or anything unparsable.
 */
export function parseHash(hash: string = location.hash): string {
  const match = /^#im(?:\/([a-z][a-z0-9-]*))?$/.exec(hash)
  return match?.[1] ?? 'overview'
}

/** Whether a hash names this page. */
export function isPageHash(hash: string = location.hash): boolean {
  return hash === PREFIX || hash.startsWith(`${PREFIX}/`)
}

/** The hash of one tab. */
export function hashOf(tab: string): string {
  return `${PREFIX}/${tab}`
}

/** Track the current tab, and navigate by rewriting the hash. */
export function useRoute(): readonly [string, (tab: string) => void] {
  const [tab, setTab] = useState<string>(() => parseHash())
  useEffect(() => {
    const onChange = (): void => { if (isPageHash()) setTab(parseHash()) }
    addEventListener('hashchange', onChange)
    return () => { removeEventListener('hashchange', onChange) }
  }, [])
  const go = useCallback((next: string) => {
    if (location.hash !== hashOf(next)) history.pushState(null, '', hashOf(next))
    setTab(next)
  }, [])
  return [tab, go] as const
}
