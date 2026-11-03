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
let updatedAt = null;

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
    id: e.id, type, week, date: e.date, home: h, away: a,
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
}

// ---------- standings ----------

const regular = () => Object.values(games).filter(g => g.type === 2);

function outcome(g) {
  if (g.final) return g.winner;
  return picks[g.id] || null;
}

function buildRecords() {
  const R = {};
  for (const t of ABBRS) R[t] = { results: [], opps: [] };
  for (const g of regular()) {
    R[g.home].opps.push(g.away);
    R[g.away].opps.push(g.home);
    const o = outcome(g);
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

function standings() {
  const R = buildRecords();
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

function matchup(round, a, b) {
  if (!a || !b) return { round, a, b, winner: null };
  const g = postGame(round, a, b);
  if (g && g.final) return { round, a, b, g, winner: g.winner, locked: true };
  return { round, a, b, g, winner: ppicks[pkey(round, a, b)] || null };
}

function bracket(seeds) {
  const out = {};
  for (const c of CONFS) {
    const s = seeds[c].slice(0, 7);
    const seed = t => s.indexOf(t) + 1;
    const wc = [[1, 6], [2, 5], [3, 4]].map(([i, j]) => matchup(1, s[i], s[j]));
    let dv;
    const wcw = wc.map(m => m.winner);
    if (wcw.every(Boolean)) {
      const left = wcw.sort((x, y) => seed(x) - seed(y));
      dv = [matchup(2, s[0], left[2]), matchup(2, left[0], left[1])];
    } else {
      dv = [matchup(2, s[0], null), matchup(2, null, null)];
    }
    const cc = matchup(3, dv[0].winner, dv[1].winner);
    out[c] = { s, seed, wc, dv, cc };
  }
  out.sb = matchup(5, out.AFC.cc.winner, out.NFC.cc.winner);
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

function renderStatus() {
  const live = Object.values(games).filter(g => g.state === 'in').length;
  const left = regular().filter(g => !outcome(g)).length;
  const parts = [];
  if (live) parts.push(`<b class="live">${live} live</b>`);
  if (left) parts.push(`${left} unpicked`);
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
  const list = regular().filter(g => g.home === t || g.away === t).sort((a, b) => a.week - b.week);
  const byWeek = Object.fromEntries(list.map(g => [g.week, g]));
  const maxWeek = Math.max(18, ...list.map(g => g.week));
  const rows = [];
  for (let w = 1; w <= maxWeek; w++) {
    const g = byWeek[w];
    if (!g) { rows.push(`<tr class="bye"><td class="wk">${w}</td><td colspan="3">Bye</td></tr>`); continue; }
    const home = g.home === t, opp = home ? g.away : g.home;
    const pick = picks[g.id];
    const mine = pick ? (pick === t ? 'W' : 'L') : null;
    let right;
    if (g.final) {
      const res = g.winner === 'TIE' ? 'T' : g.winner === t ? 'W' : 'L';
      const score = home ? `${g.hs}-${g.as}` : `${g.as}-${g.hs}`;
      const mark = mine ? (mine === res ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') : '';
      right = `<span class="res ${res}">${res}</span> <span class="score">${score}</span>${mark}`;
    } else {
      right = `<span class="pick" data-game="${g.id}">
        <button data-v="${t}" class="${mine === 'W' ? 'on W' : ''}">W</button><button data-v="" class="${!mine ? 'on' : ''}">–</button><button data-v="${opp}" class="${mine === 'L' ? 'on L' : ''}">L</button>
      </span>`;
    }
    const when = g.state === 'in'
      ? `<span class="live">${home ? g.hs + '-' + g.as : g.as + '-' + g.hs} · ${esc(g.detail)}</span>`
      : fmtDate(g.date);
    rows.push(`<tr>
      <td class="wk">${w}</td>
      <td class="opp" data-team="${opp}"><span class="at">${home ? 'vs' : '@'}</span>${logo(opp)}${name(opp)}</td>
      <td class="when">${when}</td>
      <td class="right">${right}</td>
    </tr>`);
  }
  $('#schedule').innerHTML = `
    <div class="head">${logo(t)}<h2>${name(t)}</h2><span class="rec">${recStr(R[t])}</span></div>
    <table class="sched"><tbody>${rows.join('')}</tbody></table>`;
}

function teamRow(m, t, b) {
  if (!t) return `<div class="slot tbd">TBD</div>`;
  const g = m.g, cls = m.winner ? (m.winner === t ? 'won' : 'lost') : '';
  let score = '';
  if (g && (g.final || g.state === 'in')) score = `<span class="score">${g.home === t ? g.hs : g.as}</span>`;
  const clickable = m.a && m.b && !m.locked;
  return `<div class="slot ${cls} ${clickable ? 'click' : ''}" ${clickable ? `data-key="${pkey(m.round, m.a, m.b)}" data-v="${t}"` : ''}>
    <span class="sd">${b.seed(t) || ''}</span>${logo(t)}<span class="nm">${name(t)}</span>${score}
  </div>`;
}

function game(m, b, label) {
  const live = m.g && m.g.state === 'in' ? `<div class="glabel live">${esc(m.g.detail)}</div>` : label ? `<div class="glabel">${label}</div>` : '';
  return `<div class="game">${live}${teamRow(m, m.a, b)}${teamRow(m, m.b, b)}</div>`;
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
  $('#playoffs').innerHTML = `
    <div class="bracket">
      ${confBlock('AFC')}
      <div class="round sb"><h3>Super Bowl</h3><div class="games">${game(b.sb, sbSeed)}</div></div>
      ${confBlock('NFC')}
    </div>`;
}

function render() {
  const st = standings();
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('on', el.dataset.tab === tab);
  $('#season').hidden = tab !== 'season';
  $('#playoffs').hidden = tab !== 'playoffs';
  renderStatus();
  if (tab === 'season') { renderDivisions(st); renderSchedule(st); }
  else renderPlayoffs(st);
}

// ---------- events ----------

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) { tab = tabBtn.dataset.tab; save('tab', tab); render(); return; }

  const pickBtn = e.target.closest('.pick button');
  if (pickBtn) {
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

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

render();
refresh(allWeeks());
setInterval(poll, 60 * 1000);
