/**
 * bomwiki-catalog.ts
 *
 * Uses a bundled index of 176,882 real bomwiki.com slugs.
 * Every slug is verified to exist on bomwiki.com.
 * 
 * searchBomwikiSlug(partName) scans the index for the best match.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let SLUGS: string[] | null = null;
let SLUG_SET: Set<string> | null = null;

/** Load all 176K slugs into memory (~5MB) */
function loadSlugs(): string[] {
  if (SLUGS) return SLUGS;
  try {
    SLUGS = JSON.parse(readFileSync(join(process.cwd(), 'public', 'bomwiki-slugs.json'), 'utf-8'));
    SLUG_SET = new Set(SLUGS);
  } catch {
    SLUGS = [];
    SLUG_SET = new Set();
  }
  return SLUGS ?? [];
}

function getSet(): Set<string> {
  loadSlugs();
  return SLUG_SET!;
}

/** Returns true if the given slug exists in the bundled bomwiki index. */
export function slugExists(slug: string): boolean {
  if (!slug) return false;
  return getSet().has(slug);
}

export function searchBomwikiSlug(partName: string): string | null {
  const all = loadSlugs();
  if (all.length === 0) return null;

  const raw = partName.toLowerCase().trim();
  const norm = raw.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  const words = raw.split(/\s+/);
  // Generate stemmed variants (handle plurals like "tines" → "tine")
  const wordVariants = words.flatMap(w => {
    const v = [w];
    if (w.endsWith('es') && w.length > 4) {
      v.push(w.slice(0, -1)); // "tines" → "tine"
      v.push(w.slice(0, -2)); // "boxes" → "box" 
    } else if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) {
      v.push(w.slice(0, -1)); // "racks" → "rack"
    }
    return v;
  });
  if (norm.length < 3) return null;

  const set = getSet();

  // 1) Exact match (try stemmed variants too e.g. "tines" → "tine")
  if (set.has(norm)) return norm;
  // Try stemmed variants (handle plurals)
  const stemmedNorm = words.map(w => {
    if (w.endsWith('es') && w.length > 4) return w.slice(0, -1); // "tines" → "tine"
    if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }).join('-');
  if (stemmedNorm !== norm && set.has(stemmedNorm)) return stemmedNorm;

  let best: string | null = null;
  const pick = (s: string) => { if (!best || s.length < best.length) best = s; };

  // 2) All words match exactly in slug tokens (with stem handling)
  for (const slug of all) {
    const sw = slug.split('-');
    if (words.every((w) => {
      const stems = [w];
      if (w.endsWith('es') && w.length > 4) { stems.push(w.slice(0, -1)); stems.push(w.slice(0, -2)); }
      else if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) { stems.push(w.slice(0, -1)); }
      return stems.some((s) => sw.includes(s));
    })) pick(slug);
  }
  if (best) return best;

  // 3) All words partially match
  for (const slug of all) {
    const sw = slug.split('-');
    if (words.every((w) => sw.some((s) => s.includes(w)))) pick(slug);
  }
  if (best) return best;

  // 4) Scoring fallback
  let scored: { slug: string; score: number }[] = [];
  for (const slug of all) {
    const sw = slug.split('-');
    let score = 0;
    let matched = 0;
    for (const w of words) {
      const stems = [w];
      if (w.endsWith('es') && w.length > 4) { stems.push(w.slice(0, -1)); stems.push(w.slice(0, -2)); }
      else if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) { stems.push(w.slice(0, -1)); }
      if (stems.some((s) => sw.includes(s))) { score += 100; matched++; }
      else if (sw.some((s) => s.includes(w) && s.length > w.length)) { score += 30; matched++; }
      else if (w.length >= 4 && sw.some((s) => s.length >= 3 && w.includes(s) && w.length > s.length + 1)) { score += 5; matched++; }
    }
    if (matched > 0) {
      const lengthPenalty = Math.max(0, (slug.length - raw.length * 2) * 2);
      scored.push({ slug, score: score - lengthPenalty });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.slug.length - b.slug.length);
  if (scored.length > 0) return scored[0].slug;

  return null;
}

export function normalizeBomwikiUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  const m = rawUrl.match(/bomwiki\.com\/item\/([^/]+)\/?/i);
  let slug = m ? m[1] : rawUrl;
  slug = slug.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!slug) return null;
  if (getSet().has(slug)) return bomwikiUrl(slug);
  return null;
}

export function bomwikiUrl(slug: string): string {
  return `https://bomwiki.com/item/${slug}/`;
}

export function bomwikiUrlFromName(partName: string): string | null {
  const slug = searchBomwikiSlug(partName);
  return slug ? bomwikiUrl(slug) : null;
}

export function buildCatalogSummary(): string {
  const key = ['fastener-set','connector','pcb-bare','ball-bearing','mcu',
    'wire-bundle','relay','smd-passives','neodymium-magnet','copper-winding',
    'hydraulic-cylinder','turbocharger','hydraulic-motor','check-valve',
    'centrifugal-pump','gear-pump','diaphragm-pump',
    'butterfly-valve','gate-valve','globe-valve','drain-pump','heating-element',
    'screw-conveyor','fire-extinguisher','work-light','bulldozer-blade',
    'bulldozer-cab','bulldozer-sprocket','bulldozer-ripper',
    'bulldozer-track-chain','excavator-bucket','excavator-cab'];
  return key.join(', ');
}
