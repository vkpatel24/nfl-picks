const TEAMS = {
  BUF: ['Bills', 'AFC', 'East'], MIA: ['Dolphins', 'AFC', 'East'], NE: ['Patriots', 'AFC', 'East'], NYJ: ['Jets', 'AFC', 'East'],
  BAL: ['Ravens', 'AFC', 'North'], CIN: ['Bengals', 'AFC', 'North'], CLE: ['Browns', 'AFC', 'North'], PIT: ['Steelers', 'AFC', 'North'],
  HOU: ['Texans', 'AFC', 'South'], IND: ['Colts', 'AFC', 'South'], JAX: ['Jaguars', 'AFC', 'South'], TEN: ['Titans', 'AFC', 'South'],
  DEN: ['Broncos', 'AFC', 'West'], KC: ['Chiefs', 'AFC', 'West'], LV: ['Raiders', 'AFC', 'West'], LAC: ['Chargers', 'AFC', 'West'],
  DAL: ['Cowboys', 'NFC', 'East'], NYG: ['Giants', 'NFC', 'East'], PHI: ['Eagles', 'NFC', 'East'], WSH: ['Commanders', 'NFC', 'East'],
  CHI: ['Bears', 'NFC', 'North'], DET: ['Lions', 'NFC', 'North'], GB: ['Packers', 'NFC', 'North'], MIN: ['Vikings', 'NFC', 'North'],
  ATL: ['Falcons', 'NFC', 'South'], CAR: ['Panthers', 'NFC', 'South'], NO: ['Saints', 'NFC', 'South'], TB: ['Buccaneers', 'NFC', 'South'],
  ARI: ['Cardinals', 'NFC', 'West'], LAR: ['Rams', 'NFC', 'West'], SF: ['49ers', 'NFC', 'West'], SEA: ['Seahawks', 'NFC', 'West'],
};
const ABBRS = Object.keys(TEAMS);
const CONFS = ['AFC', 'NFC'];
const DIVS = ['East', 'North', 'South', 'West'];
const name = t => TEAMS[t][0];
const conf = t => TEAMS[t][1];
const div = t => TEAMS[t][1] + ' ' + TEAMS[t][2];

const now = new Date();
const SEASON = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
const API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const POST_WEEKS = [1, 2, 3, 5]; // ESPN week 4 is the Pro Bowl

// ---------- storage ----------

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let games = load(`games-${SEASON}`, {});   // id -> game (regular + postseason)
let picks = load(`picks-${SEASON}`, {});   // regular season: game id -> winner
let ppicks = load(`ppicks-${SEASON}`, {}); // playoffs: "round:A-B" -> winner
let selected = load('selected', 'BUF');
let tab = load('tab', 'season');
let mode = load('mode', 'mine');            // whose picks fill the board: 'mine' | 'market'
let showOdds = load('showOdds', false);
let lines = load(`lines-${SEASON}`, {});    // game id -> home win prob from that game's Polymarket market
let updatedAt = null, oddsAt = null, oddsErr = false;

// ---------- data ----------

function parseEvent(e, type, week) {
  const c = e.competitions[0];
  const home = c.competitors.find(x => x.homeAway === 'home');
  const away = c.competitors.find(x => x.homeAway === 'away');
  const h = home.team.abbreviation, a = away.team.abbreviation;
  if (!TEAMS[h] || !TEAMS[a]) return null;
  const st = e.status.type;
  const final = st.completed;
  let winner = null;
  if (final) winner = home.winner ? h : away.winner ? a : 'TIE';
  return {
    id: e.id, type, week, date: e.date, home: h, away: a, neutral: !!c.neutralSite,
    state: st.state, final, winner,
    hs: +home.score || 0, as: +away.score || 0,
    detail: st.shortDetail,
  };
}

async function fetchWeek(type, week) {
  const res = await fetch(`${API}?dates=${SEASON}&seasontype=${type}&week=${week}`);
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  for (const id of Object.keys(games)) {
    if (games[id].type === type && games[id].week === week) delete games[id];
  }
  for (const e of data.events || []) {
    const g = parseEvent(e, type, week);
    if (g) games[g.id] = g;
  }
}

