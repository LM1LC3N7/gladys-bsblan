# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.2.0] - 2026-10-31

### Added

- Heating circuit 2 (mode 1000, comfort 1010 and reduced 1012 setpoints
  within 1014–1016, status 8001, flow setpoint 8774 and temperature 8773),
  only when the controller gives its mode.
- Circuit 1: the reduced setpoint 712 as a command (within 714–716, never
  above the comfort one), flow setpoint 8744 and temperature 8743.
- Hot water: the mode 1600 as a command (on, eco, off), the reduced
  setpoint 1612 as a command (never above 1610, 1614, the ceiling nor
  65 °C), the status 8003.
- The boiler, read only: status 8005, temperature 8310, burner stage 1
  signal 7881, burner fault input S3 7870, last fault date 6800 and code 6801.
- "Extra parameters to read": up to 10 BSB-LAN parameters, read only,
  named and typed from BSB-LAN's answer; never written.
- getConfig() failing when Gladys connects: said in the status, tried again
  (5 s, 15 s, 30 s, 1 min, then every 5 min).

### Changed

- Protection (frost protection) of circuits 1 and 2 and hot water Off are
  never held back: no option needed, through a pause, refused credentials
  or another command, first in line, written again when a read shows them
  not applied; kept in /data until a read that left after them shows them
  applied (sent first after a restart, only to their own adapter; never
  given up while not sent; lifted only by a command that arrived after
  them and left unrefused, or by another mode read twice after they left).
- A command is a success only once a read back shows the value asked.
- New devices get the settable reduced setpoints; devices created before
  keep their read-only "Reduced setpoint" features, still updated.

### Fixed

- Commands refused as "read only" on BSB-LAN 5.0.x while its info page says
  Read/Write (forum t/11458): up to 5.1.18 the firmware prints `buswritable`
  of `/JI` from a decimal variable with an integer format, so its value
  means nothing. The access BSB-LAN gives each parameter (`readwrite` of
  `/JQ`) now decides first; `buswritable` is read in all its forms (1, 2,
  true, "Yes", "RW"… / 0, false, "No", "RO"…), an ambiguous value is
  "unknown", and it is never believed before 5.1.19. A parameter read only
  is refused even when the bus is writable.

## [0.1.3] - 2026-10-28

### Changed

- Hot water ceiling raised to 65 °C (default 65 °C), device limits still apply.

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-19

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
  unknown bus refuses the commands; on a PPS bus the setpoint is a
  read-only feature.
- A command's fresh read replaces only the parameters a poll batch read
  before it; no follow-up read while the adapter does not answer.
- A hot water reduced setpoint (1612) above the ceiling is named in the
  refusal.
- The "unreachable" status says that BSB-LAN closes the connection on a
  wrong passkey or an IP address it does not trust.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-bsblan/releases/tag/v0.1.1
