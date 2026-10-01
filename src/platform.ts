import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { CryingSensor } from './accessories.js';
import { Helper, type HelperMessage } from './helper.js';
import { ensurePythonEnv } from './python.js';
import { PLATFORM_NAME, PLUGIN_NAME, type SnooConfig } from './settings.js';

const PYTHON_DIR = fileURLToPath(new URL('../python/', import.meta.url));

export class SnooPlatform implements DynamicPlatformPlugin {
  private readonly config: SnooConfig;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly sensors = new Map<string, CryingSensor>();
  private helper?: Helper;
  private testSent = false;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    this.config = config as SnooConfig;
    if (!this.config.email || !this.config.password) {
      log.error('Add your Happiest Baby email and password in the plugin settings.');
      return;
    }
    api.on('didFinishLaunching', () => void this.start());
    api.on('shutdown', () => void this.helper?.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
    if (typeof accessory.context.serial === 'string') {
      this.sensors.set(accessory.context.serial, new CryingSensor(this.api, accessory));
    }
  }

  private async start(): Promise<void> {
    let python: string;
    try {
      python = await ensurePythonEnv({
        storagePath: this.api.user.storagePath(),
        pythonDir: PYTHON_DIR,
        pythonPath: this.config.pythonPath,
        log: this.log,
      });
    } catch (e) {
      this.log.error(e instanceof Error ? e.message : String(e));
      return;
    }
    this.helper = new Helper({
      python,
      script: path.join(PYTHON_DIR, 'snoo_helper.py'),
      env: this.helperEnv(),
      log: this.log,
      onMessage: (message) => this.handle(message),
    });
    this.helper.start();
  }

  private helperEnv(): Record<string, string> {
    const env: Record<string, string> = {
      SNOO_EMAIL: this.config.email!,
      SNOO_PASSWORD: this.config.password!,
      CRYING_AFTER_S: String(this.config.cryingDelaySeconds ?? 0),
      CALM_RESET_S: String((this.config.calmResetMinutes ?? 5) * 60),
    };
    if (this.config.eventLog) {
      env.EVENT_LOG = path.join(this.api.user.storagePath(), 'snoo-smart-sleeper', 'events.jsonl');
    }
    return env;
  }

  private handle(message: HelperMessage): void {
    switch (message.type) {
    case 'devices':
      this.syncDevices(message.devices);
      break;
    case 'crying':
      this.sensors.get(message.serial)?.update(message.on);
      break;
    case 'auth_failed':
      this.log.error('Happiest Baby rejected the email/password. Check them in the plugin settings.');
      break;
    case 'alive':
      break;
    }
  }

  private syncDevices(devices: { serial: string; name: string }[]): void {
    const baseName = this.config.accessoryName?.trim() || 'Baby Crying';
    const current = new Set<string>();
    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.serial}:crying`);
      current.add(uuid);
      if (this.accessories.has(uuid)) {
        continue;
      }
      const name = devices.length > 1 ? `${baseName} (${device.name})` : baseName;
      const accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.serial = device.serial;
      this.sensors.set(device.serial, new CryingSensor(this.api, accessory));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info('Added %s for %s', name, device.name);
    }

    const stale = [...this.accessories.values()].filter((a) => !current.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const accessory of stale) {
        this.accessories.delete(accessory.UUID);
        this.sensors.delete(accessory.context.serial);
        this.log.info('Removed %s', accessory.displayName);
      }
    }

    if (this.config.testAlertOnStartup && !this.testSent) {
      this.testSent = true;
      this.log.info('Sending a test alert. Turn off "testAlertOnStartup" when you\'re done.');
      for (const sensor of this.sensors.values()) {
        sensor.test();
      }
    }
  }
}
