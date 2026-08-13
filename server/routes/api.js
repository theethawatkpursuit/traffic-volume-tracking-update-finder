const express = require('express');
const repo = require('../services/segmentsRepository');
const tomtomService = require('../services/tomtomService');
const fiveElevenService = require('../services/fiveElevenService');

const router = express.Router();

router.get('/counties', (req, res) => {
  res.json({
    nycCounties: repo.NYC_COUNTIES,
    allCounties: repo.ALL_NY_COUNTIES,
  });
});

router.get('/segments', async (req, res, next) => {
  try {
    const { county, ageThresholdYears, deviationThresholdPct, confidenceLevel } = req.query;
    const segments = await repo.listSegments({
      county: county || undefined,
      ageThresholdYears,
      deviationThresholdPct,
      confidenceLevel,
    });
    const eventIndex = await fiveElevenService.getNycEventIndex();
    res.json({
      segments,
      summary: repo.summarize(segments),
      geocodeProgress: await repo.geocodeProgressForScope(county || undefined),
      // Feed-level status so the UI can distinguish "no work zones near any of
      // these segments" from "511 didn't answer, so nothing was checked".
      eventFeed: {
        status: eventIndex.status,
        activeNycEvents: eventIndex.count,
        message: eventIndex.message ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/segments/:county/:stationId', async (req, res, next) => {
  try {
    const { county, stationId } = req.params;
    const segment = await repo.getSegmentDetail(county, stationId);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });

    // Live conditions are queried on-demand, per viewed segment only — never bulk.
    let liveConditions = null;
    if (segment.stationLocation?.lat != null) {
      liveConditions = await tomtomService.getFlowSegmentData(
        segment.stationLocation.lat,
        segment.stationLocation.lon
      );
    }

    res.json({ segment, liveConditions });
  } catch (err) {
    next(err);
  }
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

module.exports = router;
