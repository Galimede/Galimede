#!/usr/bin/env node
// Generates the TELEMETRY stat cards as self-contained SVGs, committed to the
// repo. No external rendering service — the workflow queries the GitHub GraphQL
// API with its own token and this script draws the SVG in GALIMEDE's palette,
// matching the hand-made hero cards in assets/.
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
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
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

  return {
    stats: [
      ['STARS EARNED', stars],
      ['COMMITS · 12MO', c.totalCommitContributions],
      ['PULL REQUESTS', c.totalPullRequestContributions],
      ['CODE REVIEWS', c.totalPullRequestReviewContributions],
      ['ISSUES', c.totalIssueContributions],
      ['CONTRIBUTED TO', u.repositoriesContributedTo.totalCount],
    ],
    langs,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US');

function render(theme, key, { stats, langs }) {
  const t = THEMES[theme];
  const W = 820, H = 300;
  const FONT = "ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace";

  // Left column: stat rows.
  const rowY0 = 112, rowH = 29;
  const statRows = stats.map(([label, value], i) => {
    const y = rowY0 + i * rowH;
    return `  <text x="44" y="${y}" font-size="13" fill="${t.dim}">${esc(label)}</text>
  <text x="366" y="${y}" font-size="14" font-weight="600" fill="${t.accent}" text-anchor="end">${esc(fmt(value))}</text>
  <line x1="44" y1="${y + 7}" x2="366" y2="${y + 7}" stroke="${t.bar}" stroke-width="1" stroke-dasharray="1 4"/>`;
  }).join('\n');

  // Right column: language bars.
  const barX = 430, barW = 346, langY0 = 112, langH = 33;
  const maxPct = Math.max(...langs.map((l) => l.pct), 1);
  const langRows = langs.map((l, i) => {
    const y = langY0 + i * langH;
    const w = Math.max(2, (l.pct / maxPct) * barW);
    return `  <text x="${barX}" y="${y}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
  <text x="${barX + barW}" y="${y}" font-size="12" fill="${t.dim}" text-anchor="end">${l.pct.toFixed(1)}%</text>
  <rect x="${barX}" y="${y + 8}" width="${barW}" height="6" rx="3" fill="${t.bar}"/>
  <rect x="${barX}" y="${y + 8}" width="${w.toFixed(1)}" height="6" rx="3" fill="${esc(l.color)}"/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="${FONT}" role="img" aria-label="GALIMEDE telemetry — GitHub statistics">
  <rect width="${W}" height="${H}" fill="${t.bg}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="6" fill="${t.bezel}" stroke="${t.border}" stroke-width="2"/>
  <rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="3" fill="${t.bg}" stroke="${t.border}" stroke-width="1"/>
  <circle cx="22" cy="22" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>
  <circle cx="${W - 22}" cy="22" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>
  <circle cx="22" cy="${H - 22}" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>
  <circle cx="${W - 22}" cy="${H - 22}" r="2.5" fill="${t.rivet}" stroke="${t.rivetStroke}" stroke-width="0.6"/>

  <text x="44" y="52" font-size="15" font-weight="600" fill="${t.title}">&#9622; TELEMETRY</text>
  <text x="${W - 44}" y="52" font-size="12" fill="${t.dim}" text-anchor="end">SPECIMEN // ${esc(LOGIN.toUpperCase())}</text>
  <line x1="44" y1="66" x2="${W - 44}" y2="66" stroke="${t.border}" stroke-width="1"/>

  <text x="44" y="86" font-size="11" fill="${t.dim}">&#9656; CONTRIBUTION LEDGER</text>
  <text x="430" y="86" font-size="11" fill="${t.dim}">&#9656; LANGUAGE DISTRIBUTION</text>
${statRows}
${langRows}
</svg>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
try {
  const data = await fetchData();
  for (const theme of Object.keys(THEMES)) {
    const svg = render(theme, theme, data);
    const out = join(ASSETS, `telemetry-${theme}.svg`);
    writeFileSync(out, svg + '\n');
    console.log(`wrote ${out}`);
  }
} catch (err) {
  console.error('Telemetry generation failed — keeping existing SVGs.');
  console.error(err);
  process.exit(1);
}
