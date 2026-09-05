# Download reliability and quality repairs — 5 September 2026

Reviewed branch: `claude/tiktok-downloader-desktop-0bsyo1`, starting at `e72b5b1`.

The app uses an Electron interface, a SQLite-backed queue and download ledger,
yt-dlp for TikTok extraction and transfer, and optional ffmpeg processing. Saved
creator runs list profiles and filter their video IDs through the ledger;
individual links go through the queue's duplicate checks. Downloads are verified
before they receive their final filenames. Watermark processing, captions,
colour correction, sharpening and compatibility processing run afterward.

## Findings and changes

| Problem | Cause found in the code | Change |
| --- | --- | --- |
| Queue remains on one download | The watchdog aborted the operation but still awaited it indefinitely if it ignored cancellation. | Race worker completion against cancellation, release the slot and ignore late results/callbacks. |
| Long apparent stalls | Only broad attempt deadlines existed; a transfer could make no progress for minutes. | Stop video transfers after 90 seconds without changing byte progress. Progress resets this timer; local processing has its own deadline. |
| Windows processes linger | Killing the launcher did not terminate yt-dlp/ffmpeg descendants; inherited pipes could delay completion. | Terminate the Windows process tree and settle timeouts without waiting for pipe closure. |
| Misleading timeout duration | Disarming the watchdog erased its allowance before the error message used it. | Retain the allowance until failure handling completes. |
| Repeated downloads after clearing/moving files | Individual-link checks required the ledger's original file path to exist when no library row remained. | Check the persistent TikTok ID independently of the old path. Preserve explicit duplicate decisions and unfinished-file resume behavior. |
| New videos skipped | A batch-wide duplicate choice was applied even to previously unseen IDs. | Apply that choice only to IDs with prior download records. |
| Low source resolution | Clean 480p was deliberately preferred over available watermarked 1080p. | Rank resolution first and prefer clean sources at equal resolution; process watermarks according to settings. |
| High-quality audio/video merging fails | yt-dlp was never passed the app's ffmpeg installation path. | Supply `--ffmpeg-location` for transfers and subtitle conversion. |
| Enhancer silently does nothing | Disabling H.264 compatibility also removed the encoders needed for sharpening/colour filters. | Supply quality-adjusted encoders when enhancement requires them. |
| Processing problems disappear | Starting the next stage cleared the earlier failed-stage marker. | Keep the failure visible through completion; explicitly mark enhancement that could not run. |
| Incorrect library size | The saved size described the video before re-encoding. | Read the final file size. |
| External yt-dlp settings interfere | Extraction and transfer loaded unrelated command-line configuration. | Use `--ignore-config` and explicitly enable transfer progress. |
| Updater mishandles a directory | On Windows, a directory at an executable's destination could be moved aside as if it were a locked file. | Refuse directory replacement. |

Existing library clearing already retained the ledger on this branch. The new
fix closes the remaining individual-link path; it does not erase existing data.
The existing folder reconciliation can recover older downloaded IDs when those
IDs still appear in filenames under the configured output folder. Files renamed
to remove their IDs cannot reconstruct a lost database record by themselves.

## Verification

- TypeScript checking passed.
- Full offline suite passed: 1,042 tests; five intentionally skipped live/platform tests.
- Production main, preload and renderer builds passed. This sandbox required
  Node's native TypeScript configuration loading because esbuild's configuration
  bundler could not scan an ancestor folder. The repository's application build
  settings and dependencies were preserved; the temporary loader was restored.
- Real Windows subprocess test verified that timeout cleanup kills descendants.
- Live extraction succeeded for the screenshot ID `7668725516802821406`.
- The opt-in live download test downloaded that video through the actual queue
  and pipeline, checked the saved file and ledger, cleared library records, and
  verified that resubmitting the link was skipped. Temporary video output was
  removed after the test.
- Path-dependent test fixtures were corrected to run on Windows.

The live check covers one public video from this connection. It does not prove
that every account, region, private post or future TikTok response will work.
Actual hardware enhancement output was not visually evaluated. Sharpening cannot
reconstruct detail missing from TikTok's source; selecting the better source
prevents avoidable resolution loss. Higher-resolution watermarked sources may
take longer to process and need ffmpeg for removal.

## Pull and run on Windows

Close the app. In PowerShell, from your existing repository folder:

```powershell
git switch claude/tiktok-downloader-desktop-0bsyo1
git pull --ff-only origin claude/tiktok-downloader-desktop-0bsyo1
& '.\Run TikTok Downloader.bat'
```

The launcher rebuilds the app. No dependency versions changed. In Settings,
confirm ffmpeg is installed if using enhancement or separate audio/video merging.
Use Retry or Retry all failed for old failed items; cancelled rows require their
individual Retry button. Clearing the library is not necessary for this update.

To repeat the opt-in live download check:

```powershell
$env:LIVE_PROBE = '1'
$env:LIVE_DOWNLOAD = '1'
$env:PROBE_URLS = 'https://www.tiktok.com/@covertfilm/video/7668725516802821406'
npm.cmd test -- tests/live
```

Upstream references: [yt-dlp options](https://github.com/yt-dlp/yt-dlp#usage-and-options)
and [Node child process termination](https://nodejs.org/api/child_process.html#subprocesskillsignal).
