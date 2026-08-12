const axios = require('axios');
const config = require('../config');

const MAX_PAGE_SIZE = 1000;
const MAX_PAGES_SAFETY_CAP = 200; // 200k rows hard stop, belt-and-braces against a runaway loop

/**
 * Shared Socrata (SODA) data-access client. Reused for both the NYSDOT AADT
 * dataset and the NYC automated traffic-volume-count dataset by pointing it
 * at a different { origin, datasetId, appToken }.
 */
class SocrataClient {
  constructor({ origin, datasetId, appToken }) {
    this.origin = origin;
    this.datasetId = datasetId;
    this.appToken = appToken;
    this.client = axios.create({
      baseURL: origin,
      timeout: config.apiTimeoutMs,
      headers: appToken ? { 'X-App-Token': appToken } : {},
    });
  }

  /**
   * Single page query against /resource/{datasetId}.json
   * @param {object} opts - { select, where, order, limit, offset }
   */
  async query({ select, where, order, group, limit = MAX_PAGE_SIZE, offset = 0 } = {}) {
    const params = { $limit: Math.min(limit, MAX_PAGE_SIZE), $offset: offset };
    if (select) params.$select = select;
    if (where) params.$where = where;
    if (order) params.$order = order;
    if (group) params.$group = group;

    // Grouped/aggregated queries can run noticeably slower server-side than
    // a plain row fetch, and Socrata occasionally 5xx's transiently — retry
    // with backoff before surfacing an error, rather than failing the whole
    // page fetch on one slow/flaky request.
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { data } = await this.client.get(`/resource/${this.datasetId}.json`, { params });
        return data;
      } catch (err) {
        lastErr = err;
        const isRetryable = err.code === 'ECONNABORTED' || (err.response?.status >= 500);
        if (!isRetryable || attempt === maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr;
  }

  /**
   * Pages through the full result set for a query, respecting Socrata's
   * per-request row cap, and returns every row concatenated.
   */
  async queryAll({ select, where, order, group } = {}, { maxPages = MAX_PAGES_SAFETY_CAP } = {}) {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.query({ select, where, order, group, limit: MAX_PAGE_SIZE, offset });
      rows.push(...batch);
      if (batch.length < MAX_PAGE_SIZE) break;
      offset += MAX_PAGE_SIZE;
    }
    return rows;
  }
}

module.exports = { SocrataClient, MAX_PAGE_SIZE };
