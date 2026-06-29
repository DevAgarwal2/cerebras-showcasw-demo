/**
 * /api/bom — Bill of Vision API
 *
 * Accepts a multipart video upload, extracts frames with ffmpeg,
 * runs 4 specialized Gemma 4 31B agents, and returns a structured
 * bill of materials.
 *
 * Pipeline:
 *   Phase 1 (parallel):  [Detector, Geometry] run in parallel on the frames.
 *   Phase 1b:            [Mapper] runs once Detector has produced part names.
 *   Phase 2 (sequential): [Reporter] — synthesizes everything, then runs an
 *                        agentic re-ranker to ground bomwiki URLs against
 *                        the 176K slug index.
 *
 * Output: Server-Sent Events. The first N events describe per-agent progress
 * (so the client can show "Detector is running" / "Mapper finished in 12.3s").
 * The last event is a `result` event with the full BOM payload. On failure,
 * a single `error` event is emitted and the stream closes.
 */

import type { APIRoute } from 'astro';
import { promises as fs } from 'node:fs';
import {
  extractFrames,
  saveUploadToTemp,
  type Frame,
} from '../../lib/video_framer.js';
import {
  runDetector,
  runGeometry,
  runMapper,
  runReporter,
  type AgentResult,
  type PartItem,
  type GeometryResult,
  type MappingItem,
  type BomReport,
} from '../../lib/agents.js';

export const prerender = false;

const MODEL = 'gemma-4-31b';
const API_KEY = import.meta.env.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY || '';
const FRAME_COUNT = 12; // Extract 12 frames — UI shows all 12, API gets up to 5
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB cap

