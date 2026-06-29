/**
 * agents.ts
 *
 * Defines the 4 specialized agents that compose a Bill of Vision
 * pipeline. Each agent:
 *   - takes a shared system prompt
 *   - receives the same video frames (or a parts list from a prior agent)
 *   - returns a JSON object matching a documented schema
 *
 * All agents are powered by Gemma 4 31B IT via the Google AI
 * generateContent API. We use response_mime_type=application/json
 * with a JSON schema to enforce structured output.
 *
 * Why 4 agents: 1) detector focuses on identification, 2) geometry
 * focuses on sizing/material, 3) mapper focuses on canonical naming,
 * 4) reporter synthesizes everything into a hierarchical BOM. Each
 * can fail independently and we degrade gracefully.
 */

import type { Frame } from './video_framer.js';
import { searchBomwikiSlug, normalizeBomwikiUrl, bomwikiUrl, bomwikiUrlFromName, buildCatalogSummary } from './bomwiki-catalog.js';

// ---- AGENTIC RE-RANKER ----

const RERANK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          part_name: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['part_name', 'slug'],
      },
    },
  },
  required: ['picks'],
} as const;

/**
 * Ask Gemma to pick the best bomwiki slug for each part from candidates.
 * One API call handles all parts. Falls back to first candidate on error.
 */
async function agenticRerank(
  apiKey: string,
  product: string,
  items: { name: string; candidates: { name: string; slug: string; desc: string }[] }[],
): Promise<Map<string, string>> {
  const picks = new Map<string, string>();
  if (!items.length) return picks;

  const sections = items.map((item, i) => {
    const candText = item.candidates
      .map((c, j) => `  ${j + 1}. slug="${c.slug}" name="${c.name}"`)
      .join('\n');
    return `Part ${i + 1}: "${item.name}"\nCandidates:\n${candText}`;
  });

  const userText = `Product: "${product}".\nFor each part, pick the BEST matching slug from its candidates.\nConsider the product context when choosing.\nReturn empty string if no candidate fits.\n\n${sections.join('\n\n')}\n\nJSON: {"picks":[{"part_name":"...","slug":"..."},...]}`;

  try {
    const body = {
      model: 'gemma-4-31b',
      messages: [
        { role: 'system' as const, content: 'Pick the correct bomwiki slug for each part. Think carefully about what the part is and which slug matches.' },
        { role: 'user' as const, content: userText },
      ],
      reasoning_effort: 'medium',
      temperature: 0.1,
      max_tokens: 1024,
    };

    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) return picks;

    const data = (await res.json()) as any;
    const text = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response
    let parsed: any;
    const cleaned = text.replace(/```(?:json)?\s*|\s*```/g, '').trim();
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch { return picks; }
      else return picks;
    }

    for (const pick of parsed.picks || []) {
      if (pick.slug && pick.part_name) {
        picks.set(pick.part_name, pick.slug);
      }
    }
  } catch { /* re-rank failed */ }

  return picks;
}

// ---- JSON SCHEMAS ----
// These are passed to response_schema on the generateContent call.
// We keep them simple and validate on the client side as well.

export const PART_SCHEMA = {
  type: 'object',
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          quantity: { type: 'integer' },
          confidence: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['name', 'category', 'quantity', 'confidence'],
      },
    },
  },
  required: ['parts'],
} as const;

export const GEOMETRY_SCHEMA = {
  type: 'object',
  properties: {
    scale_class: {
      type: 'string',
      enum: ['mini', 'compact', 'standard', 'industrial', 'heavy'],
    },
    estimated_length_mm: { type: 'number' },
    estimated_width_mm: { type: 'number' },
    estimated_height_mm: { type: 'number' },
    estimated_weight_kg: { type: 'number' },
    primary_materials: { type: 'array', items: { type: 'string' } },
    environment: { type: 'string' },
  },
  required: ['scale_class', 'primary_materials', 'environment'],
} as const;

