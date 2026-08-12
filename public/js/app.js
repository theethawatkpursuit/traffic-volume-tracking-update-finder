const state = {
  segments: [],
  county: '',
  map: null,
  markersLayer: null,
};

const els = {
  statTiles: document.getElementById('statTiles'),
  countySelect: document.getElementById('countySelect'),
  ageThreshold: document.getElementById('ageThreshold'),
  devThreshold: document.getElementById('devThreshold'),
  confidenceSelect: document.getElementById('confidenceSelect'),
  segmentsBody: document.getElementById('segmentsBody'),
  emptyState: document.getElementById('emptyState'),
  geocodeNote: document.getElementById('geocodeNote'),
  listView: document.getElementById('listView'),
  mapView: document.getElementById('mapView'),
  viewListBtn: document.getElementById('viewListBtn'),
  viewMapBtn: document.getElementById('viewMapBtn'),
  overlay: document.getElementById('overlay'),
  drawer: document.getElementById('drawer'),
  drawerClose: document.getElementById('drawerClose'),
  drawerContent: document.getElementById('drawerContent'),
  themeToggle: document.getElementById('themeToggle'),
};

// ---- Priority tiers (relative to the currently displayed set, since
// priority_score is an unbounded product with no fixed absolute scale) ----
function assignPriorityTiers(segments) {
  const sorted = [...segments].sort((a, b) => b.priorityScore - a.priorityScore);
  const n = sorted.length;
  sorted.forEach((s, i) => {
    const pct = n <= 1 ? 0 : i / (n - 1);
    if (pct <= 0.1) s._tier = 'critical';
    else if (pct <= 0.35) s._tier = 'serious';
    else if (pct <= 0.65) s._tier = 'warning';
    else s._tier = 'good';
  });
}

const tierIcon = { critical: '▲', serious: '▲', warning: '●', good: '●' };
const tierLabel = { critical: 'Critical', serious: 'Serious', warning: 'Watch', good: 'Low' };

function badgeHtml(tier) {
  return `<span class="badge tier-${tier}"><span class="dot tier-${tier}"></span>${tierLabel[tier]}</span>`;
}

function fmtPct(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}
function fmtNum(v) {
  if (v == null) return '—';
  return Math.round(v).toLocaleString();
}

async function loadCounties() {
  const res = await fetch('/api/counties');
  const data = await res.json();
  els.countySelect.innerHTML =
    `<option value="">All NYC boroughs (default)</option>` +
    `<optgroup label="NYC boroughs">` +
    data.nycCounties.map((c) => `<option value="${c}">${c}</option>`).join('') +
    `</optgroup><optgroup label="Other NY counties (no NYC spatial match)">` +
    data.allCounties.filter((c) => !data.nycCounties.includes(c)).map((c) => `<option value="${c}">${c}</option>`).join('') +
    `</optgroup>`;
}

function buildQuery() {
  const params = new URLSearchParams();
  if (els.countySelect.value) params.set('county', els.countySelect.value);
  if (els.ageThreshold.value) params.set('ageThresholdYears', els.ageThreshold.value);
  if (els.devThreshold.value) params.set('deviationThresholdPct', els.devThreshold.value);
  if (els.confidenceSelect.value) params.set('confidenceLevel', els.confidenceSelect.value);
  return params.toString();
}

async function loadSegments() {
  els.segmentsBody.innerHTML = `<tr><td colspan="9" class="loading-inline">Loading… (first load per county can take a while — the AADT dataset is paged from the source API)</td></tr>`;
  const res = await fetch(`/api/segments?${buildQuery()}`);
  const data = await res.json();
  state.segments = data.segments;
  assignPriorityTiers(state.segments);
  renderStats(data.summary, data.geocodeProgress);
  renderTable(state.segments);
  if (state.map) renderMapMarkers(state.segments);
}

function renderStats(summary, geocodeProgress) {
  els.statTiles.innerHTML = `
    <div class="stat-tile">
      <div class="value">${summary.total}</div>
      <div class="label">Segments in scope</div>
    </div>
    <div class="stat-tile">
      <div class="value">${summary.pctOlderThan5Years}%</div>
      <div class="label">Older than 5 years</div>
    </div>
    <div class="stat-tile">
      <div class="value">${summary.pctStaleWithSignificantUnexplainedDeviation}%</div>
      <div class="label">Stale entries w/ significant unexplained deviation</div>
      <div class="sublabel">of the stale subset</div>
    </div>
  `;
  if (geocodeProgress && geocodeProgress.totalUniqueStations > 0) {
    const pct = Math.round((geocodeProgress.geocodedCount / geocodeProgress.totalUniqueStations) * 100);
    els.geocodeNote.textContent =
      pct < 100
        ? `Spatial-match geocoding in progress: ${geocodeProgress.geocodedCount}/${geocodeProgress.totalUniqueStations} AADT stations located (${pct}%). Unmatched stations will gain deviation data as this completes in the background.`
        : `All ${geocodeProgress.totalUniqueStations} AADT stations in scope have been geocoded for spatial matching.`;
  } else {
    els.geocodeNote.textContent = '';
  }
}

