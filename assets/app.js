/* Housing Market Tracker - app logic */
'use strict';

const state = {
  zip: '95123',
  priceRange: '5Y',
  priceMetric: 'value',
  rateOverlay: false,
  ptype: 'all',
  corrRange: '10Y',
  corrMetric: 'sold'
};

const DATA = {};
const charts = {};
function killChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

/* ---------- formatting ---------- */
function fmtMoney(v) {
  if (v == null || isNaN(v)) return 'N/A';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}
function fmtInt(v) {
  if (v == null || isNaN(v)) return 'N/A';
  return Math.round(v).toLocaleString('en-US');
}
function fmtPct(v, digits = 1) {
  if (v == null || isNaN(v)) return 'N/A';
  return v.toFixed(digits) + '%';
}
function fmtSignedPct(v, digits = 1) {
  if (v == null || isNaN(v)) return 'N/A';
  const s = v > 0 ? '+' : '';
  return s + v.toFixed(digits) + '%';
}
function dirClass(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function monthKey(d) { return d.slice(0, 7); } // 'YYYY-MM-DD' -> 'YYYY-MM'
function prettyMonth(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}
function prettyWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function pctChange(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev) * 100;
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* ---------- data loading ---------- */
async function loadData() {
  const files = ['zips', 'metro', 'weekly', 'rates', 'seasonality', 'national_sales', 'case_shiller', 'meta'];
  const results = await Promise.all(files.map(f => fetch('data/' + f + '.json').then(r => {
    if (!r.ok) throw new Error('Failed to load data/' + f + '.json');
    return r.json();
  })));
  files.forEach((f, i) => { DATA[f] = results[i]; });
}

function zipSeries() { return DATA.zips[state.zip].series; }
function zipMeta() { return DATA.zips[state.zip]; }
function metroSeries() { return DATA.metro.series; }
function weeklySeries() { return DATA.weekly.series; }
function rateMap() {
  const m = {};
  DATA.rates.series.forEach(([d, v]) => { if (v != null) m[monthKey(d)] = v; });
  return m;
}

/* ---------- chart defaults ---------- */
function baseOptions(extra) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#8b949e', boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: '#8b949e', maxTicksLimit: 8 }, grid: { color: '#21262d' } },
      y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
    }
  }, extra || {});
}

