# TODO — BSB-LAN v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 9) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-19): JSON API of one BSB-LAN adapter
      (/JI, /JV, /JQ, /JS), passkey and basic auth optional, one device per
      MAC, heating circuit 1, hot water, outside temperature, energy as a
      plain value, PPS read only, three commands behind `allow_commands`
      (off), hot water ceiling (55 °C, 40–60, never above 60), stop on
      refused credentials and 429/5xx pause persisted in `/data`, polling
      and backoff, test button, docs en/fr, cover. Tested against a fake
      BSB-LAN only.
- [ ] **Milestone 2 — real adapter**: run against a real BSB-LAN (see "To
      check"), turn the answers (MAC removed) into fixtures.
- [ ] **Milestone 3 — more**: heating circuit 2 (1000-series, python-bsblan
      `heating_circuit2`), cooling (901/902), the hot water mode (1600) as a
      command, PPS commands (python-bsblan `PPS_HVAC_MODE_TO_BSBLAN`), the
      hvac action category of 8000 (`HeatingCircuitStatus`), time programs
      read only, and an opt-in energy index once 3113 is proven cumulative
      (with the approved guard of gladys-p1-monitor: hold, bounded
      acceptance button, never 0).

## To check on a real adapter

- **The answer of /JS**: `{ "<id>": { "status": 1 } }` as the BSB-LAN
  manual describes (python-bsblan never reads it; its fake server answers
  `{ "status": 1 }`, both are accepted). Status 0: does the controller
  sometimes apply it anyway? (treated as "sent, without confirmation").
- **1610 bounds**: the hot water nominal setpoint is said to range from the
  reduced setpoint (1612) to its max (1614) on RVS controllers; the command
  refuses outside. Check on other controller families (LMS, LMU, RVA).
- **714–716** as the bounds of 710 (python-bsblan `_temperature.py`): some
  controllers may expose 716 as "---" (then every heating setpoint command
  is refused "range missing").
- **Latency**: a /JQ of 4 parameters on the bus; a command needs its fresh
  read (1 or 3 parameters) and the write within 3.5 s. Too slow on a busy
  LPB → commands refused "too slow"; measure.
- **Units**: `°C`, `&deg;C`, `&#176;C`, and the mojibake (U+00C2 U+00B0 C) of the
  python-bsblan fixtures are all read as °C; an empty unit too.
- **8820**: 0 off, 255 on (python-bsblan fixture); other non-zero values
  are read as on.
- **3113**: "7968 kWh" string (fixture); other firmwares a number with a
  unit; resolution and reset unknown.
- How many HTTP clients BSB-LAN serves at once (Home Assistant and Gladys
  together?): our requests are one at a time.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-bsblan:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Reference**: python-bsblan 6.1.10 (MIT, liudger, the library of Home
  Assistant's BSB-LAN integration), cloned read only in
  `_ref/python-bsblan` (tag v6.1.10, 260c9f8, 2026-10-13); its LICENSE
  checked (MIT). Credited in README, docs and `THIRD_PARTY_NOTICES.md`
  (full MIT notice), shipped in the image with `LICENSE` (the standard
  Apache-2.0 text without any name). Neighbour module followed:
  gladys-stiebel-eltron (structure, command rules, hot water ceiling).
- **Own HTTP client, no dependency**: `node:http`, POST as python-bsblan,
  no keep-alive, no redirect, a deadline per request, 64 KB cap, the error
  messages built from codes and HTTP statuses only (never a body, never the
  path that carries the passkey). Never retried (python-bsblan retries 3
  times: not for a command, and the poll interval is the retry).
- **The Gate**: BSB-LAN serves one client at a time and queries the bus
  parameter by parameter: one request at a time, four parameters per /JQ
  so a command never waits for a whole poll; a command passes before the
  queued poll requests and holds the Gate from its fresh read to the end
  of its write; still queued at its deadline → refused unsent.
- **Values**: inactive (`---`, `""`, `None`, null), an `error` field other
  than 0, a value that is not a plain number, or out of its plausible range
  (temperatures −60–120 °C, setpoints 0–95 °C) → unknown, never published.
  Only own keys of the parameters asked are read (no prototype pollution).
  A controller in °F: temperatures unknown, a note in the status (the
  features are °C, fixed at creation).
- **One adapter per integration, one device per MAC** (`bsblan:<mac>`, 12
  hex digits): stable when the IP changes; no MAC → no device ("no MAC"
  status, read again every 30 min). Another MAC at the address drops what
  was read; the created device shows "another adapter".
- **/JV required** (python-bsblan `VersionResolver`): no /JV (404, not
  JSON) or a version under 1.0 → not supported, read again every 30 min;
  a timeout of /JV is a passing failure. The parameter list is the same
  for JSON-API 1.x and 2.x: what the controller lacks is just absent.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): water,
  outside temperatures and read-only setpoints `temperature-sensor/probe`
  °C; room temperature `temperature-sensor/decimal`; comfort setpoint
  `thermostat/target-temperature` °C (slider 5–35); hot water setpoint
  `water-heater/target-temperature` °C (slider 10–60, integers); mode
  `text/select` (BSB/LPB only) with a read-only `text/text` that also shows
  an unknown code; status and hot water mode `text/text`; pump
  `unknown/binary` read only (lot 6 lesson: no switch). A feature appears
  once its parameter gave a value.
- **Energy as a plain value** (wave 2 / lot 6 lessons, brief): 3113 is a
  text "7968 kWh" with no documented reset nor resolution: not proven
  cumulative and reliable → `unknown/decimal`, the unit in the name, never
  `energy-sensor/index`, never `publishEnergyConsumption`.
- **No lost feature** (lot 6 lesson): the features of the created device
  (`gladys.devices`) that a new build lacks are republished as they are;
  the roles an adapter reported once are remembered while the integration
  runs.
- **Commands** (`allow_commands`, off by default, only `true` allows):
  mode 700 (automatic, comfort, reduced, protection: python-bsblan 0–3),
  comfort setpoint 710, hot water nominal setpoint 1610. Values checked
  strictly: a mode is one exact key of the list; a setpoint a finite
  number or a plain decimal text (`''`, `null`, `'1e1'`, `true` refused), a
  tenth of a degree for heating (5–35 °C), whole degrees for hot water
  (10–60 °C), then the range read just before: 714–716 for heating,
  1612–1614 for hot water; a missing value or bound refuses. An unknown
  mode code (not 0–3) is never left. Refused on a PPS bus (v1) and when
  `/JI` says `buswritable: 0`.
- **Hot water ceiling**: `dhw_max_temperature`, 55 °C by default, 40–60 °C
  (a typed value outside is clamped, never above 60; rounded down;
  anything not a number gives 55). Refused on arrival above it, checked
  again after the fresh read and right before the request leaves
  (`beforeSend`): a ceiling lowered during a command stops it. 1612, 1614
  and the legionella function are never written.
- **Outcomes of a write** (lot 6 and waves 2/3 lessons): /JS status 1 →
  success; status 2 → "refused" (not applied); status 0, another status or
  none → "sent, without confirmation"; nothing sent (unreachable before
  the connection, late, `beforeSend`) → "not sent"; HTTP 4xx → "refused"
  (401/403 and 429 also stop/pause every path); a timeout, a dropped
  connection, a 5xx or a body that is not JSON after the request may have
  left → **"sent, without confirmation"**, guard set. Polls 5 s and 20 s
  after every command. One command at a time, 3 s between two writes. The
  ack never waits for Gladys: the fresh read is published in the
  background.
- **Guards** (waves 2/3 lessons): per adapter and role, the start value and
  the wanted one; while it holds (until a read shows a move then the
  wanted value, or 90 s), the command is always sent, never answered
  "already so". A read equal to the start value or unknown lifts nothing.
- **Credentials refused** (HTTP 401/403 on any request): a stop persisted
  in `/data/bsblan-state.json` (`auth: { failures, until }`), next tries
  15 min, 1 h, 6 h, then every 24 h; no hash nor any derivative of a
  secret is stored. Lifted by other credentials (or another address)
  saved, by "Test the connection" (one try, the button at most every
  10 s), or by a good read. Not lifted by a reconnection to Gladys.
- **HTTP 429/5xx**: a pause `pausedUntil` persisted in `/data`, from
  `Retry-After` or the backoff step, clamped 1 min – 6 h, never under the
  interval, applied to polls, commands and the button; read back bounded.
  Lifted only by another address or its end.
- **Polling**: 30 s by default, 10 s – 10 min; failures 30 s, 1, 2, 5 min,
  never shorter than the interval.
- **Reconnection to Gladys** (`connected`): republishes status, Discovery,
  states (published-state memory forgotten) and badge, as the core keeps
  them in memory (lot 6 lesson); never clears the client, the pause nor the
  stop; another configuration restarts.
- **Secrets**: passkey and password are `secret` fields described "kept by
  Gladys in its database, never shown again, sent only to the BSB-LAN
  adapter" (Gladys stores them in clear: never described otherwise,
  `test/manifest.test.js`); the user name a
  plain string. Never in logs, statuses, errors, `/data`; an invalid
  address is shown without credentials nor path. Plain http said in the
  manifest, docs and README.
