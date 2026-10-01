import type { API, PlatformAccessory } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CryingSensor } from '../src/accessories.js';

class FakeService {
  readonly updates: unknown[] = [];
  getter?: () => unknown;

  setCharacteristic(): this {
    return this;
  }

  getCharacteristic() {
    return { onGet: (getter: () => unknown) => (this.getter = getter) };
  }

  updateCharacteristic(_characteristic: unknown, value: unknown): this {
    this.updates.push(value);
    return this;
  }
}

function setup(context: Record<string, unknown> = { serial: 'S1' }) {
  const services: Record<string, FakeService> = { info: new FakeService() };
  const accessory = {
    displayName: 'Baby Crying',
    context,
    getService: (type: string) => services[type],
    addService: (type: string) => (services[type] = new FakeService()),
  };
  const api = {
    hap: {
      Service: { AccessoryInformation: 'info', MotionSensor: 'motion' },
      Characteristic: { Manufacturer: 'm', Model: 'model', SerialNumber: 'sn', MotionDetected: 'motion-detected' },
    },
  };
  const sensor = new CryingSensor(api as unknown as API, accessory as unknown as PlatformAccessory);
  return { sensor, motion: services.motion, context };
}

describe('CryingSensor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates HomeKit only when the value changes', () => {
    const { sensor, motion, context } = setup();
    sensor.update(false);
    sensor.update(true);
    sensor.update(true);
    sensor.update(false);
    expect(motion.updates).toEqual([true, false]);
    expect(motion.getter?.()).toBe(false);
    expect(context.crying).toBe(false);
  });

  it('starts from the last known value, so a restart does not re-alert', () => {
    const { sensor, motion } = setup({ serial: 'S1', crying: true });
    expect(motion.getter?.()).toBe(true);
    sensor.update(true);
    expect(motion.updates).toEqual([]);
  });

  it('shows a test alert for 30 seconds, then the real state', async () => {
    vi.useFakeTimers();
    const { sensor, motion } = setup();
    sensor.test();
    sensor.update(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(motion.updates).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(motion.updates).toEqual([true, false]);
  });

  it('keeps a real cry on after the test alert ends', async () => {
    vi.useFakeTimers();
    const { sensor, motion } = setup();
    sensor.test();
    sensor.update(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(motion.updates).toEqual([true]);
  });
});
