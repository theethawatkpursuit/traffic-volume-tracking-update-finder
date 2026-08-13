/**
 * Serverless entrypoint (Vercel and anything else expecting an exported
 * handler). The app itself is unchanged — server.js only binds a port when run
 * directly, so importing it here yields a plain Express request handler.
 *
 * Read the deployment notes in the README before relying on this: a cold
 * county load pages ~95k rows and can exceed the platform's function timeout,
 * and serverless instances share no memory, so the in-process caches and the
 * progress-bar polling behave very differently here than on a persistent host.
 */
module.exports = require('../server.js');