async function refresh(weeks) {
  try {
    await Promise.all(weeks.map(([t, w]) => fetchWeek(t, w)));
    save(`games-${SEASON}`, games);
    updatedAt = new Date();
  } catch (err) {
    console.error(err);
  }
  render();
}

const allWeeks = () => [
  ...Array.from({ length: 18 }, (_, i) => [2, i + 1]),
  ...POST_WEEKS.map(w => [3, w]),
];

// Weeks with a game that has kicked off but isn't final.
function activeWeeks() {
  const t = Date.now(), set = new Set();
  for (const g of Object.values(games)) {
    if (!g.final && new Date(g.date).getTime() <= t) set.add(g.type + ':' + g.week);
  }
  return [...set].map(k => k.split(':').map(Number));
}

let lastFull = Date.now();
function poll() {
  if (Date.now() - lastFull > 30 * 60 * 1000) {
    lastFull = Date.now();
    refresh(allWeeks());
  } else {
    const weeks = activeWeeks();
    if (weeks.length) refresh(weeks);
  }
  if (Date.now() - lastOdds > 5 * 60 * 1000) refreshOdds();
}

// ---------- odds (Polymarket) ----------

const GAMMA = 'https://gamma-api.polymarket.com';
const pmAbbr = t => ({ LAR: 'la', WSH: 'was' })[t] || t.toLowerCase();
const ymd = (d, timeZone) => new Date(d).toLocaleDateString('en-CA', { timeZone });

// Game markets are slugged nfl-{away}-{home}-{date}; only ~3 weeks out are listed.
async function fetchLines() {
  const want = {};
  for (const g of Object.values(games)) {
    if (g.final) continue;
    for (const tz of ['UTC', 'America/New_York']) want[`nfl-${pmAbbr(g.away)}-${pmAbbr(g.home)}-${ymd(g.date, tz)}`] = g;
  }
  const slugs = Object.keys(want), out = {};
  const chunks = [];
  for (let i = 0; i < slugs.length; i += 40) chunks.push(slugs.slice(i, i + 40));
  await Promise.all(chunks.map(async chunk => {
    const res = await fetch(`${GAMMA}/markets?limit=100&${chunk.map(s => 'slug=' + s).join('&')}`);
    if (!res.ok) throw new Error(res.status);
    for (const m of await res.json()) {
      const g = want[m.slug];
      if (!g || !m.outcomePrices) continue;
      const i = JSON.parse(m.outcomes).indexOf(name(g.home));
      if (i >= 0) out[g.id] = +JSON.parse(m.outcomePrices)[i];
    }
  }));
  return out;
}

let lastOdds = 0;
async function refreshOdds() {
  if (!Object.keys(games).length) return;
  lastOdds = Date.now();
  try {
    lines = await fetchLines();
    save(`lines-${SEASON}`, lines);
    oddsAt = new Date(); oddsErr = false;
  } catch (err) {
    console.error(err);
    oddsErr = true;
  }
  render();
}

// ---------- Elo fallback ----------

// Games without a Polymarket market use FiveThirtyEight's open-source NFL Elo:
// last season's results seed the ratings (regressed 1/3 toward 1505), then this season's.
const HFA = 48, K = 20;
let history = load(`history-${SEASON - 1}`, null); // last season's finals: [date, home, away, hs, as, neutral]

async function fetchHistory() {
  if (history) return;
  try {
    const weeks = await Promise.all(allWeeks().map(async ([type, week]) => {
      const res = await fetch(`${API}?dates=${SEASON - 1}&seasontype=${type}&week=${week}`);
      if (!res.ok) throw new Error(res.status);
      return (await res.json()).events || [];
    }));
    history = weeks.flat().map(e => parseEvent(e, 0, 0)).filter(g => g && g.final)
      .map(g => [g.date, g.home, g.away, g.hs, g.as, g.neutral]);
    save(`history-${SEASON - 1}`, history);
    render();
  } catch (err) {
    console.error(err);
  }
}

const eloP = diff => 1 / (1 + 10 ** (-diff / 400));