/* ---------- address / ZIP lookup ---------- */
async function resolveZip(input) {
  const t = input.trim();
  if (/^\d{5}$/.test(t)) {
    if (DATA.zips[t]) return t;
    throw new Error('ZIP ' + t + ' is outside the 274 Bay Area ZIPs covered.');
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=' + encodeURIComponent(t);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Address lookup failed. Try a 5-digit ZIP.');
  const arr = await res.json();
  if (!arr.length || !arr[0].address || !arr[0].address.postcode) throw new Error('Could not resolve an address from that input.');
  const z = arr[0].address.postcode.slice(0, 5);
  if (!/^\d{5}$/.test(z) || !DATA.zips[z]) throw new Error('Resolved ZIP ' + z + ' is outside the 274 Bay Area ZIPs covered.');
  return z;
}
function setAreaLabel() {
  const m = zipMeta();
  document.getElementById('areaLabel').innerHTML =
    'ZIP ' + state.zip + ' &middot; ' + m.city + ', ' + m.county + ' County';
}
async function onLookup() {
  const input = document.getElementById('addrInput').value;
  const err = document.getElementById('zipError');
  err.hidden = true;
  if (!input.trim()) return;
  try {
    state.zip = await resolveZip(input);
    setAreaLabel();
    renderAll();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

/* ---------- KPI ticker ---------- */
function renderKpis() {
  const s = zipSeries();
  const latest = s[s.length - 1];
  const prevM = s[s.length - 2];
  const prevY = s.length >= 13 ? s[s.length - 13] : null;
  const mom = prevM ? pctChange(latest[1], prevM[1]) : null;
  const yoy = prevY ? pctChange(latest[1], prevY[1]) : null;

  const metro = metroSeries();
  const mLast = metro[metro.length - 1];
  const rates = DATA.rates.series.filter(r => r[1] != null);
  const rLast = rates[rates.length - 1];

  const wk = weeklySeries();
  const t28 = wk.slice(-4).reduce((a, r) => a + (r.homes_sold || 0), 0);

  const cards = [
    { label: 'ZIP home value', value: fmtMoney(latest[1]), sub: '<span class="' + dirClass(mom) + '">' + fmtSignedPct(mom) + ' MoM</span> &middot; <span class="' + dirClass(yoy) + '">' + fmtSignedPct(yoy) + ' YoY</span>' },
    { label: 'Days on market', value: mLast.dom != null ? mLast.dom.toFixed(0) : 'N/A', sub: 'median, metro', scope: 'metro' },
    { label: 'Sale-to-list', value: fmtPct(mLast.sale_to_list), sub: mLast.pct_above_list != null ? fmtPct(mLast.pct_above_list) + ' sold above list' : '', scope: 'metro' },
    { label: '30-yr mortgage', value: fmtPct(rLast[1], 2), sub: DATA.rates.latest_month_partial && rLast[0] === rates[rates.length - 1][0] ? 'national, partial month' : 'national', scope: 'national' },
    { label: 'Buyer/seller ratio', value: mLast.buyer_seller_ratio != null ? mLast.buyer_seller_ratio.toFixed(2) : 'N/A', sub: 'sellers per buyer, metro', scope: 'metro' },
    { label: 'Sold, trailing 28d', value: fmtInt(t28), sub: 'metro, 4-week sum', scope: 'metro' },
    { label: 'Sold, last month', value: fmtInt(mLast.homes_sold), sub: prettyMonth(mLast.date) + ', metro', scope: 'metro' },
    { label: 'Price cuts', value: fmtPct(mLast.price_drops_pct), sub: 'of metro listings', scope: 'metro' }
  ];

  document.getElementById('kpiRow').innerHTML = cards.map(c =>
    '<div class="kpi"><div class="k-label">' + c.label + '</div><div class="k-value">' + c.value +
    '</div><div class="k-sub">' + c.sub + '</div></div>'
  ).join('');

  document.getElementById('vintageKpi').textContent =
    'Values: ZHVI monthly, ZIP-level, through ' + prettyMonth(latest[0]) + ' (Zillow) · ' +
    'Market: Redfin monthly, San Jose metro, through ' + prettyMonth(mLast.date) + ' · ' +
    'Rate: FRED 30-yr fixed, national, through ' + prettyMonth(rLast[0]) + (DATA.rates.latest_month_partial ? ' (partial)' : '') + ' · ' +
    'Sales: Redfin weekly, metro, week ending ' + prettyWeek(wk[wk.length - 1].week_ending);
}

/* ---------- price chart ---------- */
function rangeCutoff(range) {
  if (range === 'MAX') return null;
  const yrs = { '1Y': 1, '3Y': 3, '5Y': 5, '10Y': 10 }[range];
  const s = zipSeries();
  const lastD = new Date(s[s.length - 1][0]);
  lastD.setFullYear(lastD.getFullYear() - yrs);
  return lastD.getTime();
}
function renderPriceChart() {
  killChart('priceChart');
  const s = zipSeries();
  const cutoff = rangeCutoff(state.priceRange);

  // compute metric on full series, then slice for display
  const full = s.map(([d, v], i) => {
    let y = v;
    if (state.priceMetric === 'yoy' && i >= 12 && s[i - 12][1]) y = (v - s[i - 12][1]) / s[i - 12][1] * 100;
    if (state.priceMetric === 'mom' && i >= 1 && s[i - 1][1]) y = (v - s[i - 1][1]) / s[i - 1][1] * 100;
    if ((state.priceMetric === 'yoy' && i < 12) || (state.priceMetric === 'mom' && i < 1)) y = null;
    return { d, y };
  });
  const rows = cutoff ? full.filter(r => new Date(r.d).getTime() >= cutoff) : full;

  const labels = rows.map(r => prettyMonth(r.d));
  const isPct = state.priceMetric !== 'value';
  const color = isPct ? '#58a6ff' : '#3fb950';
  const datasets = [{
    label: state.priceMetric === 'value' ? 'Home value' : (state.priceMetric === 'yoy' ? 'YoY %' : 'MoM %'),
    data: rows.map(r => r.y),
    borderColor: color, backgroundColor: color + '22',
    pointRadius: 0, borderWidth: 2, tension: 0.15, spanGaps: true, yAxisID: 'y'
  }];

  const scalesExtra = {};
  if (state.rateOverlay) {
    const rm = rateMap();
    datasets.push({
      label: '30-yr mortgage rate %',
      data: rows.map(r => rm[monthKey(r.d)] ?? null),
      borderColor: '#d29922', pointRadius: 0, borderWidth: 1.5,
      borderDash: [5, 4], tension: 0.15, spanGaps: true, yAxisID: 'y1'
    });
    scalesExtra.y1 = {
      position: 'right', ticks: { color: '#d29922', callback: v => v + '%' },
      grid: { drawOnChartArea: false }
    };
  }

  charts.priceChart = new Chart(document.getElementById('priceChart'), {
    type: 'line',
    data: { labels, datasets },
    options: baseOptions({
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + ctx.dataset.label + ': ' +
              (ctx.dataset.yAxisID === 'y1' ? fmtPct(ctx.parsed.y, 2)
                : (isPct ? fmtSignedPct(ctx.parsed.y) : fmtMoney(ctx.parsed.y)))
          }
        }
      },
      scales: Object.assign({
        x: { ticks: { color: '#8b949e', maxTicksLimit: 10 }, grid: { color: '#21262d' } },
        y: {
          ticks: { color: '#8b949e', callback: v => isPct ? v + '%' : fmtMoney(v) },
          grid: { color: '#21262d' }
        }
      }, scalesExtra)
    })
  });

  document.getElementById('vintagePrice').textContent =
    'ZHVI, ZIP-level, monthly through ' + prettyMonth(s[s.length - 1][0]) + ' (Zillow)' +
    (state.rateOverlay ? ' · Rate: FRED MORTGAGE30US, national monthly' : '');
}

