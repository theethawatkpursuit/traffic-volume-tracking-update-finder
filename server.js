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

app.listen(config.port, () => {
  console.log(`NYC Traffic Volume Update Finder listening on http://localhost:${config.port}`);
  // Fills in the AADT-station geocode cache incrementally in the background
  // (rate-limited to Nominatim's usage policy) so the spatial join gets more
  // complete over time without blocking startup or requests.
  startGeocodeWarmup();
});