function spatialMatchLabel(s) {
  switch (s.spatialMatchStatus) {
    case 'matched':
      return `${s.spatialMatch.street || ''} (${s.spatialMatch.distanceMeters}m)`;
    case 'no-match-within-radius':
      return 'No NYC count nearby';
    case 'geocode-pending':
      return 'Geocoding pending…';
    case 'geocode-failed':
      return 'Could not locate station';
    case 'not-applicable-outside-nyc':
      return 'Outside NYC (AADT only)';
    default:
      return '—';
  }
}

function renderTable(segments) {
  if (segments.length === 0) {
    els.segmentsBody.innerHTML = '';
    els.emptyState.style.display = 'block';
    return;
  }
  els.emptyState.style.display = 'none';
  els.segmentsBody.innerHTML = segments
    .map(
      (s) => `
    <tr data-station="${s.stationId}" data-county="${s.county}" data-tier="${s._tier}">
      <td>${badgeHtml(s._tier)}</td>
      <td>${s.stationId}<div class="confidence-tag">${s.confidence.dataPointCount} pt${s.confidence.dataPointCount === 1 ? '' : 's'}</div></td>
      <td>${s.roadName || s.stateRoute || '—'}<div class="confidence-tag">${s.municipality || s.county}</div></td>
      <td class="num">${s.confidence.ageYears ?? '—'}</td>
      <td>${s.confidence.trendConfidence}${s.confidence.isLongExtrapolation ? '<div class="confidence-tag">long extrapolation</div>' : ''}</td>
      <td class="num">${fmtNum(s.aadtExpectedCurrent)}</td>
      <td class="num">${fmtNum(s.aadtRecentEstimate)}${s.confidence.isShortCountEstimate ? '<div class="confidence-tag">short count</div>' : ''}</td>
      <td class="num">${fmtPct(s.deviationPct)}${s.isDeviationSignificant ? '<div class="confidence-tag">significant</div>' : ''}</td>
      <td>${spatialMatchLabel(s)}</td>
    </tr>`
    )
    .join('');

  els.segmentsBody.querySelectorAll('tr').forEach((row) => {
    row.addEventListener('click', () => openDetail(row.dataset.county, row.dataset.station, row.dataset.tier));
  });
}

// ---- Map view ----
function ensureMap() {
  if (state.map) return;
  state.map = L.map('leafletMap').setView([40.7128, -73.94], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(state.map);
  state.markersLayer = L.layerGroup().addTo(state.map);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = ['critical', 'serious', 'warning', 'good']
      .map((t) => `<div class="row"><span class="dot" style="background:var(--status-${t})"></span>${tierLabel[t]} priority</div>`)
      .join('');
    return div;
  };
  legend.addTo(state.map);
}