export const MAPPER_SCHEMA = {
  type: 'object',
  properties: {
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          local_name: { type: 'string' },
          bomwiki_slug: { type: 'string' },
          bomwiki_category: { type: 'string' },
          reuse_estimate: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['local_name', 'bomwiki_slug', 'bomwiki_category', 'confidence'],
      },
    },
  },
  required: ['mappings'],
} as const;

export const REPORTER_SCHEMA = {
  type: 'object',
  properties: {
    product: { type: 'string' },
    summary: { type: 'string' },
    bom: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'integer' },
          material: { type: 'string' },
          bomwiki_url: { type: 'string' },
          sub_assembly: { type: 'string' },
          confidence: { type: 'number' },
          note: { type: 'string' },
          vendor: { type: 'string' },
          detected_text: { type: 'string' },
          detected_language: { type: 'string' },
          translation: { type: 'string' },
          detection_influence: { type: 'string' },
          frame_index: { type: 'integer' },
          frame_timestamp: { type: 'number' },
        },
        required: ['name', 'quantity', 'bomwiki_url', 'sub_assembly', 'frame_index', 'frame_timestamp'],
      },
    },
    total_parts: { type: 'integer' },
    notes: { type: 'string' },
  },
  required: ['product', 'summary', 'bom', 'total_parts'],
} as const;

// ---- SYSTEM PROMPTS ----

export const DETECTOR_PROMPT = `You are a mechanical parts identification expert. You will receive a sequence of video frames showing a single machine in operation (an excavator, mixer, appliance, etc.).

Your job is to identify every distinct visible component, sub-assembly, and part you can see across the frames. For each part, output:
- name: the most common technical name
- category: engine | hydraulic | structural | fastener | electrical | hydraulic-fluid | control | wear-part | cosmetic | other
- quantity: how many of this part are visible across all frames
- confidence: 0-1, how sure you are this is the correct part
- notes: short description (max 60 chars)
- Combine observations from multiple frames — if a part is clearer in one frame, use that for naming.
- Generic parts (screws, bolts, washers) should be batched as "Fastener Set" with an approximate count.

READ THE LABELS — multilingual evidence (this is the "proof of looking" step):
- Many machines carry a nameplate, rating plate, model sticker, decal, or engraved marking. READ IT.
- If a label is legible in ANY frame, copy its text VERBATIM into detected_text — preserve the ORIGINAL script exactly as printed (e.g. "三菱重工業", "Siemens", "MADE IN JAPAN", "ES-A88V4-3", "MITSUBISHI", "Kt67"). Do not romanize, do not retype it in English, do not summarize — quote it.
- detected_language: name the script's language (e.g. "Japanese", "Chinese", "German", "English", "Korean", "numeric/serial", "unknown"). Empty only if no label is legible.
- translation: provide an English translation ONLY when detected_text is non-English. For pure model numbers / serials / Latin-script English, leave it empty.
- detection_influence: one short clause on how reading this text affected the identification. e.g. "confirmed manufacturer: Mitsubishi", "matched model number to product family", "read part code for exact slug". Empty if no label was readable on that part — never invent it.
- These four fields are OPTIONAL but HIGH VALUE. A part with no visible label should simply omit them. Do not hallucinate text that is not actually on the part.

The extended JSON schema is: {"parts":[{"name":"...","category":"...","quantity":1,"confidence":0.9,"notes":"...","detected_text":"三菱重工業","detected_language":"Japanese","translation":"Mitsubishi Heavy Industries","detection_influence":"confirmed manufacturer"}]}
Output ONLY valid JSON. No markdown, no prose.`;

export const GEOMETRY_PROMPT = `You are a senior mechanical engineer. You will receive video frames of a machine.

Estimate the machine's:
- scale_class: mini (<10kg), compact (10-50kg), standard (50-500kg), industrial (500kg-5t), heavy (>5t)
- estimated_length_mm, estimated_width_mm, estimated_height_mm: bounding-box dimensions
- estimated_weight_kg
- primary_materials: array of dominant materials (steel, aluminum, plastic, cast iron, copper, rubber, etc.)
- environment: where would this be used (construction site, factory floor, kitchen, lab, etc.)

Use visual cues: human operators (if present), known reference objects, gauge sizes, wear patterns.

Output ONLY valid JSON matching the schema. No prose.`;