/* ---------- velocity charts ---------- */
const PTYPE_FIELDS = {
  all:   { sold: 'homes_sold', dom: 'dom', stl: 'sale_to_list', above: 'pct_above_list', off2wk: 'pct_off_market_2wk' },
  sf:    { sold: 'homes_sold_sf', dom: 'dom_sf', stl: 'sale_to_list_sf', above: 'pct_above_list_sf', off2wk: 'pct_off_market_2wk' },
  condo: { sold: 'homes_sold_condo', dom: 'dom_condo', stl: 'sale_to_list_condo', above: 'pct_above_list_condo', off2wk: 'pct_off_market_2wk' },
  th:    { sold: 'homes_sold_th', dom: 'dom_th', stl: 'sale_to_list_th', above: 'pct_above_list_th', off2wk: 'pct_off_market_2wk' }
};
function miniChart(id, title, field, fmtFn, color) {
  killChart(id);
  const s = metroSeries();
  const labels = s.map(r => prettyMonth(r.date));
  const data = s.map(r => r[field]);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + '22', fill: true, pointRadius: 0, borderWidth: 1.5, spanGaps: true }] },
    options: baseOptions({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmtFn(ctx.parsed.y) } } },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 4, font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: '#8b949e', font: { size: 9 }, callback: v => fmtFn(v), maxTicksLimit: 5 }, grid: { color: '#21262d' } }
      }
    })
  });
}
function renderVelocity() {
  const f = PTYPE_FIELDS[state.ptype];
  miniChart('velSold', null, f.sold, fmtInt, '#58a6ff');
  miniChart('velDom', null, f.dom, v => v == null ? 'N/A' : v.toFixed(0) + 'd', '#d29922');
  miniChart('velStl', null, f.stl, v => fmtPct(v), '#3fb950');
  miniChart('velAbove', null, f.above, v => fmtPct(v), '#a371f7');
  miniChart('velOff2wk', null, f.off2wk, v => fmtPct(v), '#f778ba');
  const s = metroSeries();
  document.getElementById('vintageVel').textContent =
    'Redfin Housing Market Tracker, monthly, San Jose-Sunnyvale-Santa Clara metro, ' +
    prettyMonth(s[0].date) + ' - ' + prettyMonth(s[s.length - 1].date) +
    (state.ptype !== 'all' ? ' · ' + DATA.metro.property_type_splits[state.ptype] : '');
}

