# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTP goes through our own client on `node:http`). It
reads a boiler or heat pump with a Siemens controller through the JSON API
of a BSB-LAN adapter (local, plain http, optional passkey and basic auth)
and shows it as one Gladys device; the heating mode, the comfort setpoint
and the hot water setpoint can be changed behind an off-by-default option,
the hot water capped. Never tested with a real adapter, not affiliated with
the BSB-LAN project nor the manufacturers.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js                     SDK bootstrap only
src/handlers.js              every SDK handler -> the app (shared with the tests)
src/app.js                   BsbLanApp: polling, failures, pause/stop, device, states,
                             badge, status, the test button, the commands, guards
src/bsblan/client.js         JSON API (/JI, /JV, /JQ, /JS), the Gate, sessions
src/bsblan/http.js           node:http transport: deadline, size cap, `sent`
src/bsblan/errors.js         BsbError codes, auth/busy helpers
src/params.js                parameter map, decoding, modes (python-bsblan)
src/devices.js               -> the Gladys device and its states (pure), kept features
src/store.js                 /data/bsblan-state.json: pause and stop, bounded, no secret
src/publisher.js             states within 300/min
src/config.js                config_schema normalized (address, passkey, username,
                             password, allow_commands, dhw_max_temperature,
                             poll_interval, language)
src/constants.js             feature roles, limits, timings, the hot water ceiling
src/i18n.js                  runtime texts, feature and mode names (en/fr)
test/fixtures/fakeBsbLan.js  the fake adapter behind the transport; Gladys is the SDK's fake
scripts/cover.mjs            cover.png generator
```

## Rules

- **External ids are forever**: device `bsblan:<mac>` (12 lowercase hex
  digits), features `mode`, `operating-mode`, `heating-status`,
  `heating-setpoint`, `heating-setpoint-reduced`, `room-setpoint` (PPS, read
  only), `temperature-room`,
  `temperature-outdoor`, `dhw-mode`, `dhw-setpoint`, `dhw-setpoint-reduced`,
  `temperature-dhw`, `dhw-pump`, `energy-total`. A republished device never
  loses a feature (`keepCreatedFeatures`).
- Manifest keys (`address`, `passkey`, `username`, `password`,
  `allow_commands`, `dhw_max_temperature`, `poll_interval`, `language`, the
  action `test_connection`) are frozen.
- **Secrets**: the passkey (it is in the path), the user name and the
  password never reach a log, a status, an error, `/data`. A secret field
  is "kept by Gladys in its database, never shown again", never said
  encrypted.
- **HTTP**: one request at a time (the Gate); a deadline and a 64 KB cap per
  answer; never retried; `sent` is true as soon as the connection was up.
- **Failures**: 401/403 a stop persisted and spaced, 429/5xx a pause
  persisted and bounded, applied to every path; never read sooner than the
  interval; a reconnection to Gladys clears none of them.
- **The commands**: never a switch or a writable binary (a "turn everything
  off" must not reach them); refused unless `allow_commands` (checked on
  arrival, after the fresh read and right before the request leaves);
  decided on a fresh read only, bounded by the range the controller reads
  then, refused when a value is missing; never sent after 3.5 s; a write
  without status 1 is "sent, without confirmation"; never retried; one at a
  time; the ack never waits for Gladys. Never leave an unknown mode.
- **Hot water**: never above the configured ceiling (65 °C by default) nor
  65 °C nor the controller's nominal max (1614), whole degrees only.
- **Energy**: never an `energy-sensor` index nor `publishEnergyConsumption`
  until a real adapter shows 3113 is cumulative and reliable.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network (the loopback server of `test/client.test.js` aside), nor
  the system temp folder (`data/` of the repository, ignored by git).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