export const MAPPER_PROMPT = `You are a manufacturing knowledge-graph expert familiar with bomwiki.com — a free public bill-of-materials encyclopedia with 192,471 items and 30M+ parts mapped.

You will receive a list of mechanical part names identified from a video. For each, return the correct bomwiki.com slug.

## Known bomwiki catalog (prefer these exact slugs when applicable):

${buildCatalogSummary()}

## Rules:
- Match each input part to the closest entry in the catalog above whenever possible and return its EXACT slug.
- If a part has no exact match in the catalog above, construct a slug following bomwiki's convention: lowercase, hyphen-separated words (e.g. "heating-element", "door-gasket", "spray-arm").
- bomwiki_category must be one of: fastener, rotating, engine, hydraulic, electrical, structural, control, wear-part, cosmetic, fluid, pneumatic, or other.
- reuse_estimate: how broadly used (e.g. "3,500+ products", "specialized"). For catalog parts, use the actual reuse count from the catalog when available.
- confidence: 0-1. Higher for exact catalog matches, medium for constructed slugs.

Output ONLY valid JSON matching the schema. No prose.`;

export const REPORTER_PROMPT = `You are a senior mechanical engineer writing a bill of materials (BOM) for a manufacturing database. You will receive:
1. A list of identified parts (from a parts detection agent)
2. Geometry data (scale, dimensions, materials)
3. BOMwiki canonical references for each part — already mapped to real bomwiki slugs with full URLs
4. The original video frames with timestamps (for final verification)

For each part's bomwiki_url field, copy the exact URL from the BOMwiki mappings provided in the user text. Do not invent URLs.

CRITICAL — per-part frame attribution (required by the schema):
- Every part MUST have a frame_index and frame_timestamp. The schema enforces this.
- frame_index is the 0-based index of the single frame where this part is most clearly visible.
- frame_timestamp is the seconds value of that frame (e.g. 8.1 means 8.1s into the video).
- CRITICAL: Different parts should be attributed to DIFFERENT frames when the video shows them at different times. If part A is visible in frame 03 and part B is visible in frame 07, set part A's frame_index to 3 and part B's frame_index to 7.
- It's OK for multiple parts to share a frame if they're all visible there, but vary the attribution across the 12 frames when possible — use the frame list provided.
- Do NOT default every part to the same frame. The user relies on this data to navigate from a frame to the parts seen in it.

CARRY THE EVIDENCE THROUGH — multilingual proof of looking:
- If the Detector reported detected_text / detected_language / translation / detection_influence for a part, copy those four fields onto that BOM row VERBATIM. Do not re-translate, do not "improve", do not invent new evidence the Detector did not report.
- If a part has NONE of these fields, omit them on the BOM row too. Never fabricate detected_text.
- If ANY part carries detected_text, mention the strongest reading in the product summary or notes — e.g. "Nameplate reads 三菱重工業 — confirms Mitsubishi Heavy Industries as the manufacturer." Keep it short.

Produce a final, hierarchical BOM JSON containing:
- product: best guess at what this machine is
- summary: 1-2 sentence description
- bom: array of parts, each with name, quantity, material, bomwiki_url, sub_assembly (parent group), confidence, optional note, frame_index, and frame_timestamp
- total_parts: integer count of all parts identified (including fasteners and sub-components)
- notes: any caveats, assumptions, or things the human should verify

Group related parts into sub_assemblies.

Output ONLY valid JSON matching the schema. No prose.`;

// ---- TYPES ----

export interface AgentResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface PartItem {
  name: string;
  category: string;
  quantity: number;
  confidence: number;
  notes?: string;
  /** Verbatim text read off any visible label/nameplate/decal, in the
   *  original script. Empty when no text is legible on the part. */
  detected_text?: string;
  /** Language of detected_text (ISO-ish name, e.g. "Japanese", "English"). */
  detected_language?: string;
  /** English translation of detected_text, when non-English. */
  translation?: string;
  /** Short phrase: how reading this text influenced the identification
   *  (e.g. "confirmed manufacturer", "matched model string"). May be empty
   *  if no label was readable — never invent it. */
  detection_influence?: string;
}