let eloCache = { key: null, elo: null };
function ratings() {
  const done = Object.values(games).filter(g => g.final && g.winner)
    .map(g => [g.date, g.home, g.away, g.hs, g.as, g.neutral]);
  const key = (history?.length || 0) + ':' + done.length;
  if (eloCache.key === key) return eloCache.elo;
  const elo = Object.fromEntries(ABBRS.map(t => [t, 1505]));
  const play = list => {
    for (const [, h, a, hs, as, neutral] of [...list].sort((x, y) => x[0] < y[0] ? -1 : 1)) {
      const diff = elo[h] - elo[a] + (neutral ? 0 : HFA);
      const res = hs > as ? 1 : hs < as ? 0 : 0.5;
      const winDiff = res === 0 ? -diff : diff;
      const mult = Math.log(Math.abs(hs - as) + 1) * 2.2 / (winDiff * 0.001 + 2.2);
      const shift = K * mult * (res - eloP(diff));
      elo[h] += shift; elo[a] -= shift;
    }
  };
  if (history) {
    play(history);
    for (const t of ABBRS) elo[t] = elo[t] * 2 / 3 + 1505 / 3;
  }
  play(done);
  eloCache = { key, elo };
  return elo;
}

// Chance t beats opp, from the game's own market when there is one, else Elo.
// home is null at a neutral site.
function winChance(t, opp, g, home, playoff = g?.type === 3) {
  if (g && lines[g.id] != null) return { p: g.home === t ? lines[g.id] : 1 - lines[g.id], est: false };
  const elo = ratings();
  let diff = elo[t] - elo[opp] + (home === t ? HFA : home === opp ? -HFA : 0);
  if (playoff) diff *= 1.2;
  return { p: eloP(diff), est: true };
}

const gameChance = (g, t) => winChance(t, t === g.home ? g.away : g.home, g, g.neutral ? null : g.home);

function marketPick(g) {
  const c = gameChance(g, g.home);
  return c ? (c.p >= 0.5 ? g.home : g.away) : null;
}

// ---------- standings ----------

const regular = () => Object.values(games).filter(g => g.type === 2);

function outcome(g, view = mode) {
  if (g.final) return g.winner;
  return view === 'market' ? marketPick(g) : picks[g.id] || null;
}

function buildRecords(view) {
  const R = {};
  for (const t of ABBRS) R[t] = { results: [], opps: [] };
  for (const g of regular()) {
    R[g.home].opps.push(g.away);
    R[g.away].opps.push(g.home);
    const o = outcome(g, view);
    if (!o) continue;
    for (const [t, opp] of [[g.home, g.away], [g.away, g.home]]) {
      R[t].results.push({ opp, r: o === 'TIE' ? 0.5 : o === t ? 1 : 0 });
    }
  }
  for (const t of ABBRS) {
    const rs = R[t].results;
    R[t].w = rs.filter(x => x.r === 1).length;
    R[t].l = rs.filter(x => x.r === 0).length;
    R[t].t = rs.filter(x => x.r === 0.5).length;
    R[t].pct = pctOf(rs);
  }
  return R;
}

const pctOf = rs => rs.length ? rs.reduce((s, x) => s + x.r, 0) / rs.length : 0;
const recStr = r => `${r.w}-${r.l}${r.t ? '-' + r.t : ''}`;

function combinedPct(R, teams) {
  let w = 0, n = 0;
  for (const t of teams) { w += R[t].w + R[t].t / 2; n += R[t].w + R[t].l + R[t].t; }
  return n ? w / n : 0;
}

// Tiebreak steps. Each returns a number per team (higher is better) or null to skip.
const step = {
  h2h: (R, set) => t => pctOf(R[t].results.filter(x => set.includes(x.opp) && x.opp !== t)),
  sweep: (R, set) => t => {
    const others = set.filter(o => o !== t);
    const vs = o => R[t].results.filter(x => x.opp === o);
    if (others.every(o => vs(o).length && vs(o).every(x => x.r === 1))) return 1;
    if (others.every(o => vs(o).length && vs(o).every(x => x.r === 0))) return -1;
    return 0;
  },
  div: R => t => pctOf(R[t].results.filter(x => div(x.opp) === div(t))),
  conf: R => t => pctOf(R[t].results.filter(x => conf(x.opp) === conf(t))),
  common: (R, set, min = 0) => {
    const common = ABBRS.filter(o => !set.includes(o) && set.every(t => R[t].opps.includes(o)));
    const games = t => R[t].results.filter(x => common.includes(x.opp));
    if (set.some(t => games(t).length < min)) return null;
    return t => pctOf(games(t));
  },
  sov: R => t => combinedPct(R, R[t].results.filter(x => x.r === 1).map(x => x.opp)),
  sos: R => t => combinedPct(R, R[t].opps),
};

