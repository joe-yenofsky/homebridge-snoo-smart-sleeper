"""Runs python-snoo for the Homebridge plugin and reports crying on stdout.

Each stdout line is one JSON object:

    {"type": "devices", "devices": [{"serial": "...", "name": "..."}]}
    {"type": "crying", "serial": "...", "on": true}
    {"type": "auth_failed"}
    {"type": "alive"}

"crying" lines go out on every change and again after each "alive" line, so
the plugin can resync and can tell the helper hasn't hung. Logs go to stderr.

Settings come from environment variables: SNOO_EMAIL and SNOO_PASSWORD
(required), CRYING_AFTER_S, CALM_RESET_S, EVENT_LOG (a file path), and
SNOO_DEBUG=1 to include python-snoo's own logs.

`python snoo_helper.py --check` logs in, reads each SNOO once, and exits.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import aiohttp
from python_snoo.containers import SnooData, SnooDevice
from python_snoo.exceptions import InvalidSnooAuth, SnooCommandException
from python_snoo.snoo import Snoo

from detector import Detector, Settings

log = logging.getLogger("snoo_helper")

HEARTBEAT_S = 180
REPLY_TIMEOUT_S = 30
ALIVE_S = 60
TICK_S = 5
RECONNECT_MIN_S = 30
RECONNECT_MAX_S = 900
AUTH_RETRY_S = 3600


def emit(record: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def settings_from_env() -> Settings:
    names = {"crying_after_s": "CRYING_AFTER_S", "calm_reset_s": "CALM_RESET_S"}
    return Settings(**{field: float(os.environ[env]) for field, env in names.items() if os.environ.get(env)})


class EventLog:
    """Appends SNOO messages and sensor changes to a JSONL file, for tuning thresholds."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.last_state: dict[str, tuple[str, str]] = {}

    def message(self, serial: str, data: SnooData) -> None:
        sm = data.state_machine
        state = (sm.state.value, sm.hold)
        if data.event.value == "status_requested" and self.last_state.get(serial) == state:
            return  # a heartbeat reply with nothing new in it
        self.last_state[serial] = state
        self.write(
            serial=serial,
            event=data.event.value,
            state=sm.state.value,
            hold=sm.hold,
            time_left=sm.time_left,
            clips=[data.left_safety_clip, data.right_safety_clip],
        )

    def write(self, **record: object) -> None:
        record = {"t": datetime.now().astimezone().isoformat(timespec="seconds"), **record}
        try:
            with self.path.open("a") as f:
                f.write(json.dumps(record) + "\n")
        except OSError as e:
            log.warning("Couldn't write %s: %s", self.path, e)


class Device:
    """One SNOO: its detector, and whether it has answered the latest status check."""

    def __init__(
        self, info: SnooDevice, settings: Settings, events: EventLog | None, changed: asyncio.Event
    ) -> None:
        self.info = info
        self.detector = Detector(settings)
        self.events = events
        self.changed = changed
        self.heard = asyncio.Event()
        self.reported: bool | None = None

    @property
    def serial(self) -> str:
        return self.info.serialNumber

    def on_message(self, data: SnooData) -> None:
        # python-snoo calls this from its MQTT loop, so it must never raise.
        try:
            sm = data.state_machine
            self.detector.observe(time.monotonic(), sm.state.value, sm.hold == "on", data.event.value)
            if self.events:
                self.events.message(self.serial, data)
            self.heard.set()
        except Exception:
            log.exception("Couldn't handle a message from %s", self.info.name)
        self.changed.set()

    def report(self, resync: bool = False) -> None:
        crying = self.detector.evaluate(time.monotonic())
        if crying == self.reported and not resync:
            return
        if crying != self.reported:
            log.info("%s: crying %s", self.info.name, "ON" if crying else "off")
            if self.events:
                self.events.write(serial=self.serial, crying=crying)
        self.reported = crying
        emit({"type": "crying", "serial": self.serial, "on": crying})


