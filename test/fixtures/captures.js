// -----------------------------------------------------------------------------
// Answers of BSB-LAN 5.x as its firmware prints them (fields, order, types),
// written from the format of BSB_LAN.ino 5.0.111-20260211204302 and
// 5.1.33-20261027002928 (fredlcore/BSB-LAN, read only for the format; no
// code taken). The MAC and the serial numbers are made up.
//
// /JI of 5.0.111 prints `buswritable` from a `float` with `%d` (fixed in
// 5.1.19): the number shown is meaningless; 0 and 1072693248 below are
// what such a firmware may print on a bus that IS writable
// (DEFAULT_FLAG 0, the forum report t/11458 of 2026-10-30).
// -----------------------------------------------------------------------------

export const CAPTURE_MAC = 'A0:B7:65:12:34:56';
export const CAPTURE_MAC_ID = 'a0b765123456';

/** /JI of an ESP32 on firmware 5.0.111 (RVS13.143/227 on BSB, address 66). */
export function info5_0_111(buswritable = 0) {
  return {
    name: 'BSB-LAN',
    version: '5.0.111-20260211204302',
    hardware: 'ESP32',
    freeram: 171236,
    uptime: 86400123,
    MAC: CAPTURE_MAC,
    freespace: 0,
    bus: 'BSB',
    buswritable,
    busaddr: 66,
    busdest: 0,
    busdevices: [
      {
        dev_id: 0,
        dev_fam: 90,
        dev_var: 239,
        dev_serial: 0,
        dev_oc: 0,
        dev_name: 'RVS13.143/227',
      },
    ],
    monitor: 0,
    verbose: 1,
    onewirebus: -1,
    onewiresensors: 0,
    dhtbus: [{ pin: -1 }, { pin: -1 }],
    averages: [],
    loggingmode: 0,
    loginterval: 0,
    logged: [],
  };
}

/** /JI of firmware 5.1.33 (its `buswritable` is a real 0 or 1). */
export function info5_1_33(buswritable = 1) {
  return { ...info5_0_111(buswritable), version: '5.1.33-20261027002928' };
}

/** One /JQ entry as 5.x prints it (`readwrite`: 0 read/write, 1 read only, 2 write only). */
export function jq({ name, value, desc = '', unit = '', type = 'TEMP', readwrite = 0 }) {
  const family =
    { ENUM: 'ENUM', ONOFF: 'ENUM', ERRORCODE: 'ENUM', DTTM: 'DTTM', STRN: 'STRN' }[type] ?? 'VALS';
  const dataType = { VALS: 0, ENUM: 1, DTTM: 5, STRN: 7 }[family];
  return {
    name,
    dataType_name: type,
    dataType_family: family,
    destination: 0,
    error: 0,
    value,
    desc,
    payload: '00',
    ...(family === 'VALS' ? { precision: 0.1 } : {}),
    dataType,
    readwrite,
    unit,
  };
}

/** A /JQ answer of the RVS13 of the report: heating circuit 1, hot water. */
export function jqAnswer5x({ readwrite = 0 } = {}) {
  return {
    700: jq({ name: 'Régime CC1', value: '1', desc: 'Automatique', type: 'ENUM', readwrite }),
    710: jq({ name: 'Consigne de confort', value: '20.0', unit: '°C', readwrite }),
    712: jq({ name: 'Consigne réduite', value: '17.0', unit: '°C', readwrite }),
    714: jq({ name: 'Consigne hors-gel', value: '10.0', unit: '°C', readwrite }),
    716: jq({ name: 'Consigne confort maximum', value: '28.0', unit: '°C', readwrite }),
    8000: jq({ name: 'État circuit 1', value: '114', desc: 'Confort', type: 'ENUM', readwrite: 1 }),
    8740: jq({ name: 'Température ambiante 1', value: '19.4', unit: '°C', readwrite: 1 }),
    8700: jq({ name: 'Température extérieure', value: '6.5', unit: '°C', readwrite: 1 }),
    1600: jq({ name: 'Régime ECS', value: '1', desc: 'Marche', type: 'ENUM', readwrite }),
    1610: jq({ name: 'Consigne nominale ECS', value: '50', unit: '°C', readwrite }),
    1612: jq({ name: 'Consigne réduite ECS', value: '40', unit: '°C', readwrite }),
    1614: jq({ name: 'Consigne nominale max ECS', value: '65', unit: '°C', readwrite }),
    8830: jq({ name: 'Température ECS 1', value: '48.0', unit: '°C', readwrite: 1 }),
    8820: jq({ name: 'Pompe ECS', value: '0', desc: 'Arrêt', type: 'ENUM', readwrite: 1 }),
    6224: jq({ name: 'Identification', value: 'RVS13.143/227', type: 'STRN', readwrite: 1 }),
  };
}