function breakTie(R, set, stepsFor) {
  let cur = [...set];
  while (cur.length > 1) {
    let reduced = false;
    for (const make of stepsFor(cur)) {
      const fn = make(R, cur);
      if (!fn) continue;
      const vals = cur.map(fn);
      const best = Math.max(...vals);
      const next = cur.filter((_, i) => vals[i] > best - 1e-9);
      if (next.length < cur.length) { cur = next; reduced = true; break; }
    }
    if (!reduced) return cur.sort()[0]; // coin toss
  }
  return cur[0];
}

const divSteps = () => [step.h2h, step.div, step.common, step.conf, step.sov, step.sos];
const wcSteps = set => [
  set.length === 2 ? step.h2h : step.sweep,
  step.conf,
  (R, s) => step.common(R, s, 4),
  step.sov, step.sos,
];

// Rank teams by pct, breaking ties with the given procedure.
function rank(R, teams, tiebreak) {
  const left = [...teams], out = [];
  while (left.length) {
    const best = Math.max(...left.map(t => R[t].pct));
    const tied = left.filter(t => R[t].pct > best - 1e-9);
    const pick = tied.length === 1 ? tied[0] : tiebreak(tied);
    out.push(pick);
    left.splice(left.indexOf(pick), 1);
  }
  return out;
}

function standings(view = mode) {
  const R = buildRecords(view);
  const divisions = {};
  for (const c of CONFS) for (const d of DIVS) {
    const key = c + ' ' + d;
    divisions[key] = rank(R, ABBRS.filter(t => div(t) === key), tied => breakTie(R, tied, divSteps));
  }
  // Wild card ties: only the top-ranked tied team from each division is eligible at each pass.
  const wcBreak = tied => {
    const reps = [...new Set(tied.map(div))].map(d => divisions[d].find(t => tied.includes(t)));
    return reps.length === 1 ? reps[0] : breakTie(R, reps, wcSteps);
  };
  const seeds = {};
  for (const c of CONFS) {
    const winners = DIVS.map(d => divisions[c + ' ' + d][0]);
    const rest = ABBRS.filter(t => conf(t) === c && !winners.includes(t));
    seeds[c] = [...rank(R, winners, wcBreak), ...rank(R, rest, wcBreak)];
  }
  return { R, divisions, seeds };
}

// ---------- playoffs ----------

function postGame(round, a, b) {
  return Object.values(games).find(g => g.type === 3 && g.week === round &&
    ((g.home === a && g.away === b) || (g.home === b && g.away === a)));
}

const pkey = (round, a, b) => `${round}:${[a, b].sort().join('-')}`;

// a hosts unless it's the Super Bowl.
function matchup(round, a, b, view) {
  if (!a || !b) return { round, a, b, winner: null };
  const g = postGame(round, a, b);
  const home = g ? (g.neutral ? null : g.home) : round === 5 ? null : a;
  const c = winChance(a, b, g, home, true);
  const chance = { [a]: c, [b]: { p: 1 - c.p, est: c.est } };
  if (g && g.final) return { round, a, b, g, chance, winner: g.winner, locked: true };
  const winner = view === 'market' ? (c.p >= 0.5 ? a : b) : ppicks[pkey(round, a, b)] || null;
  return { round, a, b, g, chance, winner };
}

