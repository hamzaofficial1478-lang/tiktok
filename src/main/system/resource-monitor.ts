/**
 * What this app is costing the machine it runs on.
 *
 * A downloader that runs for an hour with several ffmpeg passes behind it is
 * exactly the kind of program people want to keep an eye on, and "open Task
 * Manager and add up four processes named after the app" is not an answer —
 * Electron splits itself across a browser process, a renderer, a GPU process
 * and one utility process per sidecar, so the number in Task Manager is never
 * the number the user is looking for.
 *
 * Kept free of `electron` imports so the arithmetic is testable: the shell
 * passes the metrics in, this decides what they mean.
 */

/** The shape of Electron's `ProcessMetric`, narrowed to what is used. */
export interface RawProcessMetric {
  readonly type: string;
  readonly cpu?: { readonly percentCPUUsage?: number } | undefined;
  readonly memory?: { readonly workingSetSize?: number } | undefined;
}

export interface RawSystemMemory {
  /** Kilobytes, as `process.getSystemMemoryInfo` reports them. */
  readonly total: number;
  readonly free: number;
}

/** Cumulative per-core CPU times, as `os.cpus()` reports them. */
export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

/** Sums `os.cpus()` into one idle/total pair for delta comparison. */
export function totalCpuTimes(cpus: readonly { times: Record<string, number> }[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const [mode, value] of Object.entries(cpu.times)) {
      total += value;
      if (mode === 'idle') idle += value;
    }
  }
  return { idle, total };
}

/**
 * How busy the machine has been since the previous sample.
 *
 * This is what makes the meter move at all during a download. `getAppMetrics`
 * only sees Electron's own processes, and every expensive thing this app does
 * — yt-dlp pulling bytes, ffmpeg burning captions or removing a watermark —
 * happens in a child process Chromium knows nothing about. Reporting only the
 * Electron side is why the meter sat at 0% while the machine was working.
 */
export function cpuBusyPercent(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  // The first sample has no previous to compare against, and a zero window
  // would divide by zero rather than mean "idle".
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

export interface ResourceSample {
  /**
   * Share of the whole machine's CPU, 0-100.
   *
   * Chromium reports each process as a percentage of one core, so eight busy
   * cores read as 800. Dividing by the core count gives the figure a user can
   * compare against the one Task Manager shows them, rather than a number that
   * looks alarming on a laptop and fine on a workstation for identical load.
   */
  readonly cpuPercent: number;
  /**
   * How busy the whole machine is, 0-100, or null on the first sample.
   *
   * Shown next to the app's own figure rather than instead of it, because
   * during a download they answer different questions: the app's share is
   * small and steady, and the machine's is where the work actually shows up.
   */
  readonly systemCpuPercent: number | null;
  /** Bytes of working set across every process this app owns. */
  readonly memoryBytes: number;
  /** Bytes in use across the machine, for the same reason as systemCpuPercent. */
  readonly systemMemoryUsedBytes: number | null;
  /** Bytes the machine has in total, for "1.2 GB of 16 GB". */
  readonly systemMemoryBytes: number | null;
  readonly processCount: number;
  /**
   * The GPU, when there is one worth naming.
   *
   * Deliberately not a utilisation percentage: Electron exposes no such
   * measurement, and inventing one from the GPU process's CPU time would be a
   * number that looks authoritative and means nothing. What can be said
   * honestly is which adapter is in use, whether the app is actually rendering
   * through it, and what that process costs in memory.
   */
  readonly gpu: GpuInfo | null;
}

export interface GpuInfo {
  readonly name: string;
  /** False when Chromium fell back to software rendering. */
  readonly accelerated: boolean;
  readonly memoryBytes: number;
}

const KB = 1_024;

/** Types Electron reports; the browser process is the app's own main process. */
const PROCESS_LABELS: Record<string, string> = {
  Browser: 'main',
  Tab: 'window',
  GPU: 'gpu',
  Utility: 'utility',
};

export function summarise(input: {
  readonly metrics: readonly RawProcessMetric[];
  readonly cpuCount: number;
  readonly systemMemory?: RawSystemMemory | null;
  readonly systemCpuPercent?: number | null;
  readonly gpuName?: string | null;
  readonly accelerated?: boolean;
}): ResourceSample {
  let cpuTotal = 0;
  let memoryTotal = 0;
  let gpuMemory = 0;

  for (const metric of input.metrics) {
    cpuTotal += metric.cpu?.percentCPUUsage ?? 0;
    const bytes = (metric.memory?.workingSetSize ?? 0) * KB;
    memoryTotal += bytes;
    if (metric.type === 'GPU') gpuMemory += bytes;
  }

  const cores = Math.max(1, input.cpuCount);
  // Clamped because a sampling window that lands badly can briefly report more
  // than the machine has, and a meter reading 137% reads as a bug.
  const cpuPercent = Math.min(100, Math.max(0, cpuTotal / cores));

  return {
    cpuPercent,
    systemCpuPercent: input.systemCpuPercent ?? null,
    memoryBytes: memoryTotal,
    systemMemoryUsedBytes: input.systemMemory ? (input.systemMemory.total - input.systemMemory.free) * KB : null,
    systemMemoryBytes: input.systemMemory ? input.systemMemory.total * KB : null,
    processCount: input.metrics.length,
    gpu: input.gpuName
      ? { name: input.gpuName, accelerated: input.accelerated ?? false, memoryBytes: gpuMemory }
      : null,
  };
}

/** Human label for a process type, for the breakdown tooltip. */
export function processLabel(type: string): string {
  return PROCESS_LABELS[type] ?? type.toLowerCase();
}

/**
 * Picks a readable adapter name out of Electron's GPU report.
 *
 * `getGPUInfo('basic')` returns a structure whose useful field moves between
 * platforms — a device string on Windows, a vendor/device ID pair elsewhere —
 * so this reads whichever is present and gives up quietly rather than
 * displaying "GPU 0x8086".
 */
export function gpuNameFrom(info: unknown): string | null {
  if (typeof info !== 'object' || info === null) return null;
  const record = info as Record<string, unknown>;

  const devices = Array.isArray(record.gpuDevice) ? (record.gpuDevice as Record<string, unknown>[]) : [];
  const active = devices.find((device) => device.active === true) ?? devices[0];

  for (const candidate of [
    active?.deviceString,
    active?.driverVendor,
    (record.auxAttributes as Record<string, unknown> | undefined)?.glRenderer,
  ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}