- **Review round 1 (2026-10-19)**, no blocker:
  - I1: a command session opens with a raw `/JI` (in the 2.5 s read
    budget, before the `/JQ`): the MAC must be the device's, the bus BSB or
    LPB, writing allowed; else "not sent". Tests H15a/H15b in
    `test/review.test.js`.
  - I2: `beforeSend` is passed to the transport and runs once the
    connection is up, right before `req.end`; a refusal destroys the
    socket, `sent: false`, the error marked `beforeSend` (H19, and the real
    transport on a loopback server).
  - M1: the hot water range shown includes the ceiling,
    `min(60, 1614, ceiling)`. M2: no follow-up read while the adapter is
    offline. M3: a poll started before a command keeps the values the
    command re-read (`refreshedAt`). M4: `buswritable` writable only when
    absent, 1, true or "1"; commands only on a bus named BSB or LPB. M5:
    712 read too, low = max(5, 714, 712). M6: docs: the 404 of a wrong
    passkey is to check; a lower ceiling does not lower a setpoint already
    higher; the anti-legionella function may exceed the ceiling. M7: the
    403 status names the trusted IP addresses. M8: PPS setpoint on its own
    read-only role `room-setpoint` (probe). M9: documented that an unknown
    mode leaves the last known choice in the list.
- **Approval nits (2026-10-19)**:
  - M3 redone: each poll batch and each fresh read of a command get a
    sequence number; a command's read replaces only the parameters of a
    batch read before it; a batch read after the command (its write
    included) stays (H20, H16 in `test/review.test.js`).
  - Hot water: 1612 above the ceiling is refused with a message naming
    1612 and the ceiling (no value can fit), not "range missing".
  - Firmware source checked: a wrong passkey or an IP not trusted closes
    the connection without answer, never a 404 (no 404 for a passkey
    exists). The "unreachable" status and the docs give that hint; 403 is
    about the credentials only; a real 404 asks "is it a BSB-LAN?".
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `climate`**, transport `local`.
- **Template demo files** (devices, scenes, widgets, weather and their
  tests) removed.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved.
  No Docker on this PC: the image was not built locally. The store
  validator cannot be run by this agent: it runs at publication (main
  session, `validate.ps1`).