function bracket(seeds, view = mode) {
  const matchup_ = (round, a, b) => matchup(round, a, b, view);
  const out = {};
  for (const c of CONFS) {
    const s = seeds[c].slice(0, 7);
    const seed = t => s.indexOf(t) + 1;
    const wc = [[1, 6], [2, 5], [3, 4]].map(([i, j]) => matchup_(1, s[i], s[j]));
    let dv;
    const wcw = wc.map(m => m.winner);
    if (wcw.every(Boolean)) {
      const left = wcw.sort((x, y) => seed(x) - seed(y));
      dv = [matchup_(2, s[0], left[2]), matchup_(2, left[0], left[1])];
    } else {
      dv = [matchup_(2, s[0], null), matchup_(2, null, null)];
    }
    const ccTeams = [dv[0].winner, dv[1].winner];
    if (ccTeams.every(Boolean)) ccTeams.sort((x, y) => seed(x) - seed(y));
    const cc = matchup_(3, ...ccTeams);
    out[c] = { s, seed, wc, dv, cc };
  }
  out.sb = matchup_(5, out.AFC.cc.winner, out.NFC.cc.winner);
  return out;
}

// ---------- render ----------

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function logo(t) {
  const src = v => `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/${v}/${t.toLowerCase()}.png&h=56&w=56`;
  return `<picture><source srcset="${src('500-dark')}" media="(prefers-color-scheme: dark)"><img class="logo" src="${src('500')}" alt=""></picture>`;
}

const fmtDate = d => new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const ODDS_TIP = {
  false: 'Polymarket game line',
  true: 'No Polymarket line yet — FiveThirtyEight-style Elo estimate',
};

// "63%" for a { p, est } chance; Elo estimates get a "~".
function oddsTag(c) {
  if (!c) return '';
  const pct = Math.round(c.p * 100);
  return `<span class="odds ${c.p >= 0.5 ? 'fav' : 'dog'} ${c.est ? 'est' : ''}" title="${ODDS_TIP[c.est]}">${c.est ? '~' : ''}${pct}%</span>`;
}

