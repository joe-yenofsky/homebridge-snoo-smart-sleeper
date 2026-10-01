import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

from detector import Detector, Settings  # noqa: E402

# Two real nights from one SNOO, 2026-09-28 to 09-30. Times are seconds from the
# first message; only the fields the detector reads are kept.
NIGHTS = Path(__file__).parent / "fixtures" / "nights.jsonl"


def replay(detector, events):
    """Feeds recorded events second by second and returns (t, crying) at each change."""
    transitions, last, i = [], False, 0
    for t in range(events[-1]["t"] + 601):
        while i < len(events) and events[i]["t"] <= t:
            e = events[i]
            detector.observe(e["t"], e["state"], e["hold"] == "on", e["event"])
            i += 1
        crying = detector.evaluate(t)
        if crying != last:
            transitions.append((t, crying))
            last = crying
    return transitions


class Feeding:
    def feed(self, t, state, event="timer", hold=False):
        self.d.observe(t, state, hold, event)
        return self.d.evaluate(t)

    def states_between(self, start, end):
        return {self.d.evaluate(t) for t in range(start, end, 5)}


class FirstCryTest(Feeding, unittest.TestCase):
    """The default: on at the first cry, one alert per spell."""

    def setUp(self):
        self.d = Detector()

    def test_first_cry_turns_it_on_once_per_spell(self):
        self.feed(0, "BASELINE", "activity")
        self.assertTrue(self.feed(10, "LEVEL1", "cry"))
        for t, state in [(37, "LEVEL2"), (58, "LEVEL3"), (75, "LEVEL4")]:
            self.assertTrue(self.feed(t, state, "cry"))
        self.assertFalse(self.feed(116, "ONLINE", "activity"))

    def test_spell_ends_after_five_calm_minutes(self):
        self.feed(0, "BASELINE", "status_requested")
        self.assertTrue(self.feed(10, "LEVEL1", "cry"))
        self.feed(100, "BASELINE")
        self.assertEqual(self.states_between(100, 400), {True})
        self.assertFalse(self.d.evaluate(400))

    def test_unclipping_him_ends_the_spell(self):
        self.feed(0, "BASELINE", "status_requested")
        self.assertTrue(self.feed(10, "LEVEL1", "cry"))
        self.assertFalse(self.feed(60, "LEVEL1", "safety_clip"))

    def test_raising_the_level_from_the_app_is_not_crying(self):
        self.feed(0, "BASELINE", "status_requested")
        self.feed(10, "LEVEL1", "command")
        self.feed(490, "BASELINE")
        self.assertEqual(self.states_between(10, 900), {False})

    def test_level_lock_is_the_resting_level(self):
        self.feed(0, "LEVEL2", "command", hold=True)
        for t in range(60, 3600, 180):
            self.assertFalse(self.feed(t, "LEVEL2", "status_requested", hold=True))
        self.assertTrue(self.feed(3600, "LEVEL3", "cry", hold=True))
        self.feed(3700, "LEVEL2", hold=True)
        self.assertFalse(self.d.evaluate(4000))

    def test_changing_the_locked_level_from_the_app_is_not_crying(self):
        self.feed(0, "LEVEL1", "command", hold=True)
        self.feed(60, "LEVEL2", "command", hold=True)
        self.assertEqual(self.states_between(60, 1200), {False})

    def test_a_stale_timeout_after_picking_him_up_does_not_realert(self):
        self.feed(0, "BASELINE", "status_requested")
        for t, state in [(10, "LEVEL1"), (30, "LEVEL2"), (50, "LEVEL3"), (70, "LEVEL4")]:
            self.feed(t, state, "cry")
        self.assertTrue(self.feed(190, "PRETIMEOUT"))
        self.assertFalse(self.feed(250, "TIMEOUT", "safety_clip"))
        self.assertFalse(self.feed(430, "TIMEOUT", "status_requested"))

    def test_it_stays_on_while_the_snoo_sits_stopped_after_timeout(self):
        self.feed(0, "BASELINE", "status_requested")
        self.feed(10, "LEVEL1", "cry")
        self.feed(70, "LEVEL4", "cry")
        self.feed(190, "PRETIMEOUT")
        self.feed(310, "TIMEOUT")
        self.feed(320, "ONLINE")
        self.assertEqual(self.states_between(320, 1810), {True})
        # Gives up after max_spell_s so a stuck state can't mute the next spell.
        self.assertFalse(self.d.evaluate(1810))

    def test_starting_mid_escalation_waits_for_a_real_climb(self):
        self.feed(0, "LEVEL3", "status_requested")
        self.assertEqual(self.states_between(0, 600), {False})
        self.assertTrue(self.feed(600, "LEVEL4"))

    def test_replay_of_two_real_nights(self):
        events = [json.loads(line) for line in NIGHTS.read_text().splitlines()]
        # He cried at 00:13:47 and 06:37:45; both times a parent pressed the
        # SNOO's button within two minutes. Same result as the Docker bridge gave.
        self.assertEqual(
            replay(Detector(), events),
            [(46165, True), (46215, False), (155603, True), (155709, False)],
        )


