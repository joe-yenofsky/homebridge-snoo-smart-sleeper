import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Logging } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Helper, parseLine } from '../src/helper.js';

describe('parseLine', () => {
  it('reads each message type', () => {
    expect(parseLine('{"type":"devices","devices":[{"serial":"S1","name":"Nursery"}]}'))
      .toEqual({ type: 'devices', devices: [{ serial: 'S1', name: 'Nursery' }] });
    expect(parseLine('{"type":"crying","serial":"S1","on":true}'))
      .toEqual({ type: 'crying', serial: 'S1', on: true });
    expect(parseLine('{"type":"auth_failed"}')).toEqual({ type: 'auth_failed' });
    expect(parseLine('{"type":"alive"}')).toEqual({ type: 'alive' });
  });

  it.each([
    'not json',
    'null',
    '{"type":"crying","serial":1,"on":true}',
    '{"type":"crying","serial":"S1","on":"yes"}',
    '{"type":"devices","devices":[{"serial":"S1"}]}',
    '{"type":"something_new"}',
  ])('ignores %s', (line) => {
    expect(parseLine(line)).toBeUndefined();
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  print(line: string): void {
    this.stdout.write(`${line}\n`);
  }
}

function fakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), log: vi.fn() };
}

describe('Helper', () => {
  let children: FakeChild[];
  let spawn: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof fakeLog>;
  let onMessage: ReturnType<typeof vi.fn>;
  let helper: Helper;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    log = fakeLog();
    onMessage = vi.fn();
    helper = new Helper({
      python: '/venv/bin/python',
      script: '/plugin/python/snoo_helper.py',
      env: { SNOO_EMAIL: 'parent@example.com', SNOO_PASSWORD: 'secret' },
      log: log as unknown as Logging,
      onMessage,
      silenceMs: 60_000,
      spawn: spawn as never,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes credentials in the environment, not the command line', () => {
    helper.start();
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('/venv/bin/python');
    expect(args).toEqual(['-u', '/plugin/python/snoo_helper.py']);
    expect(options.env).toMatchObject({ SNOO_EMAIL: 'parent@example.com', SNOO_PASSWORD: 'secret' });
  });

  it('hands parsed stdout lines to onMessage', async () => {
    helper.start();
    children[0].print('{"type":"crying","serial":"S1","on":true}');
    children[0].print('garbage');
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith({ type: 'crying', serial: 'S1', on: true }));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('logs stderr at the matching level and keeps tracebacks at the last level', async () => {
    helper.start();
    children[0].stderr.write("WARNING Nursery didn't answer a status check\n");
    children[0].stderr.write('ERROR SNOO connection failed\nTraceback (most recent call last):\n');
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2));
    expect(log.warn).toHaveBeenCalledWith('%s', "Nursery didn't answer a status check");
    expect(log.error).toHaveBeenCalledWith('%s', 'SNOO connection failed');
    expect(log.error).toHaveBeenCalledWith('%s', 'Traceback (most recent call last):');
  });

  it('restarts the helper after it exits, backing off each time', async () => {
    helper.start();
    children[0].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledTimes(2);

    children[1].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('kills a helper that goes quiet, then starts a fresh one', async () => {
    helper.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(children[0].signals).toEqual(['SIGKILL']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('leaves a helper alone while it keeps printing', async () => {
    helper.start();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      children[0].print('{"type":"alive"}');
    }
    expect(children[0].signals).toEqual([]);
  });

  it('stops the helper on shutdown without restarting it', async () => {
    helper.start();
    await helper.stop();
    expect(children[0].signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
