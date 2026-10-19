// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP request to the
// adapter on node:http (BSB-LAN speaks no TLS). A deadline for the whole
// exchange, a size cap on the body, no redirect followed, no keep-alive.
// Resolves { status, headers, body } for any status; rejects a BsbError for
// the transport failures, with `sent` true as soon as the connection was up
// (the request may then have reached the adapter). `sendWithin`: the
// connection must be up within this many ms, else nothing is written (a
// command never leaves late).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { BsbError, CODES } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) {
    return new BsbError(CODES.BAD_ANSWER, { sent });
  }
  // Only our code: a message may carry an address or a header value.
  return new BsbError(CODES.UNREACHABLE, { sent });
}

/**
 * @param {object} options
 * @param {'GET' | 'POST'} options.method
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body] a JSON text
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 */
export function httpRequest({
  method,
  host,
  port,
  path,
  headers = {},
  body,
  timeout,
  sendWithin,
  maxBytes,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    // Until the connection is up, nothing of the request has left: a failure
    // then is "not sent" for sure (see the commands).
    let connected = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new BsbError(CODES.TIMEOUT, { sent: connected })),
      timeout,
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new BsbError(CODES.LATE));
              }
            },
            Math.max(0, sendWithin),
          );
    const markConnected = () => {
      if (!connected && !settled) {
        connected = true;
        clearTimeout(sendTimer);
        req.end(body ?? '');
      }
    };

    try {
      const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
      req = http.request({
        method,
        host,
        port,
        path,
        agent: false,
        headers: {
          accept: 'application/json',
          host: port === 80 ? host : `${host}:${port}`,
          connection: 'close',
          'content-length': String(payload?.length ?? 0),
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new BsbError(CODES.TOO_LARGE, { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, true)));
      });
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markConnected();
        } else {
          socket.once('connect', markConnected);
        }
      });
      req.on('error', (err) => finish(transportError(err, connected)));
    } catch (err) {
      // http.request throws on a header it refuses (an invisible character in
      // the user name): a failure, never a crash; nothing left.
      finish(transportError(err, false));
    }
  });
}
