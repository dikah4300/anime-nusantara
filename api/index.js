'use strict';
// Adaptor serverless Vercel: seluruh routing tetap ditangani router() di server.js.
// Vercel meneruskan sisa path lewat parameter __p (lihat vercel.json).
const { router, init } = require('../server.js');

let ready = null;
function prepare() {
  if (!ready) ready = Promise.resolve().then(() => init());
  return ready;
}

function originalUrl(raw) {
  const qIndex = raw.indexOf('?');
  const search = qIndex === -1 ? '' : raw.slice(qIndex + 1);
  const params = new URLSearchParams(search);
  if (!params.has('__p')) return raw;
  const rest = params.get('__p') || '';
  params.delete('__p');
  const qs = params.toString();
  return '/api/' + rest + (qs ? '?' + qs : '');
}

module.exports = async (req, res) => {
  try {
    await prepare();
    req.url = originalUrl(req.url || '/');
    await router(req, res);
  } catch (err) {
    console.error('[api]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: err.message } }));
    } else {
      res.end();
    }
  }
};

module.exports.config = { maxDuration: 60 };
