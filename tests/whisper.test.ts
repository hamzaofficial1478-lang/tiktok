import { describe, expect, it } from 'vitest';
import { audioExtractArgs, groupTokensIntoWords, parseWhisperJson, transcribeArgs } from '@main/captions/whisper';
import { findWhisperBinary, pickReleaseAsset, WHISPER_MODELS } from '@main/captions/whisper-installer';

describe('preparing audio for the model', () => {
  it('asks ffmpeg for the only format whisper.cpp reads', () => {
    const args = audioExtractArgs('/in/video.mp4', '/tmp/audio.wav');
    expect(args[args.indexOf('-ar') + 1]).toBe('16000');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args).toContain('pcm_s16le');
    // Without -vn ffmpeg decodes the video track only to discard it, which on
    // a long clip is most of the time spent here.
    expect(args).toContain('-vn');
  });
});

describe('invoking the transcriber', () => {
  const base = { modelPath: '/m/ggml-base.en.bin', audioPath: '/a.wav', outputPrefix: '/out/t', threads: 4 };

  it('asks for the full JSON, which is what carries word timings', () => {
    const args = transcribeArgs({ ...base, translateToEnglish: false, english: true });
    expect(args).toContain('--output-json-full');
  });

  it('states the language rather than paying for detection', () => {
    // Detection costs a pass over the first 30 seconds and gets it wrong on
    // short clips with music under the speech, which is most of TikTok.
    expect(transcribeArgs({ ...base, translateToEnglish: false, english: true })).toContain('en');
    expect(transcribeArgs({ ...base, translateToEnglish: false, english: false })).toContain('auto');
  });

  it('does not ask an English model to translate into English', () => {
    const args = transcribeArgs({ ...base, translateToEnglish: true, english: true });
    expect(args).not.toContain('--translate');
  });

  it('translates when a multilingual model is being used', () => {
    expect(transcribeArgs({ ...base, translateToEnglish: true, english: false })).toContain('--translate');
  });
});

describe('reading the transcript back', () => {
  const json = JSON.stringify({
    transcription: [
      {
        offsets: { from: 200, to: 1_600 },
        text: ' Three guitar mistakes',
        tokens: [
          { text: ' Three', offsets: { from: 200, to: 480 } },
          { text: ' gui', offsets: { from: 480, to: 640 } },
          { text: 'tar', offsets: { from: 640, to: 800 } },
          { text: ' mistakes', offsets: { from: 800, to: 1_180 } },
        ],
      },
      { offsets: { from: 1_700, to: 2_000 }, text: '[Music]' },
    ],
  });

  it('joins sub-word tokens into whole words', () => {
    // The model emits pieces, and a leading space is how it marks a word
    // boundary. Without this, a highlight fires mid-syllable.
    const cues = parseWhisperJson(json);
    expect(cues[0]?.words?.map((w) => w.text)).toEqual(['Three', 'guitar', 'mistakes']);
    expect(cues[0]?.words?.[1]).toEqual({ text: 'guitar', startMs: 480, endMs: 800 });
  });

  it('drops the bracketed labels whisper uses for noise', () => {
    // Burning "[Music]" onto a video is not a caption.
    expect(parseWhisperJson(json)).toHaveLength(1);
  });

  it('ignores special tokens that carry timing but no words', () => {
    const words = groupTokensIntoWords([
      { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
      { text: ' hello', offsets: { from: 100, to: 300 } },
      { text: '<|endoftext|>', offsets: { from: 300, to: 300 } },
    ]);
    expect(words.map((w) => w.text)).toEqual(['hello']);
  });

  it('reports unreadable output as a failure rather than as silence', () => {
    expect(() => parseWhisperJson('not json')).toThrow();
  });
});

describe('finding what to install', () => {
  it('picks the plain x64 Windows build ahead of vendor variants', () => {
    const asset = pickReleaseAsset(
      [
        { name: 'whisper-bin-x64-cuda.zip', browser_download_url: 'u1' },
        { name: 'whisper-bin-x64.zip', browser_download_url: 'u2' },
        { name: 'source.tar.gz', browser_download_url: 'u3' },
      ],
      'win32',
    );
    expect(asset?.url).toBe('u2');
  });

  it('matches a renamed asset rather than failing on an exact name', () => {
    // The asset names have changed more than once; a hard-coded one would
    // break on the next release with a 404 that reads like a network fault.
    const asset = pickReleaseAsset([{ name: 'whisper-v1.8-bin-x64.zip', browser_download_url: 'u' }], 'win32');
    expect(asset?.url).toBe('u');
  });

  it('says nothing is published rather than downloading something that will not run', () => {
    expect(pickReleaseAsset([{ name: 'whisper-bin-x64.zip', browser_download_url: 'u' }], 'linux')).toBeNull();
    expect(pickReleaseAsset([], 'win32')).toBeNull();
  });

  it('offers English models, because they beat multilingual ones at English', () => {
    expect(WHISPER_MODELS.every((model) => model.file.includes('.en.'))).toBe(true);
    expect(WHISPER_MODELS.map((m) => m.id)).toContain('base.en');
  });

  it('finds the CLI under either name it has shipped as', () => {
    expect(findWhisperBinary('/nonexistent-directory')).toBeNull();
  });
});