class DelayTest(Feeding, unittest.TestCase):
    """With crying_after_s set, it waits for sustained crying."""

    def setUp(self):
        self.d = Detector(Settings(crying_after_s=180))

    def test_continuous_crying_turns_it_on_after_the_delay(self):
        self.feed(0, "BASELINE", "status_requested")
        self.feed(10, "LEVEL1", "cry")
        self.feed(70, "LEVEL2")
        self.feed(130, "LEVEL3")
        self.assertEqual(self.states_between(130, 190), {False})
        self.assertTrue(self.feed(190, "LEVEL4"))

    def test_a_short_fuss_that_settles_stays_quiet(self):
        self.feed(0, "BASELINE", "status_requested")
        self.feed(10, "LEVEL1", "cry")
        self.feed(100, "BASELINE")
        self.assertEqual(self.states_between(100, 600), {False})

    def test_a_slow_step_down_after_a_short_cry_stays_quiet(self):
        self.feed(0, "BASELINE", "status_requested")
        self.feed(10, "LEVEL1", "cry")
        self.feed(30, "LEVEL2", "cry")
        # He settles; the SNOO holds Level 2 for 6 minutes and Level 1 for 8.
        self.feed(390, "LEVEL1")
        self.feed(870, "BASELINE")
        self.assertEqual(self.states_between(30, 1170), {False})

    def test_sitting_at_level_4_counts_as_still_crying(self):
        # Real crying climbs Level 1 to 4 in about a minute, then has nowhere to go.
        self.feed(0, "BASELINE", "status_requested")
        for t, state in [(10, "LEVEL1"), (25, "LEVEL2"), (40, "LEVEL3"), (60, "LEVEL4")]:
            self.feed(t, state, "cry")
        self.assertEqual(self.states_between(60, 190), {False})
        self.assertTrue(self.d.evaluate(190))

    def test_stepping_down_from_level_4_means_he_settled(self):
        self.feed(0, "BASELINE", "status_requested")
        for t, state in [(10, "LEVEL1"), (25, "LEVEL2"), (40, "LEVEL3"), (60, "LEVEL4")]:
            self.feed(t, state, "cry")
        self.feed(180, "LEVEL3")
        self.assertEqual(self.states_between(180, 600), {False})

    def test_climbing_into_pretimeout_turns_it_on_before_the_delay(self):
        self.feed(0, "BASELINE", "status_requested")
        for t, state in [(10, "LEVEL1"), (25, "LEVEL2"), (40, "LEVEL3"), (60, "LEVEL4")]:
            self.feed(t, state, "cry")
        self.assertTrue(self.feed(100, "PRETIMEOUT"))


if __name__ == "__main__":
    unittest.main()
