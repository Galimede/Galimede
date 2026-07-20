#!/usr/bin/env node
// Generates the TELEMETRY stat cards as self-contained SVGs, committed to the
// repo. No external rendering service — the workflow queries the GitHub GraphQL
// API with its own token and this script draws the SVG in GALIMEDE's palette,
// matching the hand-made hero cards in assets/.
//
// The contribution ledger is split into two groups so the time scope of each
// metric is explicit: commits/PRs/reviews/issues come from the contributions
// collection (a trailing ~12-month window, labelled with its real dates), while
// stars and repositories-contributed-to are cumulative. A 52-week activity
// trace under the ledger gives the window a visible shape.
//
// Env:
//   GITHUB_TOKEN  — token used for the GraphQL request (workflow token)
//   STATS_LOGIN   — GitHub login to profile (default: Galimede)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOGIN = process.env.STATS_LOGIN || 'Galimede';
const TOKEN = process.env.GITHUB_TOKEN;
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

if (TOKEN == null) {
  console.error('Missing GITHUB_TOKEN');
  process.exit(1);
}

// ── Palettes (lifted from assets/hero-{amber,mocha}.svg) ────────────────────
const THEMES = {
  amber: {
    bg: '#0A0A0A', bezel: '#150f00', border: '#3a2900', rivet: '#3a2900',
    rivetStroke: '#8a6a1f', title: '#FFB000', text: '#F2E8CF', accent: '#FFD66B',
    dim: '#8a6a1f', bar: '#3a2900',
  },
  mocha: {
    bg: '#1e1e2e', bezel: '#313244', border: '#45475a', rivet: '#45475a',
    rivetStroke: '#6c7086', title: '#fab387', text: '#cdd6f4', accent: '#f9e2af',
    dim: '#6c7086', bar: '#45475a',
  },
};

