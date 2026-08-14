import { describe, expect, it } from 'vitest';
import { gpuNameFrom, processLabel, summarise } from '@main/system/resource-monitor';

/**
 * The figures behind the status bar.
 *
 * Electron splits one app across several processes, so every number here is a
 * sum the user cannot get from Task Manager — which is the reason the bar
 * exists. The arithmetic is separated from Electron so it can be checked.
 */
describe('summarising what the app costs', () => {
  const metrics = [
    { type: 'Browser', cpu: { percentCPUUsage: 40 }, memory: { workingSetSize: 120_000 } },
    { type: 'Tab', cpu: { percentCPUUsage: 120 }, memory: { workingSetSize: 260_000 } },
    { type: 'GPU', cpu: { percentCPUUsage: 8 }, memory: { workingSetSize: 90_000 } },
    { type: 'Utility', cpu: { percentCPUUsage: 32 }, memory: { workingSetSize: 30_000 } },
  ];

  it('reports CPU as a share of the machine, not of one core', () => {
    // Chromium reports each process against a single core, so these four sum
    // to 200 — which on an 8-core machine is a quarter of it, not double it.
    const sample = summarise({ metrics, cpuCount: 8 });
    expect(sample.cpuPercent).toBeCloseTo(25);

    // The identical load on a 2-core machine is genuinely most of it.
    expect(summarise({ metrics, cpuCount: 2 }).cpuPercent).toBeCloseTo(100);
  });

  it('never reports more than the machine has', () => {
    // A sampling window landing badly can overshoot, and a meter reading 137%
    // is read as a bug rather than as load.
    const busy = [{ type: 'Tab', cpu: { percentCPUUsage: 900 } }];
    expect(summarise({ metrics: busy, cpuCount: 4 }).cpuPercent).toBe(100);
  });

  it('adds up every process, because no single one is "the app"', () => {
    const sample = summarise({ metrics, cpuCount: 8, systemMemory: { total: 16_777_216, free: 8_000_000 } });
    expect(sample.memoryBytes).toBe(500_000 * 1_024);
    expect(sample.systemMemoryBytes).toBe(16_777_216 * 1_024);
    expect(sample.processCount).toBe(4);
  });

  it('survives metrics with fields missing', () => {
    const sample = summarise({ metrics: [{ type: 'Tab' }], cpuCount: 4 });
    expect(sample.cpuPercent).toBe(0);
    expect(sample.memoryBytes).toBe(0);
  });

  it('attributes GPU memory to the GPU process alone', () => {
    const sample = summarise({ metrics, cpuCount: 8, gpuName: 'Intel Iris Xe', accelerated: true });
    expect(sample.gpu).toEqual({ name: 'Intel Iris Xe', accelerated: true, memoryBytes: 90_000 * 1_024 });
  });

  it('reports no GPU rather than an empty one', () => {
    expect(summarise({ metrics, cpuCount: 8 }).gpu).toBeNull();
    expect(summarise({ metrics, cpuCount: 8, gpuName: null }).gpu).toBeNull();
  });
});

describe('naming the adapter', () => {
  it('prefers the device string, and marks the active card', () => {
    expect(
      gpuNameFrom({
        gpuDevice: [
          { active: false, deviceString: 'Microsoft Basic Render Driver' },
          { active: true, deviceString: 'NVIDIA GeForce RTX 4060' },
        ],
      }),
    ).toBe('NVIDIA GeForce RTX 4060');
  });

  it('falls back to the GL renderer when no device string is given', () => {
    expect(gpuNameFrom({ gpuDevice: [{ vendorId: 32902 }], auxAttributes: { glRenderer: 'ANGLE (Intel)' } })).toBe(
      'ANGLE (Intel)',
    );
  });

  it('gives up quietly rather than showing a hex ID', () => {
    // "GPU 0x8086" is worse than no GPU row at all.
    expect(gpuNameFrom({ gpuDevice: [{ vendorId: 32902, deviceId: 16 }] })).toBeNull();
    expect(gpuNameFrom(null)).toBeNull();
    expect(gpuNameFrom('nope')).toBeNull();
  });
});

describe('labelling processes', () => {
  it('uses words rather than Chromium\'s internal names', () => {
    expect(processLabel('Browser')).toBe('main');
    expect(processLabel('Tab')).toBe('window');
    expect(processLabel('Pepper Plugin')).toBe('pepper plugin');
  });
});
