/**
 * video_framer.ts
 *
 * Extracts frames from a video using ffmpeg. Returns base64 PNGs
 * with timestamps, sized for a multimodal model budget.
 *
 * Gemma 4 31B accepts image inputs via inline base64 in the
 * generateContent API. Token budget per image: 70, 140, 280, 560, 1120.
 * For video understanding we use ~6-10 frames @ 280 budget.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Frame {
  index: number;
  timestamp: number; // seconds
  base64: string;
  mimeType: 'image/png';
  width: number;
  height: number;
}

export interface FrameExtractionOptions {
  /** Target number of frames to extract. Default 8. */
  frameCount?: number;
  /** Max width for the resized frame. Default 640 (keeps token cost low). */
  maxWidth?: number;
  /** ffmpeg binary. Default 'ffmpeg'. */
  ffmpeg?: string;
}

const DEFAULTS = {
  frameCount: 8,
  maxWidth: 640,
  ffmpeg: 'ffmpeg',
};

/**
 * Extract evenly-spaced frames from a video file path.
 * Returns base64 PNGs + timestamps.
 */
export async function extractFrames(
  videoPath: string,
  options: FrameExtractionOptions = {}
): Promise<Frame[]> {
  const opts = { ...DEFAULTS, ...options };
  const probe = await ffprobeDuration(videoPath, opts.ffmpeg);
  const { duration } = probe;
  if (!duration || duration <= 0) {
    throw new Error('Could not determine video duration.');
  }

  // Compute timestamps: evenly spaced across the video, but skip the very first
  // and last 5% which are usually fades/intro/outro. For short videos (<2s)
  // we just sample once in the middle.
  const startOffset = Math.min(0.5, duration * 0.05);
  const endOffset = Math.max(startOffset + 0.1, duration - duration * 0.05);
  const usable = Math.max(0.1, endOffset - startOffset);

  const n = opts.frameCount;
  const timestamps: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = startOffset + (usable * i) / Math.max(1, n - 1);
    timestamps.push(Number(t.toFixed(2)));
  }

  const frames: Frame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const frame = await extractSingleFrame(
      videoPath,
      timestamps[i],
      i,
      opts
    );
    frames.push(frame);
  }
  return frames;
}

interface FfprobeResult {
  duration: number;
  width: number;
  height: number;
}

async function ffprobeDuration(
  videoPath: string,
  _ffmpegBin: string
): Promise<FfprobeResult> {
  // ffprobe ships with ffmpeg. Use it to get duration + dims.
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      videoPath,
    ];
    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe failed: ${stderr}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        const stream = parsed.streams?.[0] ?? {};
        const duration = parseFloat(parsed.format?.duration ?? '0');
        resolve({
          duration,
          width: Number(stream.width ?? 0),
          height: Number(stream.height ?? 0),
        });
      } catch (e) {
        reject(new Error(`Could not parse ffprobe output: ${stdout}`));
      }
    });
  });
}

async function extractSingleFrame(
  videoPath: string,
  timestamp: number,
  index: number,
  opts: Required<FrameExtractionOptions>
): Promise<Frame> {
  const tmpId = randomUUID();
  const outPath = join(tmpdir(), `bom-frame-${tmpId}.png`);

  // Scale to maxWidth, preserve aspect ratio
  const scale = `scale='min(${opts.maxWidth},iw)':-1`;

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-y',
      '-ss', String(timestamp),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', scale,
      outPath,
    ];
    const proc = spawn(opts.ffmpeg, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg frame extract failed: ${stderr}`));
      }
      resolve();
    });
  });

  const buf = await fs.readFile(outPath);
  await fs.unlink(outPath).catch(() => {});

  // Get dimensions from the actual PNG header (1x1 = 16 bytes, IHDR at byte 16)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);

  return {
    index,
    timestamp,
    base64: buf.toString('base64'),
    mimeType: 'image/png',
    width,
    height,
  };
}

/**
 * Save an uploaded File (from a multipart form) to a temp path.
 * Caller is responsible for unlinking.
 */
export async function saveUploadToTemp(
  data: ArrayBuffer
): Promise<string> {
  const path = join(tmpdir(), `bom-upload-${randomUUID()}.mp4`);
  await fs.writeFile(path, Buffer.from(data));
  return path;
}
