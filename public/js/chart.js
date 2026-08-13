/* Minimal dependency-free SVG line chart for the AADT historical trend +
   recent NYC estimate overlay. Follows the house style: thin 2px lines,
   rounded caps, a hover crosshair+tooltip, a legend (2 series), recessive
   gridlines, text in ink tokens never in series color. */
function renderTrendChart(container, { history, trend, nycEstimate, currentYear }) {
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const seriesHistorical = cssVar('--series-1') || '#2a78d6';
  const seriesRecent = cssVar('--series-2') || '#eb6834';
  const textSecondary = cssVar('--text-secondary') || '#52514e';
  const textMuted = cssVar('--text-muted') || '#898781';
  const gridline = cssVar('--gridline') || '#e1e0d9';
  const axisColor = cssVar('--axis') || '#c3c2b7';
  const surface = cssVar('--surface') || '#fcfcfb';

  const width = container.clientWidth || 500;
  const height = 260;
  const margin = { top: 16, right: 20, bottom: 28, left: 56 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const points = (history || []).map((h) => ({ year: h.year, value: h.aadt, kind: 'observed' }));
  const projectedPoint =
    trend?.aadtExpectedCurrent != null ? { year: currentYear, value: trend.aadtExpectedCurrent, kind: 'projected' } : null;
  const recentPoint =
    nycEstimate?.aadtRecentEstimate != null
      ? { year: currentYear, value: nycEstimate.aadtRecentEstimate, kind: 'recent' }
      : null;

  const allValues = points.map((p) => p.value).concat(projectedPoint ? [projectedPoint.value] : [], recentPoint ? [recentPoint.value] : []);
  const allYears = points.map((p) => p.year).concat(projectedPoint ? [projectedPoint.year] : []);
  if (allValues.length === 0) {
    container.innerHTML = '<div class="loading-inline">No historical readings available.</div>';
    return;
  }
  const minYear = Math.min(...allYears);
  const maxYear = Math.max(...allYears, currentYear);
  const maxValue = Math.max(...allValues) * 1.1;

  const x = (year) => margin.left + ((year - minYear) / Math.max(1, maxYear - minYear)) * innerW;
  const y = (value) => margin.top + innerH - (value / maxValue) * innerH;

  const yTicks = 4;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => (maxValue / yTicks) * i);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.year)} ${y(p.value)}`).join(' ');
  const projectedPath =
    projectedPoint && points.length
      ? `M ${x(points[points.length - 1].year)} ${y(points[points.length - 1].value)} L ${x(projectedPoint.year)} ${y(projectedPoint.value)}`
      : '';

  const svgNS = 'http://www.w3.org/2000/svg';
  container.innerHTML = '';

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // Gridlines + y-axis labels
  for (const v of yTickVals) {
    const gy = y(v);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', margin.left);
    line.setAttribute('x2', width - margin.right);
    line.setAttribute('y1', gy);
    line.setAttribute('y2', gy);
    line.setAttribute('stroke', gridline);
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', margin.left - 8);
    label.setAttribute('y', gy + 3);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('font-size', '10.5');
    label.setAttribute('fill', textMuted);
    label.textContent = Math.round(v).toLocaleString();
    svg.appendChild(label);
  }

  // X axis (baseline)
  const baseline = document.createElementNS(svgNS, 'line');
  baseline.setAttribute('x1', margin.left);
  baseline.setAttribute('x2', width - margin.right);
  baseline.setAttribute('y1', margin.top + innerH);
  baseline.setAttribute('y2', margin.top + innerH);
  baseline.setAttribute('stroke', axisColor);
  baseline.setAttribute('stroke-width', '1');
  svg.appendChild(baseline);

  [minYear, maxYear].forEach((yr) => {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', x(yr));
    label.setAttribute('y', height - 8);
    label.setAttribute('text-anchor', yr === minYear ? 'start' : 'end');
    label.setAttribute('font-size', '10.5');
    label.setAttribute('fill', textMuted);
    label.textContent = yr;
    svg.appendChild(label);
  });

  // Projected (dashed) segment from last observed point to current-year expected value
  if (projectedPath) {
    const proj = document.createElementNS(svgNS, 'path');
    proj.setAttribute('d', projectedPath);
    proj.setAttribute('fill', 'none');
    proj.setAttribute('stroke', seriesHistorical);
    proj.setAttribute('stroke-width', '2');
    proj.setAttribute('stroke-dasharray', '4 3');
    proj.setAttribute('stroke-linecap', 'round');
    svg.appendChild(proj);
  }

  // Observed historical trend line
  if (linePath) {
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', linePath);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', seriesHistorical);
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
  }

  // Observed point markers
  for (const p of points) {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', x(p.year));
    c.setAttribute('cy', y(p.value));
    c.setAttribute('r', '4');
    c.setAttribute('fill', surface);
    c.setAttribute('stroke', seriesHistorical);
    c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
  }

  // Recent NYC estimate marker (series-2)
  if (recentPoint) {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', x(recentPoint.year));
    c.setAttribute('cy', y(recentPoint.value));
    c.setAttribute('r', '5');
    c.setAttribute('fill', seriesRecent);
    c.setAttribute('stroke', surface);
    c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
  }

  // Hover crosshair + tooltip
  const tooltip = document.createElement('div');
  tooltip.style.cssText = `position:absolute; pointer-events:none; background:${surface}; border:1px solid ${gridline}; border-radius:6px; padding:6px 9px; font-size:11.5px; color:${textSecondary}; display:none; z-index:10; box-shadow:0 2px 8px rgba(0,0,0,0.12);`;
  container.style.position = 'relative';

  const crosshair = document.createElementNS(svgNS, 'line');
  crosshair.setAttribute('y1', margin.top);
  crosshair.setAttribute('y2', margin.top + innerH);
  crosshair.setAttribute('stroke', axisColor);
  crosshair.setAttribute('stroke-width', '1');
  crosshair.setAttribute('stroke-dasharray', '2 2');
  crosshair.style.display = 'none';
  svg.appendChild(crosshair);

  const hitRect = document.createElementNS(svgNS, 'rect');
  hitRect.setAttribute('x', margin.left);
  hitRect.setAttribute('y', margin.top);
  hitRect.setAttribute('width', innerW);
  hitRect.setAttribute('height', innerH);
  hitRect.setAttribute('fill', 'transparent');

  const allPoints = points.concat(projectedPoint ? [projectedPoint] : []).concat(recentPoint ? [recentPoint] : []);
  hitRect.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let nearest = allPoints[0];
    let minDist = Infinity;
    for (const p of allPoints) {
      const d = Math.abs(x(p.year) - mx);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    crosshair.setAttribute('x1', x(nearest.year));
    crosshair.setAttribute('x2', x(nearest.year));
    crosshair.style.display = 'block';

    // Content first, position second — the tooltip has to be rendered with its
    // final text before offsetWidth means anything.
    const kindLabel = { observed: 'Observed AADT', projected: 'Projected (expected) AADT', recent: 'Recent NYC estimate' }[nearest.kind];
    tooltip.innerHTML = `<strong>${nearest.year}</strong><br>${kindLabel}: ${Math.round(nearest.value).toLocaleString()}`;
    tooltip.style.display = 'block';

    // The current-year points (projected AADT and the recent NYC estimate) sit
    // at the far right of the chart, so a tooltip always drawn to the right of
    // the point runs past the drawer edge and can't be read. Flip it to the
    // left of the crosshair whenever it wouldn't fit, and keep it inside the
    // chart vertically.
    const pointX = x(nearest.year);
    const tipW = tooltip.offsetWidth;
    const tipH = tooltip.offsetHeight;
    const placeLeft = pointX + 10 + tipW > width;
    tooltip.style.left = `${Math.max(0, placeLeft ? pointX - 10 - tipW : pointX + 10)}px`;
    tooltip.style.top = `${Math.min(Math.max(0, y(nearest.value) - 10), height - tipH)}px`;
  });
  hitRect.addEventListener('mouseleave', () => {
    crosshair.style.display = 'none';
    tooltip.style.display = 'none';
  });
  svg.appendChild(hitRect);

  container.appendChild(svg);
  container.appendChild(tooltip);

  const legend = document.createElement('div');
  legend.className = 'legend-row';
  legend.innerHTML = `
    <span class="item"><span class="swatch" style="background:${seriesHistorical}"></span>Historical / projected AADT trend</span>
    ${recentPoint ? `<span class="item"><span class="swatch" style="background:${seriesRecent}"></span>Recent NYC short-count estimate</span>` : ''}
  `;
  container.appendChild(legend);
}
