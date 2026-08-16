/**
 * Renders a caption style onto a real video with the real ffmpeg.
 *
 * The ASS writer and the burn plan are pure and unit-tested, but "libass
 * accepted this file and drew something" is not a claim unit tests can make.
 * This runs the actual chain end to end, deliberately from a directory with a
 * space in its name, because that is the case the filename handling exists for.
 *
 *   node scripts/run-harness.mjs scripts/probe-captions.ts <ffmpeg> <video> <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAss, fittedLineChars, fontSizeFor } from '../src/main/captions/ass';
import { planBurn, SUBTITLE_FILENAME } from '../src/main/captions/burn';
import { normaliseCues, parseSubtitles } from '../src/main/captions/cues';
import { DEFAULT_CAPTION_STYLE, CAPTION_ANIMATIONS } from '../src/shared/caption-schema';
import { ChildProcessRunner } from '../src/main/resolve/process-runner';

// The harness re-enters via a bundle, so the script path is still in argv.
const passed = process.argv.slice(2).filter((a) => !a.endsWith('.ts') && !a.endsWith('.mjs'));
const [ffmpeg, video, outDir] = passed;
if (!ffmpeg || !video || !outDir) throw new Error('usage: <ffmpeg> <video> <outDir>');

const SRT = `1
00:00:00,200 --> 00:00:01,600
Three guitar mistakes that wreck your timing

2
00:00:01,700 --> 00:00:03,900
<i>with markup</i> and {\\pos(0,0)} an override attempt
`;

/** Word timings, as transcription produces them, for the word-level styles. */
const WORDS = [
  { text: 'Three', startMs: 200, endMs: 480 },
  { text: 'guitar', startMs: 480, endMs: 800 },
  { text: 'mistakes', startMs: 800, endMs: 1_180 },
  { text: 'that', startMs: 1_180, endMs: 1_340 },
  { text: 'wreck', startMs: 1_340, endMs: 1_600 },
];

const runner = new ChildProcessRunner();
mkdirSync(outDir, { recursive: true });

for (const animation of CAPTION_ANIMATIONS) {
  const parsedCues = parseSubtitles(SRT);
  const withWords = parsedCues.map((cue, index) => (index === 0 ? { ...cue, words: WORDS } : cue));
  const cues = normaliseCues(withWords, {
    maxLineChars: Math.min(
      DEFAULT_CAPTION_STYLE.maxLineChars,
      fittedLineChars(540, fontSizeFor(DEFAULT_CAPTION_STYLE, 960)),
    ),
    maxLines: DEFAULT_CAPTION_STYLE.maxLines,
    uppercase: false,
    durationMs: 4_000,
  });

  const workDir = join(outDir, `work ${animation}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    join(workDir, SUBTITLE_FILENAME),
    buildAss(cues, { ...DEFAULT_CAPTION_STYLE, animation }, { frameWidth: 540, frameHeight: 960 }),
  );

  const plan = planBurn({
    mode: 'burn',
    subtitleDir: workDir,
    subtitlePath: join(workDir, SUBTITLE_FILENAME),
    outputExtension: '.mp4',
  });

  const output = join(outDir, `burned-${animation}.mp4`);
  const result = await runner.run(
    ffmpeg,
    ['-v', 'error', '-i', video, '-vf', plan.videoFilter ?? '', '-c:v', 'libopenh264', '-c:a', 'copy', '-y', output],
    { timeoutMs: 120_000, ...(plan.cwd ? { cwd: plan.cwd } : {}) },
  );

  console.log(`${animation}: exit ${result.exitCode} ${result.stderr.trim().slice(0, 200)}`);
}

// Soft mux, for the other half of the plan.
const softDir = join(outDir, 'work soft');
mkdirSync(softDir, { recursive: true });
const softAss = join(softDir, SUBTITLE_FILENAME);
writeFileSync(
  softAss,
  buildAss(normaliseCues(parseSubtitles(SRT), { maxLineChars: 32, maxLines: 2, uppercase: false }), DEFAULT_CAPTION_STYLE, {
    frameWidth: 540,
    frameHeight: 960,
  }),
);
const soft = planBurn({ mode: 'soft', subtitleDir: softDir, subtitlePath: softAss, outputExtension: '.mp4' });
const softOut = join(outDir, 'soft.mp4');
const softResult = await runner.run(
  ffmpeg,
  ['-v', 'error', '-i', video, ...soft.args, '-c:v', 'copy', '-y', softOut],
  { timeoutMs: 120_000 },
);
console.log(`soft: exit ${softResult.exitCode} ${softResult.stderr.trim().slice(0, 300)}`);
