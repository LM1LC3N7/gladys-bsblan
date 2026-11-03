# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Integration SDK 0.16 (`@gladysassistant/integration-sdk` `^0.16.0`); the
  device already says `should_poll: false` (Gladys 5.3 polls a device
  otherwise).

### Fixed

- A command "sent, without confirmation" that the controller did not apply,
  while its read backs at 5 s and 20 s failed too (adapter busy or
  unreachable): the card kept the value typed, as the value read back later
  equalled the last one published. The setting is now published again by
  the first read that succeeds after the command, within 10 minutes
  (review 0.3.1 r2 n1).
- Tests for the "sent, without confirmation" paths (no status 1, not read
  back, not read back in time, read back timeout), the republication after
  an unconfirmed and unapplied write, and a queued command replaced by a
  newer one (review 0.3.1 r2 n2).
- A command "sent, without confirmation" that the controller did apply
  (21) could have its card set back to the value read before the write
  (20): by the end of a poll that had read it before, by another command
  sent just after, or by Gladys reconnecting. No value read before the
  write is republished now (for up to 10 minutes): the setting waits for a
  read of its own parameter made after the write, which publishes it even
  unchanged (review 0.3.2 r1 I1).
- The same case, then a second command of the same setting refused before
  its own read (paused after a 5xx, dropped by a Protection while queued,
  or the adapter too slow to read it): its refusal forced the value read
  before the first write onto the card. It now waits for the same first
  read after the write (review 0.3.2 r2 I1).
- After a failed command, the setting is no longer republished unchanged
  at every read for 25 s: once at the refusal (when surely not applied)
  and once by the first read of that setting after it (review 0.3.2 r1
  m1).

## [0.3.1] - 2026-11-03

### Changed

- A command that arrives while another one runs (or within the 3 s after a
  write) now waits and leaves right after, instead of being refused
  ("Another command … still running"): one per setting (the last one
  wins), with its own fresh read and every check again when it leaves
  (option, hot water ceiling, range, pause, adapter); dropped by a
  Protection or hot water Off that arrives after it, by a restart, and
  when it cannot start within 30 s; protective commands never wait behind
  it (forum t/11458).
- `/data` not writable: the status, log and docs now ask for owner 1000
  **and** write permission (`chmod 755`, the ACL of a Synology folder),
  not only `chown`. The check at start writes and removes a test file
  instead of saving the state again (a clock behind at start no longer
  shortens a kept pause), and is never awaited.

### Fixed

- After a refused or failed command, the card showed the value typed until
  the page was reloaded: after a command surely not applied (refused
  before it left, cancelled, read back unchanged) the value read is now
  published again at once; after "sent, without confirmation" nothing
  older is republished (the controller may have applied it) and the
  follow-up reads settle it. The reads of the next 25 s publish the
  feature even unchanged, never after a confirmed success (forum
  t/11458).
- Docs: what to do with the "state file unreadable" note; "BSB 8770"
  stays without a value once 8770 is removed from the extra parameters.

## [0.3.0] - 2026-11-02

### Added

- Room temperature of heating circuit 2 (8770), read with the rest of
  circuit 2 and shown only when valid ("---", °F or out of range: no
  value), as a probe: Gladys averages only 8740 as the room temperature
  (circuits 1 and 2 often heat two zones). Without a valid value ("---",
  no room sensor on circuit 2), it is read again only every 10 minutes
  (forum t/11458). Circuit 3 (8800) is not handled, as the rest of
  circuit 3.

### Changed

- Upgrade: 8770 typed in "Extra parameters" (the way 0.2.0 read it): still read,
  once per poll, and its `param-8770` feature keeps getting its value; the
  status suggests adding "Room temperature (circuit 2)" from the Discovery
  tab, then removing 8770 from the list.
- A command that ran out of time (BSB-LAN answering too slowly, a timeout)
  on an open connection now asks whether BSB-LAN also publishes in MQTT
  or the read interval is too short (never when the connection did not
  open); the docs and the refresh interval say why (the adapter serves
  one request at a time). The deadlines and the 3 s between two writes are
  unchanged.
- `/data` not writable (EACCES): the log line names the cause (the data
  folder is not writable by uid 1000) and what a restart then forgets, the
  status says it from the start (a save is tried when the integration
  starts) until a save works again, and also when the state file cannot
  be read; the uid 1000 advice only for EACCES/EPERM; the docs give the
  fix on the host. Commands and protective commands were and stay unaffected.

### Fixed

- The docs and manifest now say the module was tested on a real
  installation (0.2.0, Siemens controller, two circuits).
- A Protection or hot water Off clicked during a restart (new
  configuration) is answered "kept, sent as soon as it answers" instead of
  "not the adapter read now… not sent": it was kept and left right after
  (review r4 m2).

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LM1LC3N7/gladys-bsblan/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-bsblan/releases/tag/v0.1.1