function tierColor(tier) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--status-${tier}`).trim();
  return v || '#999';
}

function renderMapMarkers(segments) {
  state.markersLayer.clearLayers();
  const located = segments.filter((s) => s.stationLocation?.lat != null);
  for (const s of located) {
    const marker = L.circleMarker([s.stationLocation.lat, s.stationLocation.lon], {
      radius: 6,
      color: tierColor(s._tier),
      fillColor: tierColor(s._tier),
      fillOpacity: 0.85,
      weight: 1,
    });
    marker.bindTooltip(`${s.roadName || s.stateRoute} — ${tierLabel[s._tier]} priority`);
    marker.on('click', () => openDetail(s.county, s.stationId, s._tier));
    marker.addTo(state.markersLayer);
  }
  if (located.length === 0) {
    els.geocodeNote.textContent += ' No geocoded station locations to plot yet for this scope.';
  }
}

// ---- Detail drawer ----
async function openDetail(county, stationId, tier) {
  els.overlay.classList.add('active');
  els.drawer.classList.add('active');
  els.drawerContent.innerHTML = '<div class="loading-inline">Loading segment detail…</div>';

  const res = await fetch(`/api/segments/${encodeURIComponent(county)}/${encodeURIComponent(stationId)}`);
  if (!res.ok) {
    els.drawerContent.innerHTML = '<p>Could not load this segment.</p>';
    return;
  }
  const { segment: s, liveConditions } = await res.json();
  s._tier = tier || 'warning'; // carry over the tier already computed for the currently displayed list/map (relative to that scope)

  els.drawerContent.innerHTML = `
    <h2>${s.roadName || s.stateRoute || 'Station ' + s.stationId}</h2>
    <div class="sub">Station ${s.stationId} • ${s.municipality || s.county}, ${s.county} County</div>

    <div class="section">
      <h3>Priority</h3>
      ${badgeHtml(s._tier || 'warning')}
      <span style="margin-left:8px; color:var(--text-secondary); font-size:12.5px;">score ${Math.round(s.priorityScore * 10) / 10} — ${s.priorityBasis}</span>
    </div>

    <div class="section">
      <h3>Confidence</h3>
      <div class="kv">
        <div><span class="k">Data points</span><span class="v">${s.confidence.dataPointCount}</span></div>
        <div><span class="k">Trend confidence</span><span class="v">${s.confidence.trendConfidence}</span></div>
        <div><span class="k">Last data year</span><span class="v">${s.confidence.lastDataYear ?? '—'}</span></div>
        <div><span class="k">Age (years)</span><span class="v">${s.confidence.ageYears ?? '—'}</span></div>
        <div><span class="k">Long extrapolation</span><span class="v">${s.confidence.isLongExtrapolation ? 'yes' : 'no'}</span></div>
        <div><span class="k">Short-count estimate</span><span class="v">${s.confidence.isShortCountEstimate ? 'yes' : s.confidence.isShortCountEstimate === false ? 'no' : '—'}</span></div>
      </div>
    </div>

    <div class="section">
      <h3>Historical AADT trend</h3>
      <div id="trendChart"></div>
    </div>

    <div class="section">
      <h3>Deviation</h3>
      <div class="kv">
        <div><span class="k">Expected current AADT</span><span class="v">${fmtNum(s.aadtExpectedCurrent)}</span></div>
        <div><span class="k">Recent NYC estimate</span><span class="v">${fmtNum(s.aadtRecentEstimate)}</span></div>
        <div><span class="k">Deviation</span><span class="v">${fmtPct(s.deviationPct)}</span></div>
        <div><span class="k">Significant?</span><span class="v">${s.isDeviationSignificant == null ? 'n/a' : s.isDeviationSignificant ? 'yes' : 'no'}</span></div>
        <div><span class="k">Explained?</span><span class="v">${s.isExplained ? 'yes' : 'no'}</span></div>
        <div><span class="k">Single-ever count?</span><span class="v">${s.isSingleEverCount ? 'yes — refresh candidate regardless of deviation' : 'no'}</span></div>
      </div>
    </div>

    <div class="section">
      <h3>Spatial match</h3>
      <p style="margin:0; font-size:12.5px; color:var(--text-secondary);">${spatialMatchLabel(s)}${s.stationLocation?.confidence ? ` — geocode confidence: ${s.stationLocation.confidence}` : ''}</p>
    </div>

    <div class="section">
      <h3>Live conditions (TomTom, queried just now)</h3>
      ${renderLiveConditions(liveConditions)}
    </div>
  `;

  renderTrendChart(document.getElementById('trendChart'), {
    history: s.history,
    trend: s.trend,
    nycEstimate: s.nycEstimate,
    currentYear: new Date().getFullYear(),
  });
}

function renderLiveConditions(lc) {
  if (!lc) return '<p style="color:var(--text-muted); font-size:12.5px;">No station location available to query live conditions.</p>';
  if (lc.error) return `<p style="color:var(--text-muted); font-size:12.5px;">Live conditions unavailable: ${lc.message}</p>`;
  const congestion = lc.congestionRatio != null ? `${Math.round(lc.congestionRatio * 100)}%` : '—';
  return `
    <div class="kv">
      <div><span class="k">Current speed</span><span class="v">${lc.currentSpeed ?? '—'} km/h</span></div>
      <div><span class="k">Free-flow speed</span><span class="v">${lc.freeFlowSpeed ?? '—'} km/h</span></div>
      <div><span class="k">Congestion</span><span class="v">${congestion}</span></div>
      <div><span class="k">Road closure</span><span class="v">${lc.roadClosure ? 'yes' : 'no'}</span></div>
    </div>
  `;
}

function closeDetail() {
  els.overlay.classList.remove('active');
  els.drawer.classList.remove('active');
}

// ---- Wiring ----
els.drawerClose.addEventListener('click', closeDetail);
els.overlay.addEventListener('click', closeDetail);

[els.countySelect, els.ageThreshold, els.devThreshold, els.confidenceSelect].forEach((el) => {
  el.addEventListener('change', loadSegments);
});

els.viewListBtn.addEventListener('click', () => {
  els.viewListBtn.classList.add('active');
  els.viewMapBtn.classList.remove('active');
  els.listView.classList.remove('hidden');
  els.mapView.classList.remove('active');
});
els.viewMapBtn.addEventListener('click', () => {
  els.viewMapBtn.classList.add('active');
  els.viewListBtn.classList.remove('active');
  els.listView.classList.add('hidden');
  els.mapView.classList.add('active');
  ensureMap();
  setTimeout(() => state.map.invalidateSize(), 50);
  renderMapMarkers(state.segments);
});

els.themeToggle.addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : current === 'light' ? null : 'dark';
  if (next) root.setAttribute('data-theme', next);
  else root.removeAttribute('data-theme');
  localStorage.setItem('theme', next || '');
});
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

(async function init() {
  await loadCounties();
  await loadSegments();
})();
