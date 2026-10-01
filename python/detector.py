"""Decides when the "Baby Crying" sensor is on, from the SNOO's state feed.

The SNOO hears crying and climbs a level, roughly every 20 seconds while it
continues. Once he settles it steps back down slowly: Level 1 holds for 8
minutes, Level 4 for 2. If Level 4 doesn't work it goes to pre-timeout, then
timeout: it has given up.

A crying spell starts when the SNOO climbs a level or reports a cry. It ends
when the SNOO has been back at rest for `calm_reset_s`, when someone is at the
SNOO (a clip change or a button press), or after `max_spell_s`, so a stuck
state can't mute future alerts.

The sensor turns on once the spell has run `crying_after_s` (0 means at the
first cry) while he's still crying: the SNOO climbed in the last
`recent_rise_s`, or it's at Level 4 or higher, where there's nothing left to
climb. It also turns on if the SNOO climbs into pre-timeout or timeout. It
stays on until the spell ends, so Home sends one notification per spell.
"""

from __future__ import annotations

from dataclasses import dataclass

# Height above baseline. States missing from this table (ONLINE = stopped,
# SUSPENDED, ...) mean the SNOO isn't soothing: neither calm nor climbing.
RANK = {
    "BASELINE": 0,
    "WEANING_BASELINE": 0,
    "LEVEL1": 1,
    "LEVEL2": 2,
    "LEVEL3": 3,
    "LEVEL4": 4,
    "PRETIMEOUT": 5,
    "TIMEOUT": 6,
}
TOP = RANK["LEVEL4"]
GAVE_UP = {"PRETIMEOUT", "TIMEOUT"}
# Events that mean someone is physically at the SNOO.
PARENT_EVENTS = {"safety_clip", "activity", "long_activity_press", "power"}


@dataclass(frozen=True)
class Settings:
    crying_after_s: float = 0
    recent_rise_s: float = 120
    calm_reset_s: float = 300
    max_spell_s: float = 1800


class Detector:
    def __init__(self, settings: Settings = Settings()) -> None:
        self.settings = settings
        self.rank: int | None = None
        # Level lock makes the locked level the new resting level.
        self.lock_level: int | None = None
        self.spell_start: float | None = None
        self.rest_since: float | None = None
        self.last_rise = float("-inf")
        self.gave_up = False
        self.crying = False

    @property
    def resting(self) -> int:
        return self.lock_level if self.lock_level is not None else 0

    def observe(self, now: float, state: str, hold: bool, event: str) -> None:
        """Feeds one message from the SNOO."""
        prev, rank = self.rank, RANK.get(state)
        if not hold:
            self.lock_level = None
        elif rank is not None:
            if self.lock_level is None or event == "command":
                self.lock_level = rank
            else:
                self.lock_level = min(self.lock_level, rank)
        self.rank = rank

        if event in PARENT_EVENTS:
            self._end_spell()
            return

        # A climb someone asked for from the app isn't him crying.
        rose = event == "cry" or (
            event != "command" and prev is not None and rank is not None and rank > prev
        )
        if rose:
            self.last_rise = now
            if self.spell_start is None:
                self.spell_start = now
            if state in GAVE_UP:
                self.gave_up = True
        if self.spell_start is None:
            return
        at_rest = rank is not None and rank <= self.resting
        if rose or not at_rest:
            self.rest_since = None
        elif self.rest_since is None:
            self.rest_since = now

    def evaluate(self, now: float) -> bool:
        """Returns whether he's crying. Call it on a timer: the thresholds are time-based."""
        s = self.settings
        if self.spell_start is not None:
            settled = self.rest_since is not None and now - self.rest_since >= s.calm_reset_s
            if settled or now - self.spell_start >= s.max_spell_s:
                self._end_spell()
        if self.spell_start is not None and not self.crying:
            at_top = self.rank is not None and self.rank >= TOP and self.rank > self.resting
            still_crying = now - self.last_rise <= s.recent_rise_s or at_top
            self.crying = self.gave_up or (
                now - self.spell_start >= s.crying_after_s and still_crying
            )
        return self.crying

    def _end_spell(self) -> None:
        self.spell_start = None
        self.rest_since = None
        self.last_rise = float("-inf")
        self.gave_up = False
        self.crying = False
