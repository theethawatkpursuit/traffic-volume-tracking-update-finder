const express = require('express');
const path = require('node:path');
const config = require('./server/config');
const apiRouter = require('./server/routes/api');
const { startGeocodeWarmup } = require('./server/services/segmentsRepository');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

/**
 * Only bind a port when this file is run directly (`node server.js`, `npm
 * start`, `npm run dev`, a container). Under a serverless host the platform
 * owns the listener and imports the app instead — calling listen() there is
 * what makes an Express app silently serve nothing.
 */
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`RecountNYC listening on http://localhost:${config.port}`);
    console.log(
      `Cache directory: ${config.dataDir}${config.dataDirIsPersistent ? '' : ' (ephemeral)'}`
    );
    if (config.enableGeocodeWarmup) {
      // Fills in the AADT-station geocode cache incrementally in the background
      // (rate-limited to Nominatim's usage policy) so the spatial join gets more
      // complete over time without blocking startup or requests.
      startGeocodeWarmup();
    } else {
      console.log('Geocode warmup disabled (no persistent cache directory).');
    }
  });
}

module.exports = app;
