import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logging } from 'homebridge';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensurePythonEnv, findPython, isSupportedPython, stampFor, type Exec } from '../src/python.js';

describe('isSupportedPython', () => {
  it.each([
    ['Python 3.11.9', true],
    ['Python 3.13.5', true],
    ['Python 3.10.12', false],
    ['Python 2.7.18', false],
    ['Python 4.0.0', false],
    ['zsh: command not found: python', false],
  ])('%s → %s', (output, supported) => {
    expect(isSupportedPython(output)).toBe(supported);
  });
});

describe('stampFor', () => {
  it('changes when the requirements or the Python version change', () => {
    const stamp = stampFor('python-snoo==0.11.0\n', 'Python 3.13.5');
    expect(stampFor('python-snoo==0.11.0\n', 'Python 3.13.5')).toBe(stamp);
    expect(stampFor('python-snoo==0.12.0\n', 'Python 3.13.5')).not.toBe(stamp);
    expect(stampFor('python-snoo==0.11.0\n', 'Python 3.14.0')).not.toBe(stamp);
  });
});

describe('findPython', () => {
  it('falls back from python3 to python', async () => {
    const exec: Exec = vi.fn(async (command) => {
      if (command === 'python3') {
        throw new Error('ENOENT');
      }
      return 'Python 3.12.1\n';
    });
    await expect(findPython(exec)).resolves.toEqual({ command: 'python', version: 'Python 3.12.1' });
  });

  it('rejects a configured interpreter that is too old', async () => {
    const exec: Exec = vi.fn(async () => 'Python 3.9.6\n');
    await expect(findPython(exec, '/usr/bin/python3')).rejects.toThrow(/pythonPath/);
  });
});

describe('ensurePythonEnv', () => {
  let storagePath: string;
  let pythonDir: string;
  let calls: string[][];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logging;

  // Answers --version, and makes "-m venv" create the interpreter it would.
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '--version') {
      return 'Python 3.13.5\n';
    }
    if (args[1] === 'venv') {
      await mkdir(path.join(args[2], 'bin'), { recursive: true });
      await writeFile(path.join(args[2], 'bin', 'python'), '');
    }
    return '';
  };
  const setupCalls = () => calls.filter((c) => c.includes('venv') || c.includes('pip'));

  beforeEach(async () => {
    storagePath = await mkdtemp(path.join(os.tmpdir(), 'snoo-storage-'));
    pythonDir = await mkdtemp(path.join(os.tmpdir(), 'snoo-python-'));
    await writeFile(path.join(pythonDir, 'requirements.txt'), 'python-snoo==0.11.0\n');
    calls = [];
  });

  it('creates the venv and installs python-snoo the first time only', async () => {
    const venvPython = path.join(storagePath, 'snoo-smart-sleeper', 'venv', 'bin', 'python');
    await expect(ensurePythonEnv({ storagePath, pythonDir, log, exec })).resolves.toBe(venvPython);
    expect(setupCalls()).toHaveLength(2);

    calls = [];
    await expect(ensurePythonEnv({ storagePath, pythonDir, log, exec })).resolves.toBe(venvPython);
    expect(setupCalls()).toHaveLength(0);
  });

  it('reinstalls when requirements.txt changes', async () => {
    await ensurePythonEnv({ storagePath, pythonDir, log, exec });
    await writeFile(path.join(pythonDir, 'requirements.txt'), 'python-snoo==0.12.0\n');
    calls = [];
    await ensurePythonEnv({ storagePath, pythonDir, log, exec });
    expect(setupCalls()).toHaveLength(2);
  });

  it('explains a missing venv module', async () => {
    const noVenv: Exec = async (command, args) => {
      if (args[1] === 'venv') {
        throw Object.assign(new Error('failed'), { stderr: 'ensurepip is not available' });
      }
      return exec(command, args);
    };
    await expect(ensurePythonEnv({ storagePath, pythonDir, log, exec: noVenv }))
      .rejects.toThrow(/python3-venv/);
  });
});
