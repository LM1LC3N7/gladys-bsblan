# gladys-bsblan

[Gladys Assistant](https://gladysassistant.com) external integration for
boilers and heat pumps with a Siemens controller (ELCO, Brötje, Baxi, MHG,
Atlantic…) through the **BSB-LAN** adapter and its local JSON API:
temperatures, comfort setpoint, heating mode, hot water, and three commands
(mode, comfort setpoint, hot water setpoint capped at 65 °C by default)
behind an off-by-default option. **Never tested with a real adapter. Not
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
                                  ├─ src/store.js          /data: pause and stop (no secret)
                                  └─ src/publisher.js      states within 300/min
```

- **Reads**: `/JI` (MAC, firmware, bus, write access), `/JV` once (JSON-API
  1.0 at least, as python-bsblan), then `/JQ` four parameters at a time,
  every 30 s (10 s – 10 min). Heating circuit 1, hot water, outside
  temperature, energy brought in; PPS room-unit parameters on a PPS bus.
  Every request is a POST, the passkey first in the path, basic auth only
  with both fields. Answers are capped at 64 KB, read with `JSON.parse`
  (UTF-8, else Latin-1), only own keys of the parameters asked, every value
  checked against a plausible range.
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
  the controller (714–716, 1612–1614) to the end of the write, decides on
  that read only, checks the option and the hot water ceiling again right
  before the request leaves, leaves within 3.5 s of the click or is refused
  unsent, and is answered by 4.3 s; a write without status 1 is "sent,
  without confirmation", followed by reads 5 s and 20 s later. Hot water:
  whole degrees, ceiling 65 °C by default, configurable 40–65 °C, never
  above 65 °C nor the controller's own maximum. Refused on a PPS bus and when BSB-LAN gives the parameter as read only
  (its `readwrite` access, else `buswritable` of `/JI`, never believed before 5.1.19).
- **Guards**: after a write, until a read shows it (or 90 s), the same
  setting is sent again even when the read shows the wanted value.

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
