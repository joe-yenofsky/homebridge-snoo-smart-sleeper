import type { PlatformConfig } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-snoo-smart-sleeper';
export const PLATFORM_NAME = 'SnooSmartSleeper';

export interface SnooConfig extends PlatformConfig {
  email?: string;
  password?: string;
  accessoryName?: string;
  cryingDelaySeconds?: number;
  calmResetMinutes?: number;
  pythonPath?: string;
  eventLog?: boolean;
  testAlertOnStartup?: boolean;
}