function renderStatus() {
  const live = Object.values(games).filter(g => g.state === 'in').length;
  const left = regular().filter(g => !outcome(g, 'mine')).length;
  const parts = [];
  if (live) parts.push(`<b class="live">${live} live</b>`);
  if (mode === 'mine' && left && tab !== 'report') parts.push(`${left} unpicked`);
  if (oddsErr) parts.push('Polymarket unavailable');
  if (updatedAt) parts.push(`Updated ${updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  $('#status').innerHTML = parts.join(' · ');
}

function renderDivisions({ R, divisions, seeds }) {
  const seedOf = t => { const i = seeds[conf(t)].indexOf(t); return i < 7 ? i + 1 : ''; };
  $('#divisions').innerHTML = CONFS.map(c => `
    <div class="conf">
      ${DIVS.map(d => `
        <table class="div">
          <thead><tr><th colspan="3">${c} ${d}</th></tr></thead>
          <tbody>
            ${divisions[c + ' ' + d].map(t => `
              <tr data-team="${t}" class="${t === selected ? 'sel' : ''}">
                <td class="team">${logo(t)}${name(t)}</td>
                <td class="seed">${seedOf(t)}</td>
                <td class="rec">${recStr(R[t])}</td>
              </tr>`).join('')}
          </tbody>
        </table>`).join('')}
    </div>`).join('');
}

function renderSchedule({ R }) {
  const t = selected;
  if (!regular().length) {
    $('#schedule').innerHTML = `<div class="head">${logo(t)}<h2>${name(t)}</h2></div><p class="empty">Loading schedule…</p>`;
    return;
  }
  const market = mode === 'market';
  const list = regular().filter(g => g.home === t || g.away === t).sort((a, b) => a.week - b.week);
  const byWeek = Object.fromEntries(list.map(g => [g.week, g]));
  const maxWeek = Math.max(18, ...list.map(g => g.week));
  const rows = [];
  for (let w = 1; w <= maxWeek; w++) {
    const g = byWeek[w];
    if (!g) { rows.push(`<tr class="bye"><td class="wk">${w}</td><td colspan="${showOdds ? 4 : 3}">Bye</td></tr>`); continue; }
    const home = g.home === t, opp = home ? g.away : g.home;
    const pick = market ? (g.final ? null : marketPick(g)) : picks[g.id];
    const mine = pick ? (pick === t ? 'W' : 'L') : null;
    let right;
    if (g.final) {
      const res = g.winner === 'TIE' ? 'T' : g.winner === t ? 'W' : 'L';
      const score = home ? `${g.hs}-${g.as}` : `${g.as}-${g.hs}`;
      const mark = mine ? (mine === res ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') : '';
      right = `<span class="res ${res}">${res}</span> <span class="score">${score}</span>${mark}`;
    } else {
      const dis = market ? 'disabled' : '';
      right = `<span class="pick ${market ? 'locked' : ''}" data-game="${g.id}">
        <button ${dis} data-v="${t}" class="${mine === 'W' ? 'on W' : ''}">W</button><button ${dis} data-v="" class="${!mine ? 'on' : ''}">–</button><button ${dis} data-v="${opp}" class="${mine === 'L' ? 'on L' : ''}">L</button>
      </span>`;
    }
    const when = g.state === 'in'
      ? `<span class="live">${home ? g.hs + '-' + g.as : g.as + '-' + g.hs} · ${esc(g.detail)}</span>`
      : fmtDate(g.date);
    rows.push(`<tr>
      <td class="wk">${w}</td>
      <td class="opp" data-team="${opp}"><span class="at">${home ? 'vs' : '@'}</span>${logo(opp)}${name(opp)}</td>
      <td class="when">${when}</td>
      ${showOdds ? `<td class="pct">${g.final ? '' : oddsTag(gameChance(g, t))}</td>` : ''}
      <td class="right">${right}</td>
    </tr>`);
  }
  $('#schedule').innerHTML = `
    <div class="head">${logo(t)}<h2>${name(t)}</h2>${market ? '<span class="chip">Polymarket picks</span>' : ''}<span class="rec">${recStr(R[t])}</span></div>
    <table class="sched"><tbody>${rows.join('')}</tbody></table>`;
}

function teamRow(m, t, b) {
  if (!t) return `<div class="slot tbd">TBD</div>`;
  const g = m.g, cls = m.winner ? (m.winner === t ? 'won' : 'lost') : '';
  let score = '';
  if (g && (g.final || g.state === 'in')) score = `<span class="score">${g.home === t ? g.hs : g.as}</span>`;
  else if (showOdds && m.chance) score = oddsTag(m.chance[t]);
  const clickable = m.a && m.b && !m.locked && mode === 'mine';
  return `<div class="slot ${cls} ${clickable ? 'click' : ''}" ${clickable ? `data-key="${pkey(m.round, m.a, m.b)}" data-v="${t}"` : ''}>
    <span class="sd">${b.seed(t) || ''}</span>${logo(t)}<span class="nm">${name(t)}</span>${score}
  </div>`;
}

function game(m, b, label) {
  const live = m.g && m.g.state === 'in' ? `<div class="glabel live">${esc(m.g.detail)}</div>` : label ? `<div class="glabel">${label}</div>` : '';
  return `<div class="game">${live}${teamRow(m, m.a, b)}${teamRow(m, m.b, b)}</div>`;
}

function roman(n) {
  return [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
    .reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
}

function renderPlayoffs({ seeds }) {
  const b = bracket(seeds);
  const confBlock = c => {
    const x = b[c];
    const round = (title, ms) => `<div class="round"><h3>${c} ${title}</h3><div class="games">${ms.map(m => game(m, x)).join('')}</div></div>`;
    return `<div class="pconf ${c}">
      ${round('Wild Card', x.wc)}${round('Divisional', x.dv)}${round('Championship', [x.cc])}
    </div>`;
  };
  const sbSeed = { seed: t => b[conf(t)].seed(t) };
  const champ = b.sb.winner && b.sb.winner !== 'TIE'
    ? `<div class="sb-champ">${logo(b.sb.winner)}<span>Champion</span><b>${name(b.sb.winner)}</b></div>` : '';
  $('#playoffs').innerHTML = `
    <div class="bracket">
      ${confBlock('AFC')}
      <div class="round sb"><h3>Super Bowl ${roman(SEASON - 1965)}</h3><div class="games"><div class="sb-game">${game(b.sb, sbSeed)}${champ}</div></div></div>
      ${confBlock('NFC')}
    </div>`;
}

// ---------- disagreements ----------

const ROUND = { 1: 'Wild Card', 2: 'Divisional', 3: 'Conf. Champ.', 5: 'Super Bowl' };
const teamTag = t => t ? `<span class="tm">${logo(t)}${name(t)}</span>` : '<span class="tm muted">—</span>';

function renderReport() {
  const me = standings('mine'), mk = standings('market');
  const myB = bracket(me.seeds, 'mine'), mkB = bracket(mk.seeds, 'market');

  // Every unplayed game you picked, with the market's chance for your side.
  const picked = [];
  for (const g of regular()) {
    const p = picks[g.id];
    if (g.final || !p) continue;
    picked.push({ when: 'Wk ' + g.week, order: g.week, pick: p, opp: p === g.home ? g.away : g.home, at: p === g.away, c: gameChance(g, p) });
  }
  for (const c of CONFS) for (const m of [...myB[c].wc, ...myB[c].dv, myB[c].cc]) {
    if (m.winner && !m.locked) picked.push({ when: c + ' ' + ROUND[m.round], order: 100 + m.round, pick: m.winner, opp: m.winner === m.a ? m.b : m.a, at: m.winner === m.b, c: m.chance[m.winner] });
  }
  if (myB.sb.winner && !myB.sb.locked) {
    const m = myB.sb;
    picked.push({ when: 'Super Bowl', order: 105, pick: m.winner, opp: m.winner === m.a ? m.b : m.a, neutral: true, c: m.chance[m.winner] });
  }
  const against = picked.filter(x => x.c.p < 0.5).sort((x, y) => x.c.p - y.c.p);

  const gameRows = against.map(x => `
    <tr>
      <td class="wk">${x.when}</td>
      <td>${teamTag(x.pick)}<span class="vs">${x.neutral ? 'vs' : x.at ? '@' : 'vs'}</span>${teamTag(x.opp)}</td>
      <td class="bar"><span class="meter"><i style="width:${Math.round(x.c.p * 100)}%"></i></span>${oddsTag(x.c)}</td>
    </tr>`).join('');

  // Teams you're higher or lower on, over the games you picked.
  const swing = {};
  for (const g of regular()) {
    const p = picks[g.id];
    if (g.final || !p) continue;
    const mp = marketPick(g);
    for (const t of [g.home, g.away]) {
      swing[t] ??= { me: 0, mk: 0, n: 0 };
      swing[t].n++;
      if (p === t) swing[t].me++;
      if (mp === t) swing[t].mk++;
    }
  }
  const teams = Object.entries(swing).map(([t, s]) => ({ t, ...s, d: s.me - s.mk }))
    .filter(x => x.d).sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || y.d - x.d).slice(0, 10);
  const teamRows = teams.map(x => `
    <tr>
      <td>${teamTag(x.t)}</td>
      <td class="num">${x.me}-${x.n - x.me}</td>
      <td class="num">${x.mk}-${x.n - x.mk}</td>
      <td class="num ${x.d > 0 ? 'up' : 'down'}">${x.d > 0 ? '+' : ''}${x.d}</td>
    </tr>`).join('');

  const divRows = CONFS.flatMap(c => DIVS.map(d => c + ' ' + d))
    .filter(k => me.divisions[k][0] !== mk.divisions[k][0])
    .map(k => `<tr><td class="wk">${k}</td><td>${teamTag(me.divisions[k][0])}</td><td>${teamTag(mk.divisions[k][0])}</td></tr>`).join('');

  const field = CONFS.map(c => {
    const a = me.seeds[c].slice(0, 7), b = mk.seeds[c].slice(0, 7);
    const onlyMe = a.filter(t => !b.includes(t)), onlyMk = b.filter(t => !a.includes(t));
    if (!onlyMe.length) return '';
    return `<tr><td class="wk">${c}</td><td>${onlyMe.map(teamTag).join('')}</td><td>${onlyMk.map(teamTag).join('')}</td></tr>`;
  }).join('');

  const unpicked = regular().filter(g => !g.final && !picks[g.id]).length;
  const agree = picked.length - against.length;

  $('#report').innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${picked.length ? Math.round(agree / picked.length * 100) + '%' : '—'}</b><span>of your picks match Polymarket (${agree} of ${picked.length})</span></div>
      <div class="tile"><b>${against.length}</b><span>picks against the favorite</span></div>
      <div class="tile champ"><span>Your champion</span>${teamTag(myB.sb.winner)}<span>Polymarket's</span>${teamTag(mkB.sb.winner)}</div>
    </div>
    ${unpicked ? `<p class="note">${unpicked} regular-season games still unpicked, so your standings and bracket are incomplete.</p>` : ''}
    <div class="cols">
      <div class="card">
        <h3>Biggest disagreements</h3>
        ${gameRows ? `<table class="rep"><thead><tr><th></th><th>Your pick</th><th>Polymarket gives them</th></tr></thead><tbody>${gameRows}</tbody></table>`
          : `<p class="empty">${picked.length ? 'You’re with the favorite on every pick.' : 'Make some picks under My Picks to compare.'}</p>`}
      </div>
      <div class="side">
        <div class="card">
          <h3>Division winners</h3>
          ${divRows ? `<table class="rep"><thead><tr><th></th><th>You</th><th>Polymarket</th></tr></thead><tbody>${divRows}</tbody></table>` : '<p class="empty">Same eight division winners.</p>'}
        </div>
        <div class="card">
          <h3>Playoff field</h3>
          ${field ? `<table class="rep"><thead><tr><th></th><th>Only you have in</th><th>Only Polymarket has in</th></tr></thead><tbody>${field}</tbody></table>` : '<p class="empty">Same 14 playoff teams.</p>'}
        </div>
        <div class="card">
          <h3>Higher / lower than the market</h3>
          ${teamRows ? `<table class="rep"><thead><tr><th>In games you picked</th><th class="num">You</th><th class="num">PM</th><th class="num">±</th></tr></thead><tbody>${teamRows}</tbody></table>` : '<p class="empty">No differences yet.</p>'}
        </div>
      </div>
    </div>
    <p class="note">Percentages come from each game’s Polymarket line (listed about three weeks out). Further-out games and hypothetical playoff matchups marked “~” use an open-source Elo model (FiveThirtyEight’s NFL method) built from last season and this season’s results.</p>`;
}

function render() {
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('on', el.dataset.tab === tab);
  for (const el of document.querySelectorAll('[data-mode]')) el.classList.toggle('on', el.dataset.mode === mode);
  $('#odds-toggle').checked = showOdds;
  $('#filters').hidden = tab === 'report';
  document.body.classList.toggle('market', mode === 'market');
  for (const id of ['season', 'playoffs', 'report']) $('#' + id).hidden = tab !== id;
  renderStatus();
  if (tab === 'report') { renderReport(); return; }
  const st = standings();
  if (tab === 'season') { renderDivisions(st); renderSchedule(st); }
  else renderPlayoffs(st);
}

// ---------- events ----------

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) { tab = tabBtn.dataset.tab; save('tab', tab); render(); return; }

  const modeBtn = e.target.closest('[data-mode]');
  if (modeBtn) { mode = modeBtn.dataset.mode; save('mode', mode); render(); return; }

  const pickBtn = e.target.closest('.pick button');
  if (pickBtn) {
    if (mode !== 'mine') return;
    const id = pickBtn.parentElement.dataset.game;
    if (pickBtn.dataset.v) picks[id] = pickBtn.dataset.v; else delete picks[id];
    save(`picks-${SEASON}`, picks);
    render();
    return;
  }

  const slot = e.target.closest('.slot.click');
  if (slot) {
    const k = slot.dataset.key;
    if (ppicks[k] === slot.dataset.v) delete ppicks[k]; else ppicks[k] = slot.dataset.v;
    save(`ppicks-${SEASON}`, ppicks);
    render();
    return;
  }

  const team = e.target.closest('[data-team]');
  if (team) {
    selected = team.dataset.team;
    save('selected', selected);
    render();
    if (window.innerWidth < 900 && team.closest('#divisions')) $('#schedule').scrollIntoView({ behavior: 'smooth' });
  }
});

$('#odds-toggle').addEventListener('change', e => { showOdds = e.target.checked; save('showOdds', showOdds); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
// When served by serve.py (the desktop launcher), hold a connection open so the
// server can shut itself down after the last tab closes.
if (location.port === '8765') new EventSource('/alive');

render();
refresh(allWeeks()).then(refreshOdds);
fetchHistory();
setInterval(poll, 60 * 1000);
