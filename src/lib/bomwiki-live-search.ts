/**
 * bomwiki-live-search.ts
 *
 * Uses the bundled 176K slug index for instant search.
 * No network calls needed — all data is local.
 */

import { bomwikiUrl, searchBomwikiSlug } from './bomwiki-catalog.js';

export async function searchBomwikiLive(partName: string): Promise<{ slug: string; url: string } | null> {
  const slug = searchBomwikiSlug(partName);
  return slug ? { slug, url: bomwikiUrl(slug) } : null;
}

export async function searchBomwikiLiveMulti(
  partName: string,
  _limit = 5,
  _extraPrefixes: string[] = [],
): Promise<{ slug: string; url: string; name: string }[]> {
  // With the bundled index, we just return the single best match from local search
  const slug = searchBomwikiSlug(partName);
  if (!slug) return [];
  return [{ slug, url: bomwikiUrl(slug), name: partName }];
}
