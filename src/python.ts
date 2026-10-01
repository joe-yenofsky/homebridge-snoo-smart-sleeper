import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Logging } from 'homebridge';

/** Runs a command and resolves with its combined output; rejects on failure. */
export type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runCommand: Exec = async (command, args, timeoutMs = 60_000) => {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: timeoutMs });
  return `${stdout}${stderr}`;
};

/** python-snoo needs Python 3.11 or newer (and not 4). */
export function isSupportedPython(versionOutput: string): boolean {
  const match = /Python (\d+)\.(\d+)/.exec(versionOutput);
  return match !== null && Number(match[1]) === 3 && Number(match[2]) >= 11;
}

/** Identifies an install: rebuild when the requirements or the system Python change. */
export function stampFor(requirements: string, pythonVersion: string): string {
  return createHash('sha256').update(`${pythonVersion}\n${requirements}`).digest('hex');
}

export async function findPython(
  exec: Exec,
  configured?: string,
): Promise<{ command: string; version: string }> {
  const candidates = configured ? [configured] : ['python3', 'python'];
  for (const command of candidates) {
    try {
      const version = (await exec(command, ['--version'])).trim();
      if (isSupportedPython(version)) {
        return { command, version };
      }
    } catch {
      // Not installed under this name; try the next one.
    }
  }
  throw new Error(configured
    ? `${configured} isn't Python 3.11 or newer. Fix "pythonPath" in the plugin settings.`
    : 'This plugin needs Python 3.11 or newer. Install it, or set "pythonPath" in the plugin settings.');
}

/**
 * Makes sure a virtualenv with python-snoo exists under Homebridge's storage
 * directory, and returns its interpreter.
 */
export async function ensurePythonEnv(options: {
  storagePath: string;
  pythonDir: string;
  pythonPath?: string;
  log: Logging;
  exec?: Exec;
}): Promise<string> {
  const { storagePath, pythonDir, pythonPath, log, exec = runCommand } = options;
  const home = path.join(storagePath, 'snoo-smart-sleeper');
  const venv = path.join(home, 'venv');
  const venvPython = process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
  const requirements = path.join(pythonDir, 'requirements.txt');
  const stampFile = path.join(home, 'installed.sha256');

  const system = await findPython(exec, pythonPath);
  const stamp = stampFor(await readFile(requirements, 'utf8'), system.version);
  if (existsSync(venvPython) && (await readFile(stampFile, 'utf8').catch(() => '')) === stamp) {
    return venvPython;
  }

  log.info('Setting up %s with python-snoo. This takes a minute the first time.', system.version);
  await rm(venv, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  try {
    await exec(system.command, ['-m', 'venv', venv], 120_000);
  } catch (e) {
    throw new Error(`Couldn't create a Python virtual environment (${errorText(e)}). ` +
      'On Debian or Raspberry Pi OS, install the python3-venv package.', { cause: e });
  }
  try {
    await exec(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements], 600_000);
  } catch (e) {
    throw new Error(`Couldn't install python-snoo (${errorText(e)}).`, { cause: e });
  }
  await writeFile(stampFile, stamp);
  log.info('Python is ready.');
  return venvPython;
}

function errorText(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) {
    return stderr.trim().split('\n').slice(-3).join(' ');
  }
  return e instanceof Error ? e.message : String(e);
}