class Helper:
    def __init__(
        self,
        email: str,
        password: str,
        settings: Settings,
        events: EventLog | None = None,
        snoo_factory: Callable[[str, str, aiohttp.ClientSession], Snoo] = Snoo,
    ) -> None:
        self.email = email
        self.password = password
        self.settings = settings
        self.events = events
        self.snoo_factory = snoo_factory
        self.devices: dict[str, Device] = {}
        self.changed = asyncio.Event()

    async def run(self) -> None:
        await asyncio.gather(self.connect_loop(), self.report_loop())

    async def report_loop(self) -> None:
        last_alive = float("-inf")
        while True:
            try:
                await asyncio.wait_for(self.changed.wait(), TICK_S)
            except TimeoutError:
                pass
            self.changed.clear()
            now = time.monotonic()
            resync = now - last_alive >= ALIVE_S
            if resync:
                last_alive = now
                emit({"type": "alive"})
            for device in self.devices.values():
                device.report(resync)

    async def connect_loop(self) -> None:
        delay = RECONNECT_MIN_S
        while True:
            try:
                if await self.run_session():
                    delay = RECONNECT_MIN_S
            except InvalidSnooAuth:
                emit({"type": "auth_failed"})
                log.error("Happiest Baby rejected the email/password; retrying in an hour")
                await asyncio.sleep(AUTH_RETRY_S)
                continue
            except Exception:
                log.exception("SNOO connection failed")
            log.info("Reconnecting to the SNOO in %d s", delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_S)

    async def run_session(self) -> bool:
        """Connects, then checks on every SNOO each HEARTBEAT_S until none of them answers.

        Returns whether any SNOO answered at least once.
        """
        answered = False
        async with aiohttp.ClientSession() as session:
            snoo = self.snoo_factory(self.email, self.password, session)
            try:
                await snoo.authorize()
                self._sync_devices(await snoo.get_devices())
                for device in self.devices.values():
                    snoo.start_subscribe(device.info, device.on_message)
                misses = dict.fromkeys(self.devices, 0)
                while True:
                    for device in self.devices.values():
                        if await self._check(snoo, device):
                            misses[device.serial], answered = 0, True
                        else:
                            misses[device.serial] += 1
                            log.warning(
                                "%s didn't answer a status check (%d in a row)",
                                device.info.name,
                                misses[device.serial],
                            )
                    if all(m >= 2 for m in misses.values()):
                        return answered
                    retry_soon = any(m == 1 for m in misses.values())
                    await asyncio.sleep(REPLY_TIMEOUT_S if retry_soon else HEARTBEAT_S)
            finally:
                await snoo.disconnect()

    def _sync_devices(self, infos: list[SnooDevice]) -> None:
        if not infos:
            raise RuntimeError("No SNOO on this Happiest Baby account")
        devices = {}
        for info in infos:
            device = self.devices.get(info.serialNumber)
            if device is None:
                device = Device(info, self.settings, self.events, self.changed)
            device.info = info
            devices[info.serialNumber] = device
        self.devices = devices
        emit({"type": "devices", "devices": [{"serial": d.serial, "name": d.info.name} for d in devices.values()]})
        log.info("Connected to %s", ", ".join(d.info.name for d in devices.values()))

    async def _check(self, snoo: Snoo, device: Device) -> bool:
        device.heard.clear()
        try:
            await snoo.get_status(device.info)
            await asyncio.wait_for(device.heard.wait(), REPLY_TIMEOUT_S)
            return True
        except SnooCommandException:
            # Its MQTT connection dropped; start_subscribe restarts a finished task.
            snoo.start_subscribe(device.info, device.on_message)
            return False
        except TimeoutError:
            return False


async def check(email: str, password: str) -> None:
    async with aiohttp.ClientSession() as session:
        snoo = Snoo(email, password, session)
        try:
            await snoo.authorize()
            devices = await snoo.get_devices()
            if not devices:
                raise SystemExit("No SNOO on this Happiest Baby account.")
            for device in devices:
                reply: asyncio.Future[SnooData] = asyncio.get_running_loop().create_future()
                snoo.start_subscribe(device, lambda data, r=reply: r.done() or r.set_result(data))
                await snoo.get_status(device)
                data = await asyncio.wait_for(reply, REPLY_TIMEOUT_S)
                print(f"{device.name}: live feed works, the SNOO reports {data.state_machine.state.value}.")
        finally:
            await snoo.disconnect()


def configure_logging() -> None:
    debug = bool(os.environ.get("SNOO_DEBUG"))
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    if not debug:
        # python-snoo logs serials and MQTT topics at INFO; keep only its warnings.
        handler.addFilter(lambda r: r.name.startswith("snoo_helper") or r.levelno >= logging.WARNING)
    logging.basicConfig(level=logging.DEBUG if debug else logging.INFO, handlers=[handler], force=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="SNOO helper for homebridge-snoo-smart-sleeper")
    parser.add_argument("--check", action="store_true", help="log in, read each SNOO once, and exit")
    args = parser.parse_args()
    configure_logging()
    email, password = os.environ.get("SNOO_EMAIL"), os.environ.get("SNOO_PASSWORD")
    if not email or not password:
        sys.exit("Set SNOO_EMAIL and SNOO_PASSWORD.")
    events = EventLog(Path(os.environ["EVENT_LOG"])) if os.environ.get("EVENT_LOG") else None
    try:
        if args.check:
            asyncio.run(check(email, password))
        else:
            asyncio.run(Helper(email, password, settings_from_env(), events).run())
    except InvalidSnooAuth:
        sys.exit("Happiest Baby rejected that email/password.")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
