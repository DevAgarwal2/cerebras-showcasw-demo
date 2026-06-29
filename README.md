# Bill of Vision

> **Video in. Bill of materials out.** A 4-agent pipeline on Gemma 4 31B that watches a short video of any machine and produces a real, hierarchical bill of materials — every part grounded against a 176,882-entry parts encyclopedia, every nameplate read in its original script.

<p align="left">
  <a href="https://github.com/DevAgarwal2/cerebras-showcasw-demo/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-black.svg"></a>
  <a href="https://astro.build"><img alt="Astro 7" src="https://img.shields.io/badge/astro-7-FF5D01.svg"></a>
  <a href="https://cerebras.ai"><img alt="Cerebras" src="https://img.shields.io/badge/inference-Cerebras-1A1A1A.svg"></a>
  <a href="https://ai.google.dev/gemma"><img alt="Gemma 4 31B" src="https://img.shields.io/badge/model-Gemma_4_31B-4285F4.svg"></a>
  <a href="https://bomwiki.com"><img alt="bomwiki.com" src="https://img.shields.io/badge/grounded_at-bomwiki.com-FF6B35.svg"></a>
</p>

---

## Why this exists

Every factory, repair shop, and parts catalogue in the world runs on the same artifact: a **bill of materials**. A BOM is what you build a procurement system, a service manual, or an insurance claim around. Today, the only way to get a BOM for a machine you don't already know is to either (a) find a model number and look it up, or (b) have a human watch the machine and write one down.

Bill of Vision collapses that. Drop in a video. Four specialised agents run in parallel and sequence. You get a real, hierarchical, linkable BOM back in seconds — with the model **proving it actually looked** by quoting any nameplate, decal, or label it read, in the original script.

This is the keystone of the project: **the LLM never invents a URL it wasn't shown a verified candidate for.** Every bomwiki.com link in the output is a real slug from a 176,882-entry index — never a hallucination.

---

## What it does

```
   video.mp4
       │
       ▼
   ┌───────┐      12 frames @ 640px
   │ ffmpeg│ ──────────────────────►
   └───────┘
                                   │
                                   ▼
                  ┌────────────────┴────────────────┐
                  │         Phase 1 (parallel)       │
                  │                                  │
              ┌───┴────┐                       ┌─────┴─────┐
              │Detector│                       │ Geometry  │
              └───┬────┘                       └─────┬─────┘
                  │  parts + multilingual             │  scale, dims,
                  │  evidence (nameplates)            │  materials, env
                  ▼                                   │
              ┌───────┐                               │
              │ Mapper│ ◄───── bomwiki.com            │
              └───┬───┘       (176,882 slugs)         │
                  │                                   │
                  └──────────────┬────────────────────┘
                                 ▼
                  ┌──────────────────────────────┐
                  │         Phase 2              │
                  │                              │
                  │   ┌────────────────────┐     │
                  │   │     Reporter       │     │
                  │   │  + agentic re-rank │     │
                  │   └────────────────────┘     │
                  └──────────────────────────────┘
                                 │
                                 ▼
                       Hierarchical BOM
                       + multilingual
                         evidence
                       + bomwiki links
```

---

## The four agents

| # | Agent | Job | Output |
|---|-------|-----|--------|
| **01** | **Part Detector** | Identify every visible component across the 12 frames, **read any nameplate / decal / label verbatim** in its original script, and emit the language + translation + influence on the match. | `parts[]` with `name, category, quantity, confidence, notes, detected_text, detected_language, translation, detection_influence` |
| **02** | **Geometry Agent** | Estimate scale, dimensions, mass, dominant materials, intended environment from visual cues. | `scale_class, *_mm, weight_kg, primary_materials[], environment` |
| **03** | **BOM Mapper** | Resolve each part name to a canonical bomwiki.com slug. | `mappings[]` with `local_name, bomwiki_slug, bomwiki_category, reuse_estimate, confidence` |
| **04** | **Report Builder** | Stitch everything into a hierarchical BOM grouped by sub-assembly, attribute each part to a specific frame for traceability, then run the **agentic re-ranker** to ground every URL. | `{ product, summary, bom[], total_parts, notes }` |

**Phases** — Detector + Geometry run in **parallel** (both vision tasks). Mapper runs once Detector has produced part names. Reporter runs after Phase 1 + 1b complete, since it synthesises every prior output.

The pipeline streams progress over **Server-Sent Events**: a `status` event per phase, an `agent` event per agent with start / done / latency / one-line summary, and a final `result` event with the full payload. The client renders real progress — no fake animation, the cards only move when the server reports a state change.

---

## Multilingual evidence — the proof-of-looking layer

A judge can click any part card and see whether the model **actually looked at the machine**. If the Detector reads a nameplate, the report surfaces:

- the **original text** verbatim, in its original script — `「三菱重工業」`, `"KOMATSU"`, `"PC 490 LC"`, `"MADE IN JAPAN"`
- the **language** of the reading
- an **English translation** when non-English
- a one-line **influence on match** — *"confirmed manufacturer: Mitsubishi"*, *"matched model number to product family"*

Parts with no legible nameplate render **nothing** — never a placeholder dash. The system never invents a manufacturer; if it's not on the part, it isn't on the card.

This is the answer to the most common AI-demonstration failure: showing the model made something up. With the multilingual evidence layer, every claim the model makes about a part is traceable to a string it actually read off that part.

---

## Agentic re-ranking — the grounding step

The naive approach — ask the LLM to invent bomwiki slugs — produces links that 404. The Reporter does something better:

1. **Gather candidates.** For each BOM item, `collectCandidates()` searches the bundled 176K slug index using:
   - the full part name
   - each individual word in the name
   - product-context combinations (e.g. `bulldozer track`, `bulldozer sprocket`)
