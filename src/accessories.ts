import type { API, PlatformAccessory, Service } from 'homebridge';

const TEST_ALERT_MS = 10_000;

/** The "Baby Crying" motion sensor for one SNOO. */
export class CryingSensor {
  private readonly service: Service;
  private shown: boolean;
  private actual: boolean;
  private testing = false;

  constructor(private readonly api: API, readonly accessory: PlatformAccessory) {
    const { Service, Characteristic } = api.hap;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Happiest Baby')
      .setCharacteristic(Characteristic.Model, 'SNOO Smart Sleeper')
      .setCharacteristic(Characteristic.SerialNumber, String(accessory.context.serial ?? 'unknown'));
    this.service = accessory.getService(Service.MotionSensor)
      ?? accessory.addService(Service.MotionSensor, accessory.displayName);
    // Start from the last known value so a restart doesn't re-send an alert.
    this.shown = this.actual = accessory.context.crying === true;
    this.service.getCharacteristic(Characteristic.MotionDetected).onGet(() => this.shown);
  }

  update(crying: boolean): void {
    this.actual = crying;
    if (!this.testing) {
      this.show(crying);
    }
  }

  /** Turns the sensor on briefly so you can check notifications arrive. */
  test(): void {
    this.testing = true;
    this.show(true);
    setTimeout(() => {
      this.testing = false;
      this.show(this.actual);
    }, TEST_ALERT_MS);
  }

  private show(crying: boolean): void {
    if (crying === this.shown) {
      return;
    }
    this.shown = crying;
    this.accessory.context.crying = crying;
    this.service.updateCharacteristic(this.api.hap.Characteristic.MotionDetected, crying);
  }
}
