import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { Logging } from 'homebridge';

/** What the Python helper prints on stdout, one JSON object per line. */
export type HelperMessage =
  | { type: 'devices'; devices: { serial: string; name: string }[] }
  | { type: 'crying'; serial: string; on: boolean }
  | { type: 'auth_failed' }
  | { type: 'alive' };

/** Parses one stdout line. Anything unexpected returns undefined. */
export function parseLine(line: string): HelperMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
  case 'devices': {
    const devices = message.devices;
    const valid = Array.isArray(devices) && devices.every((d) =>
      typeof d?.serial === 'string' && typeof d?.name === 'string');
    return valid
      ? { type: 'devices', devices: devices.map((d) => ({ serial: d.serial, name: d.name })) }
      : undefined;
  }
  case 'crying':
    return typeof message.serial === 'string' && typeof message.on === 'boolean'
      ? { type: 'crying', serial: message.serial, on: message.on }
      : undefined;
  case 'auth_failed':
  case 'alive':
    return { type: message.type };
  default:
    return undefined;
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<string, Level> = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warn',
  ERROR: 'error',
  CRITICAL: 'error',
};

const MIN_RESTART_MS = 5_000;
const MAX_RESTART_MS = 300_000;
const HEALTHY_RUN_MS = 600_000;
const KILL_GRACE_MS = 5_000;

export interface HelperOptions {
  python: string;
  script: string;
  env: Record<string, string>;
  log: Logging;
  onMessage: (message: HelperMessage) => void;
  /** Restart the helper if it prints nothing for this long. It says "alive" every minute. */
  silenceMs?: number;
  spawn?: typeof nodeSpawn;
}

/** Runs the Python helper, restarting it if it exits or goes quiet. */
export class Helper {
  private child?: ChildProcess;
  private stopped = false;
  private restartMs = MIN_RESTART_MS;
  private startedAt = 0;
  private lastOutput = 0;
  private lastLevel: Level = 'info';
  private restartTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;

  constructor(private readonly options: HelperOptions) {}

  start(): void {
    this.stopped = false;
    this.launch();
    const silenceMs = this.options.silenceMs ?? 180_000;
    this.watchdog = setInterval(() => {
      if (this.child && Date.now() - this.lastOutput > silenceMs) {
        this.options.log.warn('The SNOO helper stopped responding; restarting it.');
        this.child.kill('SIGKILL');
      }
    }, Math.min(30_000, silenceMs / 2));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    const child = this.child;
    if (!child) {
      return;
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private launch(): void {
    const { python, script, env, log, onMessage, spawn = nodeSpawn } = this.options;
    const child = spawn(python, ['-u', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAt = this.lastOutput = Date.now();
    createInterface({ input: child.stdout! }).on('line', (line) => {
      this.lastOutput = Date.now();
      const message = parseLine(line);
      if (message) {
        onMessage(message);
      } else {
        log.debug('SNOO helper: %s', line);
      }
    });
    createInterface({ input: child.stderr! }).on('line', (line) => this.logHelperLine(line));
    child.on('error', (e) => {
      log.error("Couldn't run the SNOO helper: %s", e.message);
      this.onExit(child, `error: ${e.message}`);
    });
    child.on('exit', (code, signal) => this.onExit(child, signal ?? `code ${code}`));
  }

  /** Python logs arrive as "LEVEL message"; lines without a level continue the last one. */
  private logHelperLine(line: string): void {
    const space = line.indexOf(' ');
    const level = LEVELS[space > 0 ? line.slice(0, space) : line];
    if (level) {
      this.lastLevel = level;
      this.options.log[level]('%s', line.slice(space + 1));
    } else {
      this.options.log[this.lastLevel]('%s', line);
    }
  }

  private onExit(child: ChildProcess, reason: string): void {
    if (child !== this.child) {
      return;
    }
    this.child = undefined;
    if (this.stopped) {
      return;
    }
    if (Date.now() - this.startedAt > HEALTHY_RUN_MS) {
      this.restartMs = MIN_RESTART_MS;
    }
    this.options.log.warn('The SNOO helper exited (%s); restarting in %d s.', reason, this.restartMs / 1000);
    this.restartTimer = setTimeout(() => this.launch(), this.restartMs);
    this.restartMs = Math.min(this.restartMs * 2, MAX_RESTART_MS);
  }
}
