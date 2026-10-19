# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Boilers and heat pumps with a Siemens controller (ELCO, Brötje, Baxi,
  MHG…) read through the local JSON API of the BSB-LAN adapter (no cloud,
  no account), by its IP address, with an optional passkey and HTTP basic
  authentication; BSB, LPB and PPS buses.
- One device per adapter, keyed by its MAC address: heating mode and
  status, comfort and reduced setpoints, room and outside temperatures, hot
  water mode, setpoints, temperature and pump, and the energy brought in as
  a plain value, never an energy index.
- Three commands behind "Allow the commands" (off by default): the heating
  mode (a list, never a switch), the comfort setpoint of heating circuit 1
  and the hot water setpoint, each bounded by the range the controller
  reads just before; an unknown mode is never left; PPS read only.
- Hot water ceiling: 55 °C by default, configurable from 40 to 60 °C, never
  above 60 °C; checked on arrival, after the fresh read and right before
  the write.
- Each command reads its parameters again and writes in the same turn of
  the adapter (no other request in between); one that cannot leave within
  3.5 s is refused unsent; a write without status 1 is "sent, without
  confirmation", read again 5 and 20 s later; at least 3 s between two
  writes.
- Credentials refused: a stop kept in `/data`, next tries 15 min, 1 h, 6 h,
  then every 24 h; HTTP 429 or 5xx: a pause of 1 min to 6 h kept in
  `/data`; none of them cleared by a reconnection to Gladys.
- Reads every 30 s (configurable), a few parameters per request; failures
  retried after 30 s to 5 minutes, never sooner than the interval.
- A republished device never loses a feature; status, Discovery and badge
  sent again at every reconnection to Gladys.
- Each command first reads `/JI` again: the same MAC, a BSB or LPB bus and
  write access, or nothing is sent; the hot water one is bounded by the
  ceiling in its range too; the comfort setpoint is never below the
  reduced setpoint (712).
- The last check of a command runs once the connection is up, right
  before the first byte leaves.
- Write access counts only when `/JI` gives nothing, 1, true or "1"; an
  unknown bus refuses the commands; HTTP 403 also names the trusted IP
  addresses of BSB-LAN; on a PPS bus the setpoint is a read-only feature.
- A poll started before a command never republishes what the command
  re-read; no follow-up read while the adapter does not answer.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-bsblan/commits/main