/* ---------- rolling windows ---------- */
function renderRolling() {
  const wk = weeklySeries();
  const n = wk.length;
  const w7 = wk[n - 1];
  const w14 = wk.slice(n - 2).reduce((a, r) => a + (r.homes_sold || 0), 0);
  const w28 = wk.slice(n - 4).reduce((a, r) => a + (r.homes_sold || 0), 0);
  const w28prev = wk.slice(n - 8, n - 4).reduce((a, r) => a + (r.homes_sold || 0), 0);
  const chg28 = pctChange(w28, w28prev);

  const metro = metroSeries();
  const mLast = metro[metro.length - 1];
  const mPrev = metro[metro.length - 2];
  const chgM = pctChange(mLast.homes_sold, mPrev.homes_sold);

  const cards = [
    { label: 'Sold, last 7 days', value: fmtInt(w7.homes_sold), sub: 'week ending ' + prettyWeek(w7.week_ending) },
    { label: 'Sold, last 14 days', value: fmtInt(w14), sub: '2-week sum, metro' },
    { label: 'Sold, last 28 days', value: fmtInt(w28),
      sub: '<span class="' + dirClass(chg28) + '">' + fmtSignedPct(chg28) + '</span> vs prior 28d (' + fmtInt(w28prev) + ')' },
    { label: 'Sold, ' + prettyMonth(mLast.date), value: fmtInt(mLast.homes_sold),
      sub: '<span class="' + dirClass(chgM) + '">' + fmtSignedPct(chgM) + '</span> vs ' + prettyMonth(mPrev.date) }
  ];
  document.getElementById('rollGrid').innerHTML = cards.map(c =>
    '<div class="roll"><div class="r-label">' + c.label + '</div><div class="r-value">' + c.value +
    '</div><div class="r-sub">' + c.sub + '</div></div>'
  ).join('');
  document.getElementById('vintageRoll').textContent =
    'Rolling: Redfin weekly (4-week rolling), metro, through week ending ' + prettyWeek(w7.week_ending) +
    ' · Monthly: Redfin monthly, metro, through ' + prettyMonth(mLast.date);
}

/* ---------- seasonality ---------- */
function renderSeasonality() {
  killChart('seasChart');
  const months = DATA.seasonality.months;
  const labels = months.map(m => m.month_name.slice(0, 3));
  const scores = months.map(m => m.seller_score);
  const bg = scores.map(v => v >= 60 ? '#3fb950' : (v >= 45 ? '#d29922' : '#58a6ff'));
  charts.seasChart = new Chart(document.getElementById('seasChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Seller score', data: scores, backgroundColor: bg, borderRadius: 4 }] },
    options: baseOptions({
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const m = months[ctx.dataIndex];
              return [' Seller score: ' + m.seller_score.toFixed(0) + '/100',
                ' Avg sale-to-list: ' + fmtPct(m.avg_sale_to_list),
                ' Avg DOM: ' + m.avg_dom.toFixed(0) + 'd',
                ' Avg price cuts: ' + fmtPct(m.avg_price_drops_pct)];
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: '#8b949e' }, grid: { color: '#21262d' },
             title: { display: true, text: 'Seller score (0-100)', color: '#8b949e', font: { size: 11 } } }
      }
    })
  });
  document.getElementById('bestSell').innerHTML =
    DATA.seasonality.best_months_to_sell.map(m => '<li>' + m + '</li>').join('');
  document.getElementById('bestBuy').innerHTML =
    DATA.seasonality.best_months_to_buy.map(m => '<li>' + m + '</li>').join('');
  document.getElementById('vintageSeas').textContent =
    'Computed from Redfin monthly metro data, ' + DATA.seasonality.years_used.join('-') +
    ' averages. Seller score: higher = better for sellers (high sale-to-list, low DOM, low supply, few price drops).';
}