// ── Data ────────────────────────────────────────────────────────────────────
const QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      startedAt
      endedAt
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        weeks {
          firstDay
          contributionDays { contributionCount }
        }
      }
    }
    repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) {
      totalCount
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: { field: STARGAZERS, direction: DESC }) {
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// "2024-07-15T..." → "2024·07"
const stamp = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}·${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function fetchData() {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'galimede-telemetry',
    },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);

  const u = json.data.user;
  const c = u.contributionsCollection;
  const stars = u.repositories.nodes.reduce((n, r) => n + r.stargazerCount, 0);

  const langSizes = new Map();
  const langColors = new Map();
  for (const repo of u.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) {
      langSizes.set(node.name, (langSizes.get(node.name) || 0) + size);
      if (node.color) langColors.set(node.name, node.color);
    }
  }
  const totalBytes = [...langSizes.values()].reduce((a, b) => a + b, 0) || 1;
  const langs = [...langSizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, size]) => ({
      name,
      pct: (size / totalBytes) * 100,
      color: langColors.get(name) || '#888888',
    }));

  // Weekly contribution totals, most recent 52 weeks, plus month boundaries.
  const calendarWeeks = c.contributionCalendar.weeks.slice(-52);
  const trace = calendarWeeks.map((w) => w.contributionDays.reduce((n, d) => n + d.contributionCount, 0));
  const ticks = [];
  let prevMonth = -1;
  calendarWeeks.forEach((w, i) => {
    const month = new Date(`${w.firstDay}T00:00:00Z`).getUTCMonth();
    if (month !== prevMonth) ticks.push({ label: MONTHS[month], i });
    prevMonth = month;
  });
  // The window opens mid-month, so the leading tick is a stub that collides with
  // the next label — and its month already appears at the other end of the axis.
  if (ticks.length > 12) ticks.shift();

  const window = `${stamp(c.startedAt)} → ${stamp(c.endedAt)}`;

  return {
    groups: [
      {
        label: window,
        rows: [
          ['COMMITS', c.totalCommitContributions],
          ['PULL REQUESTS', c.totalPullRequestContributions],
          ['CODE REVIEWS', c.totalPullRequestReviewContributions],
          ['ISSUES', c.totalIssueContributions],
        ],
      },
      {
        label: 'CUMULATIVE',
        rows: [
          ['STARS EARNED', stars],
          ['CONTRIBUTED TO', u.repositoriesContributedTo.totalCount],
        ],
      },
    ],
    langs,
    trace,
    ticks,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US');

// Geometry. The card grew from 300 to 390 tall to make room for the trace.
const W = 820, H = 390;
const PAD = 44, RIGHT = W - PAD;
const COL2 = 430, BAR_W = 346;
const TRACE_X = PAD, TRACE_W = RIGHT - PAD, TRACE_TOP = 320, TRACE_H = 30;
const BASE_Y = TRACE_TOP + TRACE_H;

function render(theme, { groups, langs, trace, ticks }) {
  const t = THEMES[theme];
  const FONT = "ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace";

  // Left column: grouped stat rows, each group introduced by its time scope.
  const ROW_H = 26;
  let y = 106;
  const statRows = groups.map(({ label, rows }) => {
    const head = `  <text x="${PAD}" y="${y}" font-size="10" fill="${t.dim}" letter-spacing="0.5">&#9666; ${esc(label)} &#9656;</text>`;
    y += 20;
    const body = rows.map(([name, value]) => {
      const row = `  <text x="${PAD}" y="${y}" font-size="13" fill="${t.dim}">${esc(name)}</text>
  <text x="366" y="${y}" font-size="14" font-weight="600" fill="${t.accent}" text-anchor="end">${esc(fmt(value))}</text>
  <line x1="${PAD}" y1="${y + 7}" x2="366" y2="${y + 7}" stroke="${t.bar}" stroke-width="1" stroke-dasharray="1 4"/>`;
      y += ROW_H;
      return row;
    }).join('\n');
    y += 4;
    return `${head}\n${body}`;
  }).join('\n');

  // Right column: language bars.
  const LANG_H = 33;
  const maxPct = Math.max(...langs.map((l) => l.pct), 1);
  const langRows = langs.map((l, i) => {
    const ly = 112 + i * LANG_H;
    const w = Math.max(2, (l.pct / maxPct) * BAR_W);
    return `  <text x="${COL2}" y="${ly}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
  <text x="${COL2 + BAR_W}" y="${ly}" font-size="12" fill="${t.dim}" text-anchor="end">${l.pct.toFixed(1)}%</text>
  <rect x="${COL2}" y="${ly + 8}" width="${BAR_W}" height="6" rx="3" fill="${t.bar}"/>
  <rect x="${COL2}" y="${ly + 8}" width="${w.toFixed(1)}" height="6" rx="3" fill="${esc(l.color)}"/>`;
  }).join('\n');

  // Bottom strip: 52-week activity trace, an oscilloscope read-out of the window.
  const n = trace.length;
  const peak = Math.max(...trace, 1);
  const px = (i) => TRACE_X + (n > 1 ? (i * TRACE_W) / (n - 1) : 0);
  const py = (v) => BASE_Y - (v / peak) * TRACE_H;
  const points = trace.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');

  const monthTicks = ticks.map(({ label, i }) => {
    const x = px(i);
    const rule = i === 0 ? '' :
      `  <line x1="${x.toFixed(1)}" y1="${TRACE_TOP}" x2="${x.toFixed(1)}" y2="${BASE_Y}" stroke="${t.bar}" stroke-width="1"/>\n`;
    return `${rule}  <text x="${Math.min(Math.max(x, 30), W - 30).toFixed(1)}" y="${BASE_Y + 14}" font-size="9" fill="${t.dim}" text-anchor="middle">${label}</text>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="${FONT}" role="img" aria-label="GALIMEDE telemetry — GitHub statistics">
  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="6" fill="${t.bezel}" stroke="${t.border}" stroke-width="2"/>
  <rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="3" fill="${t.bg}" stroke="${t.border}" stroke-width="1"/>
  <circle cx="22" cy="22" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>
  <circle cx="${W - 22}" cy="22" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>
  <circle cx="22" cy="${H - 22}" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>
  <circle cx="${W - 22}" cy="${H - 22}" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>

  <text x="${PAD}" y="52" font-size="15" font-weight="600" fill="${t.title}">&#9622; TELEMETRY</text>
  <text x="${RIGHT}" y="52" font-size="12" fill="${t.dim}" text-anchor="end">SPECIMEN // ${esc(LOGIN.toUpperCase())}</text>
  <line x1="${PAD}" y1="66" x2="${RIGHT}" y2="66" stroke="${t.border}" stroke-width="1"/>

  <text x="${PAD}" y="86" font-size="11" fill="${t.dim}">&#9656; CONTRIBUTION LEDGER</text>
  <text x="${COL2}" y="86" font-size="11" fill="${t.dim}">&#9656; LANGUAGE DISTRIBUTION</text>
${statRows}
${langRows}

  <line x1="${PAD}" y1="296" x2="${RIGHT}" y2="296" stroke="${t.border}" stroke-width="1"/>
  <text x="${PAD}" y="312" font-size="11" fill="${t.dim}">&#9656; ACTIVITY &#183; 52-WEEK TRACE</text>
  <text x="${RIGHT}" y="312" font-size="10" fill="${t.dim}" text-anchor="end">PEAK ${esc(fmt(peak))}/WK</text>
  <line x1="${TRACE_X}" y1="${BASE_Y}" x2="${TRACE_X + TRACE_W}" y2="${BASE_Y}" stroke="${t.border}" stroke-width="1"/>
${monthTicks}
  <polygon points="${TRACE_X},${BASE_Y} ${points} ${TRACE_X + TRACE_W},${BASE_Y}" fill="${t.accent}" fill-opacity="0.18"/>
  <polyline points="${points}" fill="none" stroke="${t.accent}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
try {
  const data = await fetchData();
  for (const theme of Object.keys(THEMES)) {
    const out = join(ASSETS, `telemetry-${theme}.svg`);
    writeFileSync(out, render(theme, data) + '\n');
    console.log(`wrote ${out}`);
  }
} catch (err) {
  console.error('Telemetry generation failed — keeping existing SVGs.');
  console.error(err);
  process.exit(1);
}