export const POST: APIRoute = async ({ request }) => {
  if (!API_KEY) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: 'CEREBRAS_API_KEY is not configured on the server.' })}\n\n`,
      { status: 500, headers: sseHeaders() }
    );
  }

  const ct = request.headers.get('content-type') ?? '';
  if (!ct.startsWith('multipart/form-data')) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: 'Expected multipart/form-data with a "video" file field.' })}\n\n`,
      { status: 400, headers: sseHeaders() }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: 'Could not parse form data.' })}\n\n`,
      { status: 400, headers: sseHeaders() }
    );
  }

  const file = form.get('video');
  if (!(file instanceof File)) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: 'No "video" file in upload.' })}\n\n`,
      { status: 400, headers: sseHeaders() }
    );
  }
  if (file.size === 0) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: 'Uploaded video is empty.' })}\n\n`,
      { status: 400, headers: sseHeaders() }
    );
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({
        error: `Video too large. Max ${Math.round(MAX_VIDEO_BYTES / 1e6)} MB. Yours: ${Math.round(file.size / 1e6)} MB.`,
      })}\n\n`,
      { status: 413, headers: sseHeaders() }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller may be closed if the client disconnected
        }
      };

      let videoPath: string | null = null;
      try {
        const arrayBuf = await file.arrayBuffer();
        videoPath = await saveUploadToTemp(arrayBuf);

        // ---- FRAME EXTRACTION ----
        send('status', { phase: 'extract', text: `Extracting ${FRAME_COUNT} frames with ffmpeg…` });
        const t0 = Date.now();
        const frames = await extractFrames(videoPath, {
          frameCount: FRAME_COUNT,
          maxWidth: 640,
        });
        const extractMs = Date.now() - t0;
        if (frames.length === 0) {
          send('error', { error: 'No frames extracted from video.' });
          controller.close();
          return;
        }
        send('frames', { count: frames.length, width: frames[0].width, height: frames[0].height, extractMs });

        // ---- PHASE 1: PARALLEL AGENTS ----
        send('status', { phase: 'phase1', text: 'Phase 1: Detector and Geometry running in parallel on the frames.' });
        send('agent', { name: 'detector', status: 'running' });
        send('agent', { name: 'geometry', status: 'running' });

        const phase1Start = Date.now();
        const [detector, geometry] = await Promise.all([
          runDetector(API_KEY, MODEL, frames),
          runGeometry(API_KEY, MODEL, frames),
        ]);
        send('agent', {
          name: 'detector',
          status: detector.ok ? 'done' : 'error',
          latency_ms: detector.latency_ms,
          summary: detector.ok
            ? `Found ${detector.data?.parts.length ?? 0} distinct parts.`
            : `Failed: ${detector.error}`,
        });
        send('agent', {
          name: 'geometry',
          status: geometry.ok ? 'done' : 'error',
          latency_ms: geometry.latency_ms,
          summary: geometry.ok
            ? `${geometry.data?.scale_class} scale · ${(geometry.data?.primary_materials ?? []).join(', ') || 'unknown materials'}.`
            : `Failed: ${geometry.error}`,
        });

        // ---- PHASE 1b: MAPPER ----
        const partNames = detector.ok ? (detector.data?.parts ?? []).map((p) => p.name) : [];
        let mapper: AgentResult<{ mappings: MappingItem[] }>;
        if (partNames.length > 0) {
          send('status', {
            phase: 'phase1b',
            text: `Phase 1b: Mapper is resolving ${partNames.length} part names against the bomwiki.com index.`,
          });
          send('agent', { name: 'mapper', status: 'running' });
          mapper = await runMapper(API_KEY, MODEL, partNames);
          send('agent', {
            name: 'mapper',
            status: mapper.ok ? 'done' : 'error',
            latency_ms: mapper.latency_ms,
            summary: mapper.ok
              ? `Mapped ${mapper.data?.mappings?.length ?? 0} parts to bomwiki slugs.`
              : `Failed: ${mapper.error}`,
          });
        } else {
          mapper = { ok: false, error: 'No parts from detector to map.', latency_ms: 0 };
          send('agent', { name: 'mapper', status: 'error', summary: 'Skipped — no parts from detector.' });
        }

        const phase1Ms = Date.now() - phase1Start;

        // ---- PHASE 2: REPORTER ----
        send('status', {
          phase: 'phase2',
          text: 'Phase 2: Report Builder is composing the final bill of materials.',
        });
        send('agent', { name: 'reporter', status: 'running' });

        const phase2Start = Date.now();
        let reporter: AgentResult<BomReport> = {
          ok: false,
          error: 'Reporter not run (missing inputs).',
          latency_ms: 0,
        };
        const fallbackParts: PartItem[] = detector.ok ? detector.data!.parts : [];
        const fallbackGeometry: GeometryResult = geometry.ok
          ? geometry.data!
          : { scale_class: 'standard', primary_materials: ['unknown'], environment: 'unknown' };
        const fallbackMappings: MappingItem[] = mapper.ok ? mapper.data!.mappings : [];
        if (fallbackParts.length > 0) {
          reporter = await runReporter(API_KEY, MODEL, frames, fallbackParts, fallbackGeometry, fallbackMappings);
        }
        const phase2Ms = Date.now() - phase2Start;

        send('agent', {
          name: 'reporter',
          status: reporter.ok ? 'done' : 'error',
          latency_ms: reporter.latency_ms,
          summary: reporter.ok
            ? `Built BOM with ${reporter.data?.bom?.length ?? 0} entries across ${new Set((reporter.data?.bom ?? []).map((b) => b.sub_assembly)).size} sub-assemblies.`
            : `Failed: ${reporter.error}`,
        });

        // ---- RESULT ----
        const totalMs = Date.now() - t0;
        // Fallback: for any bom row whose `note` is empty, lift the
        // matching raw_part's notes by name. The Detector already writes
        // video-specific role descriptions per part; the Reporter sometimes
        // leaves the bom row's note empty. This makes every part card
        // carry a "where used in this video" line without touching prompts.
        const rawNotesByName = new Map<string, string>();
        if (detector.ok && detector.data) {
          for (const p of detector.data.parts) {
            if (p.notes) rawNotesByName.set(p.name, p.notes);
          }
        }
        const filledBom = reporter.ok && reporter.data?.bom
          ? reporter.data.bom.map((b) => {
              if (!b.note && rawNotesByName.has(b.name)) {
                return { ...b, note: rawNotesByName.get(b.name) };
              }
              return b;
            })
          : [];
        const result = {
          ok: true,
          product: reporter.ok ? reporter.data?.product : null,
          summary: reporter.ok ? reporter.data?.summary : null,
          bom: filledBom,
          total_parts:
            reporter.ok && reporter.data
              ? reporter.data.total_parts
              : (detector.ok ? detector.data?.parts.length : 0),
          notes: reporter.ok ? reporter.data?.notes : null,
          geometry: geometry.ok ? geometry.data : null,
          raw_parts: detector.ok ? detector.data?.parts : [],
          mappings: mapper.ok ? mapper.data?.mappings : [],
          timing: {
            total_ms: totalMs,
            frame_extraction_ms: extractMs,
            phase1_parallel_ms: phase1Ms,
            phase2_reporter_ms: phase2Ms,
            per_agent: {
              detector_ms: detector.latency_ms,
              geometry_ms: geometry.latency_ms,
              mapper_ms: mapper.latency_ms,
              reporter_ms: reporter.latency_ms,
            },
          },
          agents: {
            detector: { ok: detector.ok, error: detector.error },
            geometry: { ok: geometry.ok, error: geometry.error },
            mapper: { ok: mapper.ok, error: mapper.error },
            reporter: { ok: reporter.ok, error: reporter.error },
          },
          model: MODEL,
          frame_count: frames.length,
          frame_dimensions: frames[0]
            ? { width: frames[0].width, height: frames[0].height }
            : null,
        };
        send('result', result);
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error.';
        console.error('[bom] Pipeline error:', e instanceof Error ? e.stack : message);
        send('error', { error: `Bill of Vision failed: ${message}` });
        try { controller.close(); } catch {}
      } finally {
        if (videoPath) {
          await fs.unlink(videoPath).catch(() => {});
        }
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
};

const encoder = new TextEncoder();
function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}
