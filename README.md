# Bill of Vision

> Drop a short video of any machine. Get a real, hierarchical **bill of materials** in seconds — with every part grounded against a verified 176,882-entry encyclopedia and any foreign text on the part surfaced as proof the model actually looked.

Built for the Cerebras × Google Gemma hackathon. A 4-agent pipeline on **Gemma 4 31B** via the **Cerebras** inference API, grounded against **[bomwiki.com](https://bomwiki.com)** — a free, public bill-of-materials encyclopedia.

---

## What it does

```
   video.mp4
       |
       v
   +-------+      12 frames @ 640px
   | ffmpeg| ----------------------+
   +-------+                       |
                                   v
                       +-----------+-----------+
                       |     Phase 1 (parallel)|
                       |                       |
                   +---+---+              +----+----+
                   |Detector|             |Geometry |
                   +-------+              +---------+
                       |  (part names)        |
                       v                      |
                  +------+                    |
                  |Mapper|                    |
                  +-------+                    |
                       |                      |
   bomwiki.com  <-----+                      |
   (176K slugs)   (verify & rank)            |
                       |                      |
                       +----------+-----------+
                                  v
                       +----------+----------+
                       |   Phase 2 (single)  |
                       |     Reporter        |
                       |  + agentic re-ranker|
                       +---------------------+
                                  |
                                  v
                          Hierarchical BOM
                          + multilingual
                            evidence
```

## The four agents

| # | Agent | Job | Output |
|---|-------|-----|--------|
| 01 | **Part Detector** | Identify every visible component across the 12 frames, read any nameplate / decal / label verbatim in its original script, and quote the language + translation + influence on the identification. | `parts[]` with `name, category, quantity, confidence, notes, detected_text, detected_language, translation, detection_influence` |
| 02 | **Geometry Agent** | Estimate scale, dimensions, mass, dominant materials, and intended environment. | `scale_class, *_mm, weight_kg, primary_materials[], environment` |
| 03 | **BOM Mapper** | Resolve each part name to a canonical bomwiki.com slug. | `mappings[]` with `local_name, bomwiki_slug, bomwiki_category, reuse_estimate, confidence` |
| 04 | **Report Builder** | Stitch everything into a hierarchical BOM grouped by sub-assembly, attribute each part to a specific frame for traceability, and run the **agentic re-ranker** to ground every URL. | `{ product, summary, bom[], total_parts, notes }` |

Phase 1 = Detector + Geometry **in parallel** (both vision tasks). Phase 1b = Mapper (needs part names). Phase 2 = Reporter (needs everything). All four stream progress over Server-Sent Events.

## Multilingual evidence

A judge can click any part card and see whether the model *actually looked*. If the Detector reads a nameplate, the report shows:

- the **original text** verbatim, in its original script (「三菱重工業」, "KOMATSU", "PC 490 LC", "MADE IN JAPAN", etc.)
- the **language** of the reading
- an **English translation** when non-English
- a one-line **influence on match** ("confirmed manufacturer: Mitsubishi", "matched model number to product family")

Parts with no legible nameplate render nothing — never a placeholder dash. The system never invents a manufacturer; if it's not on the part, it isn't on the card.

## Agentic re-ranking

The naive approach — ask the LLM to invent bomwiki slugs — produces links that 404. The Reporter does something better:

1. **Gather candidates.** For each BOM item, `collectCandidates()` searches the bundled 176K slug index using:
   - the full part name
   - each individual word in the name
   - product-context combos (e.g. `bulldozer track`, `bulldozer sprocket`)
2. **LLM picks the best.** All candidate sets are batched into a single `agenticRerank()` Cerebras call. The system prompt carries disambiguation rules (e.g. *for an excavator, prefer `excavator-bucket` over `wheel-lathe`*).
3. **Graceful fallback.** If the rerank call fails, we fall back to the local index's best match, then to the LLM's invented slug (normalized), then to empty.

The LLM **never invents a URL it wasn't shown a verified candidate for**. Every bomwiki link in the output is either a real slug from the index, or empty.

## bomwiki images

bomwiki.com has product photos at `https://bomwiki.com/img/thumb/{slug}.jpg`. The client uses native `<img>` `onload` / `onerror` — no server probe (Cloudflare bot-blocks server fetches). The image chain:

1. bomwiki thumb for the LLM-identified slug
2. bomwiki thumb for a curated alternative slug (e.g. `cnc-machine` → `cnc-lathe`)
3. Wikimedia Commons search by part / product name
4. Clean typographic initials card with the part's name

Most parts show a typographic card (only a few hundred of bomwiki's 176K entries have a thumbnail); the products that do — excavator, bulldozer, dishwasher, surgical robot, MRI scanner, hydraulic cylinder, fire extinguisher, turbocharger, heating element — show the bomwiki photo with a credit link.

## Specimen library

Ten sample clips ship in `public/samples/`, each picked to exercise a different part of the pipeline:

| Specimen | What it tests |
|---|---|
| 🈁 Kanji Nameplate | Industrial robot engraving Japanese kanji — multilingual evidence on full display |
| 🏗 Excavator | Mining heavy equipment, multi-part sub-assemblies |
| 🇯🇵 Komatsu JP | Walkaround with nameplate visible |
| 🚗 Car Engine | Engine bay, fasteners, hoses |
| 🏭 Mazak VMC | CNC machining center, INTEGREX j-200 branding |
| 🤖 Factory Robots | Industrial robot arm on assembly line |
| 🔧 Robot Welding | Robotic welding cell |
| 🖨 3D Printer | FDM printer motion system |
| 🏥 Surgical Robot | Da Vinci Si surgical system |
| 📡 MRI Scanner | Siemens MAGNETOM disassembly |

## Tech stack

- **[Astro 7](https://astro.build)** SSR with the Node adapter — one page, one SSE API route, no UI framework. ~2,500 lines of Astro, ~700 lines of TS.
- **[Gemma 4 31B](https://ai.google.dev/gemma)** via the **[Cerebras](https://cerebras.ai/)** inference API (`api.cerebras.ai`), with `reasoning_effort: medium` for the Reporter call.
- **[ffmpeg](https://ffmpeg.org)** for frame extraction (12 evenly-spaced frames, 640px, skipping the first/last 5%).
- **[bomwiki.com](https://bomwiki.com)** as the canonical parts encyclopedia. **176,882 verified slugs** bundled at `public/bomwiki-slugs.json`, 176,882 display names at `public/bomwiki-names.json`.
- **[Wikimedia Commons](https://commons.wikimedia.org)** as a fallback image source for parts where bomwiki has no thumbnail.

## Running locally

Requires `ffmpeg` on `$PATH` and `CEREBRAS_API_KEY` in `.env`.

```sh
npm install
npm run dev
```

The dev server runs at http://localhost:4321.

```sh
# .env
CEREBRAS_API_KEY=...
```

## File layout

```
src/
  pages/
    index.astro            # the page (UI, streaming client, frame capture)
    api/bom.ts             # POST /api/bom — SSE pipeline
  lib/
    agents.ts              # 4 agents + agentic reranker + JSON parsing
    video_framer.ts        # ffmpeg frame extraction
    bomwiki-catalog.ts     # 176K slug index search
    bomwiki-live-search.ts # (legacy) live search shim
public/
  samples/                 # 10 example videos
  bomwiki-slugs.json       # bundled slug index
  bomwiki-names.json       # slug -> display name map
```

## Why this design

A BOM is a knowledge artifact: a verified, hierarchical map from a real thing to the parts that compose it. A single VLM call can't produce that — it can identify parts, but it can't ground them in a real parts encyclopedia, and it can't structure them hierarchically. The four-agent split lets each agent focus on one job, see the right slice of context, and fail independently.

The agentic re-ranker is the keystone. Without it, the bomwiki links in the output are mostly fiction. With it, the system produces a real, linkable bill of materials that engineers can click through to verify and extend.

## Credits

- **[bomwiki.com](https://bomwiki.com)** — the bill-of-materials encyclopedia whose 176,882-entry slug index grounds every part in this project. All bomwiki links resolve to real pages on their site.
- **[Wikimedia Commons](https://commons.wikimedia.org)** — fallback image source for parts where bomwiki has no thumbnail.
- **[Cerebras](https://cerebras.ai)** — inference API for Gemma 4 31B. Sub-5-second agent latencies on the free tier.
- **[Google Gemma](https://ai.google.dev/gemma)** — the 4 multimodal agents in this pipeline.
- **[Astro](https://astro.build)** — the SSR framework that holds it all together.
- **[ffmpeg](https://ffmpeg.org)** — frame extraction.
- **[Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque), [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4), [JetBrains Mono](https://www.jetbrains.com/lp/mono/)** — the three fonts the UI is set in.