/* ---------- sentiment gauge ---------- */
function sentimentScore(row) {
  const parts = [];
  if (row.buyer_seller_ratio != null)
    parts.push({ label: 'Buyer/seller ratio (' + row.buyer_seller_ratio.toFixed(2) + ' sellers per buyer)',
                 v: clamp((1.5 - row.buyer_seller_ratio) / 1.0, 0, 1) });
  if (row.months_supply != null)
    parts.push({ label: 'Months of supply (' + row.months_supply.toFixed(1) + ')',
                 v: clamp((5 - row.months_supply) / 4, 0, 1) });
  if (row.sale_to_list != null)
    parts.push({ label: 'Sale-to-list (' + fmtPct(row.sale_to_list) + ')',
                 v: clamp((row.sale_to_list - 98) / 4, 0, 1) });
  if (row.price_drops_pct != null)
    parts.push({ label: 'Listings with price cuts (' + fmtPct(row.price_drops_pct) + ')',
                 v: clamp((25 - row.price_drops_pct) / 20, 0, 1) });
  const score = parts.length ? parts.reduce((a, p) => a + p.v, 0) / parts.length * 100 : null;
  return { score, parts };
}
function sentimentLabel(score) {
  if (score == null) return 'No data';
  if (score >= 65) return "Strong seller's market";
  if (score >= 55) return "Seller's market";
  if (score >= 45) return 'Balanced market';
  if (score >= 35) return "Buyer's market";
  return "Strong buyer's market";
}
function renderSentiment() {
  killChart('gaugeChart');
  const metro = metroSeries();
  const row = metro[metro.length - 1];
  const { score, parts } = sentimentScore(row);
  const safeScore = score == null ? 0 : score;
  const label = sentimentLabel(score);
  const color = score == null ? '#8b949e' : (score >= 55 ? '#3fb950' : (score >= 45 ? '#d29922' : '#58a6ff'));

  charts.gaugeChart = new Chart(document.getElementById('gaugeChart'), {
    type: 'doughnut',
    data: { datasets: [{
      data: [safeScore, 100 - safeScore],
      backgroundColor: [color, '#21262d'],
      borderWidth: 0, circumference: 180, rotation: -90
    }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      cutout: '70%' }
  });
  document.getElementById('gaugeLabel').innerHTML =
    '<span style="color:' + color + '">' + label + '</span><br><span style="font-size:0.85rem;color:#8b949e;font-weight:400">' +
    (score != null ? score.toFixed(0) + '/100' : 'N/A') + ' · ' + prettyMonth(row.date) + '</span>';
  document.getElementById('gaugeParts').innerHTML = parts.map(p =>
    '<div class="part"><span>' + p.label + '</span><span class="' +
    (p.v >= 0.55 ? 'up' : (p.v <= 0.45 ? 'down' : 'flat')) + '">' +
    (p.v >= 0.55 ? 'Seller-leaning' : (p.v <= 0.45 ? 'Buyer-leaning' : 'Neutral')) + '</span></div>'
  ).join('');
  document.getElementById('vintageSent').textContent =
    'Composite of Redfin monthly metro indicators, latest: ' + prettyMonth(row.date) +
    '. 0 = strong buyer, 100 = strong seller.';
}

/* ---------- rate correlation ---------- */
function renderCorrelation() {
  killChart('corrChart');
  const rm = rateMap();
  const metro = metroSeries();
  const metroByMonth = {};
  metro.forEach(r => { metroByMonth[monthKey(r.date)] = r; });

  const yrs = { '3Y': 3, '5Y': 5, '10Y': 10, 'MAX': 100 }[state.corrRange];
  const cutoff = new Date(DATA.rates.series[DATA.rates.series.length - 1][0]);
  cutoff.setFullYear(cutoff.getFullYear() - yrs);

  const zs = zipSeries();
  const zipByMonth = {};
  zs.forEach(([d, v], i) => { zipByMonth[monthKey(d)] = { v, i }; });

  const pts = [];
  Object.keys(rm).forEach(mk => {
    const d = new Date(mk + '-01');
    if (d < cutoff) return;
    const mrow = metroByMonth[mk];
    if (!mrow || mrow.homes_sold == null) return;
    let y, yLabel;
    if (state.corrMetric === 'sold') { y = mrow.homes_sold; yLabel = fmtInt(mrow.homes_sold) + ' sold'; }
    else {
      const z = zipByMonth[mk];
      if (!z || z.i < 12) return;
      const prev = zs[z.i - 12][1];
      if (!prev) return;
      y = (z.v - prev) / prev * 100; yLabel = fmtSignedPct(y) + ' YoY';
    }
    pts.push({ x: rm[mk], y, mk, yLabel });
  });
  pts.sort((a, b) => a.mk.localeCompare(b.mk));

  const r = pearson(pts.map(p => p.x), pts.map(p => p.y));
  // trend line
  let trend = [];
  if (r != null && pts.length > 2) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const icept = my - slope * mx;
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    trend = [{ x: x0, y: slope * x0 + icept }, { x: x1, y: slope * x1 + icept }];
  }

  charts.corrChart = new Chart(document.getElementById('corrChart'), {
    type: 'scatter',
    data: { datasets: [
      { label: state.corrMetric === 'sold' ? 'Monthly homes sold' : 'ZIP price YoY %',
        data: pts, backgroundColor: '#58a6ff88', borderColor: '#58a6ff', pointRadius: 3 },
      { label: 'Trend', data: trend, type: 'line', borderColor: '#f85149',
        borderDash: [6, 4], pointRadius: 0, borderWidth: 2, showLine: true }
    ]},
    options: baseOptions({
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx =>
          ctx.dataset.label === 'Trend' ? ' trend' :
          ' ' + prettyMonth(ctx.raw.mk + '-01') + ': ' + ctx.raw.x.toFixed(2) + '% rate, ' + ctx.raw.yLabel } }
      },
      scales: {
        x: { title: { display: true, text: '30-yr mortgage rate %', color: '#8b949e' },
             ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
        y: { title: { display: true, text: state.corrMetric === 'sold' ? 'Homes sold / month' : 'ZIP price YoY %', color: '#8b949e' },
             ticks: { color: '#8b949e', callback: v => state.corrMetric === 'sold' ? fmtInt(v) : v + '%' },
             grid: { color: '#21262d' } }
      }
    })
  });

  document.getElementById('corrStat').innerHTML =
    'Pearson r = <strong class="' + (r != null && r < 0 ? 'down' : 'up') + '">' +
    (r != null ? r.toFixed(3) : 'N/A') + '</strong> over ' + pts.length + ' months (' +
    (state.corrMetric === 'sold' ? 'rate vs homes sold' : 'rate vs ZIP price YoY') + '). ' +
    (r != null ? (Math.abs(r) >= 0.7 ? 'Strong' : Math.abs(r) >= 0.4 ? 'Moderate' : 'Weak') +
    (r < 0 ? ' negative' : ' positive') + ' relationship.' : '');
  const rl = DATA.rates.series.filter(x => x[1] != null);
  document.getElementById('vintageCorr').textContent =
    'Rate: FRED MORTGAGE30US, national monthly, through ' + prettyMonth(rl[rl.length - 1][0]) +
    ' · Sales: Redfin monthly, San Jose metro · Prices: Zillow ZHVI, ZIP ' + state.zip;
}

