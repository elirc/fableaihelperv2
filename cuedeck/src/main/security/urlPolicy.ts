import { EXTERNAL_LINK_ALLOWLIST } from '../../shared/constants';

/** Pure URL policy shared by window security and tests (no Electron imports). */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return EXTERNAL_LINK_ALLOWLIST.some((allowed) => {
    const a = new URL(allowed);
    return url.hostname === a.hostname && url.pathname.startsWith(a.pathname);
  });
}