export interface GeometryResult {
  scale_class: string;
  estimated_length_mm?: number;
  estimated_width_mm?: number;
  estimated_height_mm?: number;
  estimated_weight_kg?: number;
  primary_materials: string[];
  environment: string;
}

export interface MappingItem {
  local_name: string;
  bomwiki_slug: string;
  bomwiki_category: string;
  reuse_estimate: string;
  confidence: number;
}

export interface BomItem {
  name: string;
  quantity: number;
  material?: string;
  bomwiki_url: string;
  sub_assembly: string;
  confidence: number;
  note?: string;
  /** Manufacturer / brand name READ OFF a visible nameplate or decal
   *  in the video. Populated ONLY from the Detector's detected_text
   *  when that reading is a manufacturer name. Never invented. Empty
   *  when no readable brand marking is present for this part. */
  vendor?: string;
  detected_text?: string;
  detected_language?: string;
  translation?: string;
  detection_influence?: string;
}

export interface BomReport {
  product: string;
  summary: string;
  bom: BomItem[];
  total_parts: number;
  notes: string;
}

// ---- GEMMA API CALL ----

interface GenerateOptions {
  model: string;
  apiKey: string;
  systemPrompt: string;
  userText: string;
  frames: Frame[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: boolean;
}

interface GenerateResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

async function callCerebras(opts: GenerateOptions): Promise<GenerateResponse> {
  const start = Date.now();
  const allFrames = opts.frames || [];

  // Cerebras hard limit of 5 images per request. Split into batches.
  const BATCH = 5;
  const frameBatches: Frame[][] = [];
  for (let i = 0; i < allFrames.length; i += BATCH) {
    frameBatches.push(allFrames.slice(i, i + BATCH));
  }
  if (frameBatches.length === 0) frameBatches.push([]);

  // Run batches IN PARALLEL — each gets the same system prompt + user text
  const results = await Promise.all(
    frameBatches.map(async (batchFrames) => {
      const content: any[] = [];
      for (const f of batchFrames) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${f.mimeType};base64,${f.base64}` },
        });
      }
      content.push({ type: 'text', text: opts.userText });

      const body: any = {
        model: opts.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
      };
      if (opts.reasoning) body.reasoning_effort = 'medium';

      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Cerebras API error (${res.status}): ${detail.slice(0, 500)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      return {
        text: data.choices?.[0]?.message?.content ?? '',
        inTokens: data.usage?.prompt_tokens ?? 0,
        outTokens: data.usage?.completion_tokens ?? 0,
      };
    })
  );

  // Merge: parse each batch's JSON, merge arrays, re-stringify
  if (results.length === 1) {
    return {
      text: results[0].text,
      inputTokens: results[0].inTokens,
      outputTokens: results[0].outTokens,
      latencyMs: Date.now() - start,
    };
  }

  let merged: any = null;
  for (const r of results) {
    try {
      const parsed = JSON.parse(r.text.replace(/```(?:json)?\s*|\s*```/g, '').trim());
      if (!merged) { merged = parsed; continue; }
      for (const key of Object.keys(parsed)) {
        if (Array.isArray(merged[key]) && Array.isArray(parsed[key])) {
          // Deduplicate by 'name' field if it exists
          const existing = new Set(merged[key].map((i: any) => i.name?.toLowerCase()));
          for (const item of parsed[key]) {
            if (!item.name || !existing.has(item.name.toLowerCase())) {
              merged[key].push(item);
              if (item.name) existing.add(item.name.toLowerCase());
            }
          }
        } else if (typeof merged[key] === 'number' && typeof parsed[key] === 'number') {
          merged[key] = Math.max(merged[key], parsed[key]);
        }
      }
    } catch {
      if (!merged) merged = { text: r.text };
    }
  }

  const mergedText = merged ? JSON.stringify(merged) : results[0].text;
  const totalIn = results.reduce((s, r) => s + r.inTokens, 0);
  const totalOut = results.reduce((s, r) => s + r.outTokens, 0);

  return {
    text: mergedText,
    inputTokens: totalIn,
    outputTokens: totalOut,
    latencyMs: Date.now() - start,
  };
}

function safeJson<T>(text: string): { ok: true; data: T } | { ok: false; error: string } {
  // Strip markdown code block markers (Cerebras wraps JSON in ```json)
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  try {
    return { ok: true, data: JSON.parse(cleaned) as T };
  } catch {
    // Try to recover by extracting the first {...} or [...] block
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return { ok: true, data: JSON.parse(objMatch[0]) as T }; } catch {}
    }
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return { ok: true, data: JSON.parse(arrMatch[0]) as T }; } catch {}
    }
    return { ok: false, error: `Could not parse JSON. Raw: ${cleaned.slice(0, 300)}` };
  }
}

