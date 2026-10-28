# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## python-bsblan

<https://github.com/liudger/python-bsblan> (package `python-bsblan`,
module `bsblan`, the library of Home Assistant's BSB-LAN integration), by
Willem-Jan L. van Rootselaar (liudger) and contributors. MIT License
(`LICENSE` of the repository, version 6.1.10, tag `v6.1.10`, commit
260c9f8). Its notice:

```
MIT License

Copyright (c) 2023-2026 Willem-Jan L. van Rootselaar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Ported in `src/bsblan/client.js` and `src/params.js`: the BSB-LAN JSON API as
the library uses it (`_transport.py`, `bsblan.py`): POST to `/JI`, `/JV`,
`/JQ?Parameter=…` and `/JS` with `{ Parameter, Value, Type: "1" }`, the
passkey as the first part of the path, basic authentication only with both a
user name and a password, a UTF-8 body read as Latin-1 when it is not valid
UTF-8 (`_read_json`); the parameter numbers (`constants.py`: 700, 710, 712,
714, 716, 8000, 8740, 8700, 3113, 1600, 1610, 1612, 1614, 8830, 8820, 6224
and the PPS 15000, 15004, 15006, 15007, 15008, 15030); the heating modes 0–3
(`Validation.HVAC_MODES`) and the PPS raw modes
(`PPS_HVAC_MODE_FROM_BSBLAN`); the bounds of the comfort setpoint, 714 to
716 (`_temperature.py`); the inactive values `---`, `""`, `None`
(`models.py`); the energy text "7968 kWh" (`EntityInfo`); the MAC, bus and
`buswritable` of `/JI` (`Device`); the JSON-API version floor 1.0 of `/JV`
(`_version.py`).

Changed: our own HTTP client on `node:http` (one request at a time through a
Gate, a deadline and a size cap per answer, never retried: python-bsblan
retries three times with backoff); a few parameters per request; only own
keys of the answers are read and every value is checked against a plausible
range; °F is not shown (the features are in °C); the outcome of `/JS` is
read (`status` 1 written, 2 refused, anything else unconfirmed); heating
circuit 1 only; PPS read only; the hot water setpoint bounded by 1612–1614
read just before writing, capped (65 °C by default, 65 °C at most); each
command reads its parameters again right before writing; credentials
refused and HTTP 429/5xx persisted in `/data` and spaced.
