import asyncio
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import snoo_helper  # noqa: E402
from detector import Settings  # noqa: E402
from python_snoo.containers import SnooData, SnooDevice  # noqa: E402
from python_snoo.exceptions import InvalidSnooAuth  # noqa: E402


def snoo_device(serial, name):
    return SnooDevice.from_dict({
        "serialNumber": serial,
        "firmwareVersion": "v1",
        "babyIds": [],
        "name": name,
        "awsIoT": {"awsRegion": "us-east-1", "clientEndpoint": "example", "clientReady": True, "thingName": serial},
    })


def snoo_message(state, event):
    return SnooData.from_dict({
        "left_safety_clip": 1,
        "rx_signal": {},
        "right_safety_clip": 1,
        "sw_version": "v1",
        "event_time_ms": 0,
        "system_state": "normal",
        "event": event,
        "state_machine": {
            "up_transition": "NONE",
            "since_session_start_ms": 0,
            "sticky_white_noise": "off",
            "weaning": "off",
            "time_left": -1,
            "session_id": "s",
            "state": state,
            "is_active_session": True,
            "down_transition": "NONE",
            "hold": "off",
            "audio": "on",
        },
    })


class FakeSnoo:
    """Stands in for python_snoo.Snoo, answering status checks unless told not to."""

    def __init__(self, devices, answers=True, fail_auth=False):
        self.devices = devices
        self.answers = answers
        self.fail_auth = fail_auth
        self.callbacks = {}
        self.states = {}
        self.disconnected = False

    async def authorize(self):
        if self.fail_auth:
            raise InvalidSnooAuth()

    async def get_devices(self):
        return self.devices

    def start_subscribe(self, device, function):
        self.callbacks[device.serialNumber] = function

    async def get_status(self, device):
        if self.answers:
            state = self.states.get(device.serialNumber, "BASELINE")
            self.callbacks[device.serialNumber](snoo_message(state, "status_requested"))

    async def disconnect(self):
        self.disconnected = True

    def push(self, serial, state, event):
        self.states[serial] = state
        self.callbacks[serial](snoo_message(state, event))


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.saved = {
            name: getattr(snoo_helper, name)
            for name in ["HEARTBEAT_S", "REPLY_TIMEOUT_S", "ALIVE_S", "TICK_S", "RECONNECT_MIN_S"]
        }
        snoo_helper.HEARTBEAT_S = 0.05
        snoo_helper.REPLY_TIMEOUT_S = 0.05
        snoo_helper.ALIVE_S = 0.2
        snoo_helper.TICK_S = 0.02
        snoo_helper.RECONNECT_MIN_S = 0.01

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(snoo_helper, name, value)

    def run_helper(self, fakes, script, seconds=0.5):
        """Runs the helper against fake SNOO clients and returns what it printed."""
        made = iter(fakes)

        async def scenario():
            helper = snoo_helper.Helper("e", "p", Settings(), snoo_factory=lambda *_: next(made))
            task = asyncio.create_task(helper.run())
            await script()
            await asyncio.sleep(seconds)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        out = io.StringIO()
        with redirect_stdout(out):
            asyncio.run(scenario())
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_reports_devices_and_a_cry(self):
        fake = FakeSnoo([snoo_device("S1", "Nursery SNOO")])

        async def script():
            await asyncio.sleep(0.1)
            fake.push("S1", "LEVEL1", "cry")

        lines = self.run_helper([fake], script)
        self.assertIn({"type": "devices", "devices": [{"serial": "S1", "name": "Nursery SNOO"}]}, lines)
        self.assertIn({"type": "crying", "serial": "S1", "on": False}, lines)
        self.assertIn({"type": "crying", "serial": "S1", "on": True}, lines)
        self.assertIn({"type": "alive"}, lines)

    def test_tracks_each_snoo_separately(self):
        fake = FakeSnoo([snoo_device("S1", "Left"), snoo_device("S2", "Right")])

        async def script():
            await asyncio.sleep(0.1)
            fake.push("S2", "LEVEL1", "cry")

        lines = self.run_helper([fake], script)
        crying = {(line["serial"], line["on"]) for line in lines if line["type"] == "crying"}
        self.assertIn(("S2", True), crying)
        self.assertNotIn(("S1", True), crying)

    def test_bad_login_is_reported(self):
        async def script():
            pass

        lines = self.run_helper([FakeSnoo([], fail_auth=True)], script, seconds=0.1)
        self.assertIn({"type": "auth_failed"}, lines)

    def test_reconnects_when_the_snoo_stops_answering(self):
        silent = FakeSnoo([snoo_device("S1", "Nursery SNOO")], answers=False)
        healthy = FakeSnoo([snoo_device("S1", "Nursery SNOO")])

        async def script():
            pass

        self.run_helper([silent, healthy], script)
        self.assertTrue(silent.disconnected)
        self.assertIn("S1", healthy.callbacks)


if __name__ == "__main__":
    unittest.main()