// ---- INDIVIDUAL AGENTS ----

export async function runDetector(
  apiKey: string,
  model: string,
  frames: Frame[]
): Promise<AgentResult<{ parts: PartItem[] }>> {
  try {
    const r = await callCerebras({
      model,
      apiKey,
      systemPrompt: DETECTOR_PROMPT,
      userText:
        'These are evenly-spaced frames from a single video of one machine. Identify every visible part. Output JSON only.',
      frames,
      maxTokens: 2048,
    });
    const parsed = safeJson<{ parts: PartItem[] }>(r.text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, latency_ms: r.latencyMs };
    }
    return {
      ok: true,
      data: parsed.data,
      latency_ms: r.latencyMs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latency_ms: 0 };
  }
}

export async function runGeometry(
  apiKey: string,
  model: string,
  frames: Frame[]
): Promise<AgentResult<GeometryResult>> {
  try {
    const r = await callCerebras({
      model,
      apiKey,
      systemPrompt: GEOMETRY_PROMPT,
      userText:
        'Estimate scale, dimensions, materials, and environment from these video frames. Output JSON only.',
      frames,
      maxTokens: 1024,
    });
    const parsed = safeJson<GeometryResult>(r.text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, latency_ms: r.latencyMs };
    }
    return {
      ok: true,
      data: parsed.data,
      latency_ms: r.latencyMs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latency_ms: 0 };
  }
}

export async function runMapper(
  apiKey: string,
  model: string,
  partNames: string[]
): Promise<AgentResult<{ mappings: MappingItem[] }>> {
  try {
    const r = await callCerebras({
      model,
      apiKey,
      systemPrompt: MAPPER_PROMPT,
      userText: `Map each of these part names to a bomwiki.com URL slug. Parts:\n${partNames
        .map((n, i) => `${i + 1}. ${n}`)
        .join('\n')}\n\nOutput JSON only.`,
      frames: [], // text-only
      maxTokens: 2048,
    });
    const parsed = safeJson<{ mappings: MappingItem[] }>(r.text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, latency_ms: r.latencyMs };
    }
    return {
      ok: true,
      data: parsed.data,
      latency_ms: r.latencyMs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latency_ms: 0 };
  }
}

