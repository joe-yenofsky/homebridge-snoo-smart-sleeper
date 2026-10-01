# homebridge-snoo-smart-sleeper

Adds a **Baby Crying** sensor to Apple Home for each [SNOO Smart Sleeper](https://www.happiestbaby.com/products/snoo-smart-bassinet) on your Happiest Baby account. It turns on when your SNOO hears crying, so Home can notify your phones or run an automation.

The SNOO already listens for crying: that's how it decides to rock harder. This plugin reads that from Happiest Baby's cloud through [python-snoo](https://github.com/Lash-L/python-snoo), the library behind Home Assistant's SNOO integration. It doesn't use a camera or a microphone of its own.

## How the sensor behaves

- It shows as a motion sensor. **On** means he's crying.
- It turns on at the first cry of a spell, and stays on until the spell ends:
  - someone presses the SNOO's button or unclips the sleep sack, or
  - the SNOO has been back at rest for 5 minutes.
- You get one alert per crying spell, not one per cry.
- Level changes you make from the Happiest Baby app don't count as crying. Level lock is handled: the locked level counts as rest.

## Requirements

- Homebridge 1.8 or 2.x, Node.js 22, 24 or 26.
- **Python 3.11 or newer** on the Homebridge machine. On first start the plugin creates its own virtual environment in the Homebridge folder and installs python-snoo from PyPI, which takes about a minute. On Debian and Raspberry Pi OS you may need `sudo apt install python3-venv`.

## Setup

1. Install **SNOO Smart Sleeper** from the Plugins tab in the Homebridge UI, or run `npm install -g homebridge-snoo-smart-sleeper`.
2. Enter your Happiest Baby email and password in the plugin settings, and restart Homebridge.
3. In the Home app, open the **Baby Crying** sensor's settings and turn on **Activity Notifications**. Everyone who wants alerts does this on their own phone. To get alerts at night, add the Home app to your Sleep focus.

Config example:

```json
{
  "platform": "SnooSmartSleeper",
  "name": "SNOO",
  "email": "you@example.com",
  "password": "your-password"
}
```

| Option | Default | What it does |
|---|---|---|
| `accessoryName` | `Baby Crying` | The sensor's name. With several SNOOs, each SNOO's name is added. |
| `cryingDelaySeconds` | `0` | Only alert after this much sustained crying. |
| `calmResetMinutes` | `5` | How long the SNOO must be calm before a spell ends. |
| `pythonPath` | `python3` | A specific Python 3.11+ interpreter. |
| `eventLog` | `false` | Write SNOO events to `snoo-smart-sleeper/events.jsonl` in the Homebridge folder. |
| `testAlertOnStartup` | `false` | Turn the sensor on for 10 seconds at startup, to test notifications. |

## Ideas for automations

- **Announce it on a HomePod:** make spoken audio (for example with macOS's `say -o crying.m4a "The baby is crying"`) and add it to your Apple Music library. Then create a Home automation: *A Sensor Detects Something → Baby Crying → Play Audio*. Pick a HomePod that isn't in the baby's room.
- **Turn on a hallway light** at low brightness when the sensor turns on.

## Troubleshooting

- **No alerts:** check the Homebridge log for lines from this plugin. It logs every login, reconnect and crying spell.
- **"Happiest Baby rejected the email/password":** fix them in the plugin settings. The plugin retries once an hour, so the account doesn't get locked.
- **Python errors at startup:** install Python 3.11+ and `python3-venv`, or set `pythonPath`.
- To check the connection by hand, run the helper with your credentials. On a Homebridge Raspberry Pi image, that's:

  ```sh
  SNOO_EMAIL=you@example.com SNOO_PASSWORD=... \
    /var/lib/homebridge/snoo-smart-sleeper/venv/bin/python \
    /var/lib/homebridge/node_modules/homebridge-snoo-smart-sleeper/python/snoo_helper.py --check
  ```

## How it works

The plugin runs a small Python helper alongside Homebridge. The helper logs in with python-snoo, subscribes to each SNOO's live feed, and asks each SNOO for its status every three minutes. If a SNOO stops answering, it reconnects. It decides when crying starts and stops, then prints one line of JSON per change, which the plugin turns into HomeKit updates. If the helper exits or goes quiet, the plugin restarts it.

## Development

```sh
npm install
npm run lint && npm run build && npm test           # Node side
pip install -r python/requirements.txt && npm run test:python
```

## Disclaimer and credits

This plugin is unofficial and not affiliated with or endorsed by Happiest Baby. It uses an undocumented cloud API that can change or break at any time. It is **not a safety or medical device**; don't rely on it to monitor your baby.

Talking to the SNOO is done by [python-snoo](https://github.com/Lash-L/python-snoo) (GPL-3.0). It is downloaded from PyPI when the plugin starts and runs as a separate program; this plugin doesn't include its code. The plugin itself is MIT-licensed.