/* ---------- sources footer ---------- */
function renderSources() {
  const srcs = DATA.meta.sources;
  const names = {
    zips: 'Zillow ZHVI (ZIP home values)', metro: 'Redfin market tracker (monthly)',
    weekly: 'Redfin market tracker (weekly)', property_types: 'Redfin by property type',
    price_drops: 'Redfin price drops', balance_of_power: 'Redfin buyers vs sellers',
    rates: 'FRED 30-yr mortgage rate'
  };
  document.getElementById('sourceList').innerHTML = Object.keys(srcs).map(k =>
    '<li><strong>' + (names[k] || k) + ':</strong> <a href="' + srcs[k].url + '" target="_blank" rel="noopener">' +
    srcs[k].url + '</a> <span style="color:#8b949e">(accessed ' + srcs[k].accessed + ')</span></li>'
  ).join('');
}

/* ---------- controls & init ---------- */
function wireControls() {
  document.querySelectorAll('#priceRange button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#priceRange button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.priceRange = b.dataset.range; renderPriceChart();
  }));
  document.querySelectorAll('#priceMetric button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#priceMetric button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.priceMetric = b.dataset.metric; renderPriceChart();
  }));
  document.getElementById('rateOverlay').addEventListener('change', e => {
    state.rateOverlay = e.target.checked; renderPriceChart();
  });
  document.querySelectorAll('#ptypeToggle button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#ptypeToggle button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.ptype = b.dataset.ptype; renderVelocity();
  }));
  document.querySelectorAll('#corrRange button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#corrRange button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.corrRange = b.dataset.range; renderCorrelation();
  }));
  document.querySelectorAll('#corrMetric button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#corrMetric button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); state.corrMetric = b.dataset.corr; renderCorrelation();
  }));
  document.getElementById('addrBtn').addEventListener('click', onLookup);
  document.getElementById('addrInput').addEventListener('keydown', e => { if (e.key === 'Enter') onLookup(); });
}

function renderAll() {
  renderKpis();
  renderPriceChart();
  renderVelocity();
  renderRolling();
  renderSeasonality();
  renderSentiment();
  renderCorrelation();
}

(async function init() {
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
  try {
    await loadData();
  } catch (e) {
    document.body.innerHTML = '<div style="padding:40px;color:#f85149">Failed to load dashboard data: ' +
      e.message + '</div>';
    return;
  }
  setAreaLabel();
  wireControls();
  renderAll();
  renderSources();
})();
