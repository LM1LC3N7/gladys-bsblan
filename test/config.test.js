import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionKey, dhwCapOf, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 or host name, optional port and http://, nothing else', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress(' http://BSB-LAN.local:8080/ '), {
    host: 'bsb-lan.local',
    port: 8080,
  });
  assert.deepEqual(parseAddress(''), { error: 'empty' });
  assert.deepEqual(parseAddress('https://192.168.1.50'), { error: 'https' });
  assert.deepEqual(parseAddress('ftp://192.168.1.50'), { error: 'invalid' });
  assert.deepEqual(parseAddress('admin:pw@192.168.1.50'), { error: 'credentials' });
  assert.deepEqual(parseAddress('192.168.1.50/1234/'), { error: 'path' });
  assert.deepEqual(parseAddress('192.168.1.50?x=1'), { error: 'path' });
  assert.deepEqual(parseAddress('192.168.1.500'), { error: 'invalid' });
  assert.deepEqual(parseAddress('192.168.1.50:0'), { error: 'invalid' });
  assert.deepEqual(parseAddress('192.168.1.50:70000'), { error: 'invalid' });
  assert.deepEqual(parseAddress('bad_host'), { error: 'invalid' });
  assert.deepEqual(parseAddress('[::1]'), { error: 'invalid' });
});

test('an invalid address is shown without what could be a secret', () => {
  const c = normalizeConfig({ address: 'http://admin:hunter2@192.168.1.50/k3y/JQ' });
  assert.equal(c.problem, 'credentials');
  assert.equal(c.invalid, 'http://…@192.168.1.50/…');
  assert.equal(c.address, undefined);
});

test('passkey and credentials: both or neither, printable ASCII', () => {
  assert.equal(normalizeConfig({ address: 'h', passkey: '/1234/' }).passkey, '1234');
  assert.equal(normalizeConfig({ address: 'h', passkey: '12 34' }).problem, 'passkey');
  assert.equal(normalizeConfig({ address: 'h', password: 'x' }).problem, 'passwordWithoutUser');
  assert.equal(normalizeConfig({ address: 'h', username: 'x' }).problem, 'userWithoutPassword');
  assert.equal(
    normalizeConfig({ address: 'h', username: 'a:b', password: 'x' }).problem,
    'credentialsInvalid',
  );
  assert.equal(
    normalizeConfig({ address: 'h', username: 'a', password: 'é' }).problem,
    'credentialsInvalid',
  );
  const ok = normalizeConfig({ address: 'h', username: 'a', password: ' p w ' });
  assert.equal(ok.problem, undefined);
  assert.equal(ok.password, ' p w ', 'a password is never trimmed');
  assert.deepEqual(ok.address, { host: 'h', port: 80 });
});

test('the commands: only true allows; the ceiling 40–65, 65 by default', () => {
  assert.equal(normalizeConfig({}).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ allow_commands: 1 }).allowCommands, false);
  assert.equal(dhwCapOf(undefined), 65);
  assert.equal(dhwCapOf(''), 65);
  assert.equal(dhwCapOf('abc'), 65);
  assert.equal(dhwCapOf(80), 65);
  assert.equal(dhwCapOf(65), 65);
  assert.equal(dhwCapOf(65.5), 65);
  assert.equal(dhwCapOf('30'), 40);
  assert.equal(dhwCapOf(52.9), 52);
});

test('the interval and the language', () => {
  assert.equal(normalizeConfig({}).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 2 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: '9999' }).pollInterval, 600);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
});

test('the connection key follows the address and the secrets, not the options', () => {
  const a = normalizeConfig({ address: 'h', username: 'u', password: 'p' });
  assert.equal(
    connectionKey(a),
    connectionKey(
      normalizeConfig({ address: 'h', username: 'u', password: 'p', allow_commands: true }),
    ),
  );
  assert.notEqual(
    connectionKey(a),
    connectionKey(normalizeConfig({ address: 'h', username: 'u', password: 'q' })),
  );
  assert.notEqual(
    connectionKey(a),
    connectionKey(normalizeConfig({ address: 'h', username: 'u', password: 'p', passkey: 'k' })),
  );
});

test('no prototype pollution from the configuration', () => {
  const c = normalizeConfig(JSON.parse('{"__proto__": {"allow_commands": true}, "address": "h"}'));
  assert.equal(c.allowCommands, false);
  assert.equal({}.allow_commands, undefined);
});
