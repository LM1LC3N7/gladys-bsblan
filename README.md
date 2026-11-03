# gladys-bsblan

[Gladys Assistant](https://gladysassistant.com) external integration for
boilers and heat pumps with a Siemens controller (ELCO, Brötje, Baxi, MHG,
Atlantic…) through the **BSB-LAN** adapter and its local JSON API:
heating circuits 1 and 2, hot water, boiler, extra read-only parameters, and
commands (modes, comfort and reduced setpoints, hot water mode and setpoints
capped at 65 °C by default) behind an off-by-default option, Protection and
hot water Off never held back. **Tested on a real installation** (0.2.0:
Siemens controller, two heating circuits, about fifteen commands on both
circuits, protective commands confirmed). **Not
affiliated with the BSB-LAN project nor the manufacturers.** BSB-LAN speaks
plain http: keep it on a trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (BsbLanApp)
                                  ├─ src/bsblan/client.js  JSON API (/JI, /JV, /JQ, /JS), the Gate
                                  ├─ src/bsblan/http.js    node:http, deadline, 64 KB cap
                                  ├─ src/params.js         parameter map and decoding (python-bsblan)
                                  ├─ src/devices.js        the device and its states (pure)
                                  ├─ src/store.js          /data: pause, stop, kept stops (no secret)
                                  └─ src/publisher.js      states within 300/min
```

- **Reads**: `/JI` (MAC, firmware, bus, write access), `/JV` once (JSON-API
  1.0 at least, as python-bsblan), then `/JQ` four parameters at a time,
  every 30 s (10 s – 10 min). Heating circuits 1 and 2 (the rest of circuit
  2 only while its mode 1000 answers), hot water, boiler, outside
  temperature, energy brought in, up to 10 extra read-only parameters
  (`extra_parameters`, typed from their /JQ answer, never written); PPS
  room-unit parameters on a PPS bus.
  Every request is a POST, the passkey first in the path, basic auth only
  with both fields. Answers are capped at 64 KB, read with `JSON.parse`
  (UTF-8, else Latin-1), only own keys of the parameters asked, every value
  checked against a plausible range.
- **Room temperature of circuit 2** (8770, 0.3.0): read with the rest of
  circuit 2, shown only when valid (not "---", in °C, −60 to 120 °C), a
  `probe` (8740 stays the only room temperature Gladys averages). Without
  a valid value it is read again only every 10 min. Typed as an extra
  parameter in 0.2.0: still read, its `param-8770` keeps its value.
  Circuit 3 (8800) is not handled.
- **Failures**: unreachable 30 s, 1, 2, 5 min, never under the interval;
  HTTP 401/403 a stop persisted in `/data`, next tries 15 min, 1 h, 6 h,
  24 h; HTTP 429/5xx a pause of 1 min to 6 h persisted in `/data`, applied
  to every path; none of them cleared by a reconnection to Gladys.
- **Device**: `ext:<selector>:bsblan:<mac>`; features appear once their
  parameter gave a value and are never lost on a republication.
  Temperatures `temperature-sensor` (`probe` for water, outside and
  read-only setpoints), comfort setpoint `thermostat/target-temperature`,
  hot water setpoint `water-heater/target-temperature`, mode `text/select`,
  texts `text/text`, pump `unknown/binary`, energy `unknown/decimal`
  (never an index).
- **Commands** (`allow_commands`, off by default): never a switch. The
  command holds the Gate from a fresh read of the value and of the range of
  the controller (714–716 / 1014–1016, reduced ≤ comfort; 1612–1614,
  1612 ≤ 1610) to the end of the write, decides on that read only, checks
  the option and the hot water ceiling again right before the request
  leaves, leaves within 3.5 s of the click or is refused unsent, and is
  answered by 4.3 s; success only when a read back shows the value; a write
  without status 1 is "sent, without confirmation", followed by reads 5 s
  and 20 s later. **Protective** (Protection on 700/1000, hot water Off on
  1600): no option, through a pause, a stop or another command, first in
  the Gate, cancels the commands not sent yet, written again (3 times at
  most) when a later read still shows the start value. Hot water:
  whole degrees, ceiling 65 °C by default, configurable 40–65 °C, never
  above 65 °C nor the controller's own maximum. Refused on a PPS bus and when BSB-LAN gives the parameter as read only
  (its `readwrite` access, else `buswritable` of `/JI`, never believed before 5.1.19).
- **Guards**: after a write, until a read shows it (or 90 s), the same
  setting is sent again even when the read shows the wanted value.

## Known setups

- **BSB-LAN publishing in MQTT** (for Home Assistant, for example): the
  adapter serves one request at a time, and that load can make the commands
  of Gladys run out of time. Turn MQTT off in BSB-LAN, or lighten it (a
  longer interval, fewer parameters), and keep a reasonable refresh interval
  in Gladys (30 s or more). A command that timed out says so ("does it also
  publish in MQTT, or is the read interval too short?"); the deadlines and
  the 3 s between two writes do not change.
- **`/data` not writable** (`EACCES` at start): the image runs as `node`
  (uid 1000) and its own `/data` belongs to it, but Gladys bind-mounts
  `<Gladys data>/external-integrations/<selector>` over it and gives that
  folder to uid 1000 only when it can (best effort). When it cannot, the
  integration still works (commands and protective commands are never
  refused nor dropped for it), says it in the status, and only a restart
  forgets the pause, the credentials wait and the protective commands not
  yet seen applied. A test file (written then removed at start, the state
  left as it is) says it from the start. Fix on the host: owner 1000
  **and** write permission (`chown 1000:1000`, `chmod 755`; on Synology,
  the folder's ACL can leave it `dr-xr-xr-x` for uid 1000). See the user
  docs.
- **A second command during the first one** (0.3.1): it waits (one per
  setting, the last one wins) and leaves once the first one is over and
  the 3 s after a write have passed, with its own fresh read and every
  check again; a protective command after it, a restart, or 30 s without
  starting drops it. A command surely not applied (refused before it
  left, cancelled, read back unchanged) publishes the value read again at
  once; "sent, without confirmation" republishes nothing older (the
  follow-up reads settle it). After either, the first read of that
  setting made after the write (or the refusal) publishes it even
  unchanged; if the reads fail, the first one that succeeds does (within
  10 min); never after a confirmed success.

## Credits

The JSON API, the parameter map, the modes and the setpoint bounds are
ported from [python-bsblan](https://github.com/liudger/python-bsblan)
(Willem-Jan L. van Rootselaar and contributors, MIT, 6.1.10), the library
of Home Assistant's BSB-LAN integration. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integration [gladys-stiebel-eltron](https://github.com/LM1LC3N7/gladys-stiebel-eltron)
(local heat pump, commands behind an option, capped hot water).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: BSB-LAN is a fake behind the injected HTTP
transport (`test/fixtures/fakeBsbLan.js`), Gladys is the SDK's fake;
`test/client.test.js` also runs the real transport against a loopback
server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