export async function runReporter(
  apiKey: string,
  model: string,
  frames: Frame[],
  parts: PartItem[],
  geometry: GeometryResult,
  mappings: MappingItem[]
): Promise<AgentResult<BomReport>> {
  try {
    // Safety: ensure all params are arrays
    const safeFrames = frames || [];
    const safeParts = parts || [];
    const safeMappings = mappings || [];
    
    const userText = `Build the final BOM from these inputs:

**Identified parts (${safeParts.length}):**
${safeParts.map((p) => {
  const ev = p.detected_text ? ` · label:「${p.detected_text}」${p.detected_language ? ` (${p.detected_language})` : ''}${p.translation ? ` → "${p.translation}"` : ''}${p.detection_influence ? ` — ${p.detection_influence}` : ''}` : '';
  return `- ${p.name} (qty ${p.quantity}, conf ${p.confidence.toFixed(2)})${ev}`;
}).join('\n')}

**Video frames available for attribution (${safeFrames.length} total):**
${safeFrames.map((f) => `  Frame ${f.index}: ${f.timestamp.toFixed(1)}s`).join('\n')}

For each part below, set frame_index to the 0-based index of the single frame where that part is most clearly visible, and frame_timestamp to that frame's seconds value. **Vary the attribution across frames — do NOT default every part to the same frame.** The 12 frames show the machine at different moments; parts visible early should get low frame_index, parts visible later should get high frame_index.

**Multilingual evidence (CRITICAL — carry through verbatim):** Several parts above include a "label:「…」" reading. For each such part, copy its detected_text, detected_language, translation, and detection_influence VERBATIM onto the corresponding BOM row. A row with no label reading in the list above should have those fields empty/omitted — do not fabricate readings.

**Geometry:**
${JSON.stringify(geometry, null, 2)}

**BOMwiki mappings (${safeMappings.length}):**
${safeMappings.map((m) => `- ${m.local_name} → https://bomwiki.com/item/${m.bomwiki_slug}/ (${m.bomwiki_category}, conf ${m.confidence.toFixed(2)})`).join('\n')}

**Reference:** Original video frames are attached to this call for final verification. Use them to confirm the frame_index you assign to each part, and double-check any nameplate readings copied above.

Output JSON only. Group parts into sub_assemblies. Every part MUST include frame_index and frame_timestamp.`;

    const r = await callCerebras({
      model,
      apiKey,
      systemPrompt: REPORTER_PROMPT,
      userText,
      frames, // reporter sees the original frames too, for verification
      maxTokens: 8192,
      reasoning: true,
    });
    const parsed = safeJson<BomReport>(r.text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, latency_ms: r.latencyMs };
    }

    // Post-process BOM: agentic re-rank picks the best slug for every part.
    if (parsed.data.bom && parsed.data.bom.length > 0) {
      const productName = parsed.data?.product || 'machine';

      // Load names map for rich candidate search
      let namesMap: Record<string, string> = {};
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        namesMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'bomwiki-names.json'), 'utf-8'));
      } catch {}

      const itemsWithCandidates = parsed.data.bom.map((item) => {
        const partWords = item.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 1);
        const candSet = new Set<{ slug: string; name: string }>();

        const addCandidate = (slug: string) => {
          if (slug && !Array.from(candSet).some(c => c.slug === slug)) {
            candSet.add({ slug, name: (namesMap[slug] || slug).replace(/-/g, ' ') });
          }
        };

        // Direct search
        const direct = searchBomwikiSlug(item.name);
        if (direct) addCandidate(direct);

        // Individual word searches
        for (const w of partWords) {
          if (w.length < 3) continue;
          const s = searchBomwikiSlug(w);
          if (s) addCandidate(s);
        }

        // Search names map for display names containing the part name
        if (namesMap && item.name.length >= 4) {
          const lower = item.name.toLowerCase();
          for (const [slug, displayName] of Object.entries(namesMap)) {
            if (candSet.size >= 12) break;
            if ((displayName as string).toLowerCase().includes(lower)) {
              addCandidate(slug);
            }
          }
        }

        // Product-context combos
        const pw = productName.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
        for (const p of pw) {
          for (const iw of partWords) {
            if (iw.length < 3) continue;
            const s = searchBomwikiSlug(`${p} ${iw}`);
            if (s) addCandidate(s);
          }
        }

        return {
          name: item.name,
          candidates: Array.from(candSet).slice(0, 8).map((c) => ({
            name: c.name,
            slug: c.slug,
            desc: '',
          })),
        };
      }).filter((i) => i.candidates.length > 0);

      if (itemsWithCandidates.length > 0) {
        const picks = await agenticRerank(apiKey, productName, itemsWithCandidates);
        for (const item of parsed.data.bom) {
          const pick = picks.get(item.name);
          if (pick) {
            item.bomwiki_url = bomwikiUrl(pick);
          } else {
            const fromName = bomwikiUrlFromName(item.name);
            item.bomwiki_url = fromName || '';
          }
        }
      }
    }

    return {
      ok: true,
      data: parsed.data,
      latency_ms: r.latencyMs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latency_ms: 0 };
  }
}