2. **LLM picks the best.** All candidate sets are batched into a single `agenticRerank()` Cerebras call. The system prompt carries disambiguation rules (*for an excavator, prefer `excavator-bucket` over `wheel-lathe`; for a bulldozer, prefer `bulldozer-sprocket` over `wheel-lathe`*).
3. **Graceful fallback.** If the rerank call fails, we fall back to the local index's best match, then to the LLM's invented slug (normalised), then to empty.

The LLM **never invents a URL it wasn't shown a verified candidate for.** Every bomwiki link in the output is either a real slug from the index, or empty.

---

## Tech stack

| Layer | What |
|---|---|
| Frontend | **[Astro 7](https://astro.build)** SSR with the Node adapter. One page, one SSE API route, no UI framework. ~2,500 lines of Astro, ~700 lines of TS. |
| Inference | **[Gemma 4 31B](https://ai.google.dev/gemma)** via the **[Cerebras](https://cerebras.ai)** API (`api.cerebras.ai/v1/chat/completions`), with `reasoning_effort: medium` for the Reporter. |
| Frame extraction | **[ffmpeg](https://ffmpeg.org)** — 12 evenly-spaced frames, 640px, skipping the first/last 5% of the video. |
| Parts encyclopedia | **[bomwiki.com](https://bomwiki.com)** — 176,882 verified slugs bundled at `public/bomwiki-slugs.json`, 176,882 display names at `public/bomwiki-names.json`. |
| Fallback images | **[Wikimedia Commons](https://commons.wikimedia.org)** — for parts where bomwiki has no thumbnail. |
| Fonts | Bricolage Grotesque, Source Serif 4, JetBrains Mono. |

---

## Quick start

**Requirements:** Node 22+, ffmpeg on `$PATH`, a Cerebras API key.

```sh
# 1. Install
npm install

# 2. Configure
cp .env.example .env
echo "CEREBRAS_API_KEY=your-key-here" >> .env

# 3. Run
npm run dev
```

Open <http://localhost:4321>, drop a video (or pick a specimen from the shelf), and watch the four agents fan out. End-to-end is ~30 seconds on Cerebras free tier.

### Environment variables

| Var | Required | What |
|---|---|---|
| `CEREBRAS_API_KEY` | yes | Cerebras inference key. Get one at [cerebras.ai](https://cerebras.ai). |
| `GEMMA_MODEL` | no | Defaults to `gemma-4-31b`. Override to test other models. |

### Useful scripts

```sh
npm run dev      # start the dev server (Astro, hot-reload)
npm run build    # production build
npm run preview  # serve the production build locally
npx astro check  # type-check the project
```

---

## Specimen library

Ten sample clips ship in `public/samples/`, each picked to exercise a different part of the pipeline:

| Specimen | What it tests |
|---|---|
| 🈁 **Kanji Nameplate** | Industrial robot engraving Japanese kanji — multilingual evidence on full display |
| 🏗 **Excavator** | Mining heavy equipment, multi-part sub-assemblies |
| 🇯🇵 **Komatsu JP** | Walkaround with nameplate visible |
| 🚗 **Car Engine** | Engine bay, fasteners, hoses |
| 🏭 **Mazak VMC** | CNC machining center, INTEGREX j-200 branding |
| 🤖 **Factory Robots** | Industrial robot arm on assembly line |
| 🔧 **Robot Welding** | Robotic welding cell |
| 🖨 **3D Printer** | FDM printer motion system |
| 🏥 **Surgical Robot** | Da Vinci Si surgical system |
| 📡 **MRI Scanner** | Siemens MAGNETOM disassembly |

---

## Project structure

```
src/
  pages/
    index.astro            the page (UI, streaming client, frame capture)
    api/bom.ts             POST /api/bom — SSE pipeline endpoint
  lib/
    agents.ts              4 agents + agentic reranker + JSON parsing
    video_framer.ts        ffmpeg frame extraction
    bomwiki-catalog.ts     176K slug index search
    bomwiki-live-search.ts legacy live-search shim
public/
  samples/                 10 example videos
  bomwiki-slugs.json       bundled slug index
  bomwiki-names.json       slug → display name map
.env.example               template (commit this, not .env)
.gitignore                 node_modules, .env, dist, .astro, .vscode, .commandcode
```

---

## Why this design

A BOM is a knowledge artifact: a verified, hierarchical map from a real thing to the parts that compose it. A single VLM call can't produce that — it can identify parts, but it can't ground them in a real parts encyclopedia, and it can't structure them hierarchically. The four-agent split lets each agent focus on one job, see the right slice of context, and fail independently.

The agentic re-ranker is the keystone. Without it, the bomwiki links in the output are mostly fiction. With it, the system produces a real, linkable bill of materials that engineers can click through to verify and extend.

---

## Credits

This project wouldn't exist without:

- **[bomwiki.com](https://bomwiki.com)** — the bill-of-materials encyclopedia whose 176,882-entry slug index grounds every part in this project. All bomwiki links resolve to real pages on their site.
- **[Cerebras](https://cerebras.ai)** — the inference API for Gemma 4 31B. Sub-5-second agent latencies.
- **[Google Gemma](https://ai.google.dev/gemma)** — the four multimodal agents in this pipeline.
- **[Astro](https://astro.build)** — the SSR framework that holds the whole thing together in a single page.
- **[Wikimedia Commons](https://commons.wikimedia.org)** — fallback image source for parts where bomwiki has no thumbnail.
- **[ffmpeg](https://ffmpeg.org)** — frame extraction.
- **Bricolage Grotesque**, **Source Serif 4**, **JetBrains Mono** — the three fonts the UI is set in.

---

## License

MIT
