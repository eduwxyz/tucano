import { defaultUrlTransform } from 'react-markdown'
import { isOutsideLink } from '../../shared/links'
import { LOCAL_LINK } from '../../shared/path-text'

// What a link in markdown (a message, the wiki, a skill, a document) may point to: the web,
// an email, a place in the app (#wiki/…) or a file the core resolves (tucano-local:). A bare
// path would load as the app (file://), so it stays plain text. Images keep the default.
export function safeUrl(url: string, key: string): string | undefined {
  if (key !== 'href') return defaultUrlTransform(url)
  if (url.startsWith('#') || url.startsWith(LOCAL_LINK) || isOutsideLink(url)) return url
  return undefined
}
