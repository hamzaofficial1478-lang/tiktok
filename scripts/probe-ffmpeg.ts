/**
 * ffmpeg validation probe — run on a machine that has the binaries.
 *
 *     npm run probe:ffmpeg
 *
 * Phase 5's decision logic is exhaustively unit tested, but the *filter graph
 * strings* it produces cannot be validated without a real ffmpeg: a misplaced
 * label or an unsupported option is a runtime error, not a type error. This
 * generates a synthetic clip, runs every tier's graph against it, and reports
 * whether each one actually executes.
 *
 * It also reports whether the installed build is GPL, which must be false for
 * anything that ships (section 3).
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChildProcessRunner } from '@main/resolve/process-runner';
import { SidecarResolver } from '@main/media/sidecars';
import { probeCapabilities, REQUIRED_FILTERS } from '@main/media/capabilities';
import { buildBlurGraph, buildMaskPgm, buildRemovelogoGraph, buildStaticBlurGraph } from '@main/postprocess/filter-graph';
import { selectEncoder } from '@main/postprocess/encoder';
import { allPixelBoxes } from '@main/postprocess/regions';

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

const WIDTH = 540;
const HEIGHT = 960;

async function main(): Promise<void> {
  const runner = new ChildProcessRunner();
  const sidecars = new SidecarResolver({
    resourcesRoot: resolve(process.cwd(), 'resources'),
    allowPathFallback: true,
  });

  const ffmpeg = sidecars.resolve('ffmpeg').path;
  if (!ffmpeg) {
    console.error(red('ffmpeg not found. Run npm run fetch:sidecars, or put it on PATH.'));
    process.exit(1);
  }
  console.log(`${bold('ffmpeg')}  ${ffmpeg}`);

  const capabilities = await probeCapabilities({ ffmpegPath: ffmpeg });
  console.log(
    `${bold('licence')} ${
      capabilities.isGplBuild === null
        ? dim('unknown')
        : capabilities.isGplBuild
          ? red('GPL — must not ship commercially (section 3)')
          : green('LGPL')
    }`,
  );

  const missing = REQUIRED_FILTERS.filter((f) => !capabilities.filters[f]);
  console.log(
    `${bold('filters')} ${missing.length === 0 ? green('all required present') : red(`missing: ${missing.join(', ')}`)}`,
  );

  try {
    const encoder = selectEncoder(capabilities, true);
    console.log(`${bold('encoder')} ${green(encoder.name)} ${dim(encoder.reason)}`);
  } catch (err) {
    console.log(`${bold('encoder')} ${red((err as { detail?: string }).detail ?? String(err))}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'ffprobe-graphs-'));
  const source = join(dir, 'source.mp4');

  console.log(`\n${bold('generating a 10s test clip')} ${dim(`${WIDTH}x${HEIGHT}`)}`);
  const generated = await runner.run(
    ffmpeg,
    [
      '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${WIDTH}x${HEIGHT}:rate=30:duration=10`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest',
      '-y', source,
    ],
    { timeoutMs: 120_000 },
  );
  if (generated.exitCode !== 0) {
    console.error(red(`could not generate the test clip: ${generated.stderr.slice(0, 300)}`));
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  const boxes = allPixelBoxes(WIDTH, HEIGHT);
  const segments = [
    { startMs: 0, endMs: 3_000, box: boxes[0]! },
    { startMs: 3_000, endMs: 6_000, box: boxes[1]! },
    { startMs: 6_000, endMs: 10_000, box: boxes[0]! },
  ];

  const maskA = join(dir, 'mask-a.pgm');
  const maskB = join(dir, 'mask-b.pgm');
  writeFileSync(maskA, buildMaskPgm(WIDTH, HEIGHT, [boxes[0]!]));
  writeFileSync(maskB, buildMaskPgm(WIDTH, HEIGHT, [boxes[1]!]));

  const cases: { name: string; args: string[] }[] = [
    {
      name: 'tier 1 — removelogo, time-segmented',
      args: [
        '-i', source,
        '-vf', buildRemovelogoGraph([
          { ...segments[0]!, maskPath: maskA },
          { ...segments[1]!, maskPath: maskB },
          { ...segments[2]!, maskPath: maskA },
        ]),
        '-c:v', 'mpeg4', '-c:a', 'copy',
      ],
    },
    {
      name: 'tier 2 — crop/gblur/overlay, time-segmented',
      args: [
        '-i', source,
        '-filter_complex', buildBlurGraph(segments),
        '-map', '[vout]', '-map', '0:a?',
        '-c:v', 'mpeg4', '-c:a', 'copy',
      ],
    },
    {
      name: 'tier 3 — static blur over every candidate region',
      args: [
        '-i', source,
        '-filter_complex', buildStaticBlurGraph(boxes),
        '-map', '[vout]', '-map', '0:a?',
        '-c:v', 'mpeg4', '-c:a', 'copy',
      ],
    },
    {
      name: 'outro trim — stream copy',
      args: ['-i', source, '-t', '7.500', '-c', 'copy'],
    },
  ];

  console.log(`\n${bold('running each generated graph')}`);
  let failures = 0;

  for (const [index, testCase] of cases.entries()) {
    const output = join(dir, `out-${index}.mp4`);
    const result = await runner.run(ffmpeg, ['-v', 'error', ...testCase.args, '-y', output], {
      timeoutMs: 180_000,
    });

    if (result.exitCode === 0 && statSync(output).size > 0) {
      console.log(`  ${green('ok')}   ${testCase.name} ${dim(`${Math.round(statSync(output).size / 1024)}KB`)}`);
    } else {
      failures++;
      console.log(`  ${red('FAIL')} ${testCase.name}`);
      console.log(dim(`       ${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`}`));
    }
  }

  rmSync(dir, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? green('every generated filter graph executed') : red(`${failures} graph(s) failed`)}\n`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
