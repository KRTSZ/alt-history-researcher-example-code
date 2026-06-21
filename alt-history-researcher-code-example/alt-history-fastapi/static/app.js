/**
 * Alternative History Explorer — client-side JS
 * ===============================================
 * This file contains ONLY UI logic. All AI API calls go through
 * /api/ask on our own server. No provider keys or system prompt here.
 *
 * Config injected by the server via <body data-*> attributes:
 *   data-free-limit      — daily free question limit (integer)
 *   data-has-server-key  — "true"/"false" (whether a server-side key is configured)
 */

'use strict';

// ── Server config (read from <body> data attributes set by Jinja2) ──────────
const FREE_DAILY_LIMIT = parseInt(document.body.dataset.freeLimit || '5', 10);
const HAS_SERVER_KEY   = document.body.dataset.hasServerKey === 'true';

// ── Panel definitions ───────────────────────────────────────────────────────
const PANEL_DEFS = [
  { id: 'scenario',        title: 'The Alternative Scenario',   icon: '🌐' },
  { id: 'pushback',        title: "Historian's Objection",      icon: '⚔'  },
  { id: 'scholarly',       title: 'Where Scholarship Differs',  icon: '📚' },
  { id: 'reform',          title: 'How It Could Have Happened', icon: '⚙'  },
  { id: 'mindsets',        title: 'Mindsets of the Time',       icon: '🧠' },
  { id: 'parallels',       title: 'Historical Parallels',       icon: '🔄' },
  { id: 'primary_sources', title: 'Primary Sources',            icon: '📜' },
  { id: 'deep_dives',      title: 'Deep Dives',                 icon: '🔍' },
  { id: 'unknowns',        title: "What We Don't Know",         icon: '❓' },
  { id: 'key_sources',     title: 'Key Claims & Sources',       icon: '✓'  },
  { id: 'confidence',      title: 'Confidence Assessment',      icon: '📊' },
];

// ── Provider definitions (UI only — actual API calls happen server-side) ────
const PROVIDER_DEFS = [
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-opus-4-7',             placeholder: 'sk-ant-... (optional — free tier available)' },
  { id: 'openai',    name: 'OpenAI',    defaultModel: 'gpt-4o',                       placeholder: 'sk-... (required)' },
  { id: 'google',    name: 'Google',    defaultModel: 'gemini-2.5-pro-preview-05-06', placeholder: 'AIza... (required)' },
  { id: 'xai',       name: 'xAI',       defaultModel: 'grok-3',                       placeholder: 'xai-... (required)' },
];

// ── localStorage keys ────────────────────────────────────────────────────────
const KEYS_KEY    = 'ahe_keys';
const MODELS_KEY  = 'ahe_models';
const ENABLED_KEY = 'ahe_enabled';
const STORE_KEY   = 'ahe_fastapi_v1';

// ── Utility helpers ──────────────────────────────────────────────────────────

/** Safe localStorage read: returns {} or [] on error/missing key. */
const ls    = k => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
const lsArr = k => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };

/** Escape a value for safe HTML insertion. */
const esc = s =>
  (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Provider UI ──────────────────────────────────────────────────────────────

function renderProviders() {
  const keys    = ls(KEYS_KEY);
  const models  = ls(MODELS_KEY);
  const enabled = ls(ENABLED_KEY);
  const body    = document.getElementById('providers-body');
  body.innerHTML = '';

  PROVIDER_DEFS.forEach(p => {
    const savedKey   = keys[p.id]   || '';
    const savedModel = models[p.id] || p.defaultModel;
    // Anthropic can work without a key if the server has one configured
    const isAnthropicFree = p.id === 'anthropic' && HAS_SERVER_KEY;
    const checked = isAnthropicFree
      ? (enabled[p.id] !== false)
      : (savedKey ? (enabled[p.id] !== false) : false);

    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `
      <input type="checkbox" id="pchk-${p.id}" ${checked ? 'checked' : ''}
             style="accent-color:var(--accent);width:18px;height:18px;cursor:pointer"
             onchange="saveEnabled('${p.id}', this.checked)">
      <span class="provider-name">${esc(p.name)}</span>
      <input type="text"     class="provider-model" id="pmod-${p.id}"
             value="${esc(savedModel)}" placeholder="${esc(p.defaultModel)}"
             oninput="saveModel('${p.id}', this.value)" style="max-width:130px">
      <input type="password" class="provider-key"   id="pkey-${p.id}"
             value="${esc(savedKey)}" placeholder="${esc(p.placeholder)}"
             oninput="saveKey('${p.id}', this.value); autoCheck('${p.id}'); updateFreeBadge()">`;
    body.appendChild(row);

    // Show free-tier badge under the Anthropic row
    if (p.id === 'anthropic') {
      const badge = document.createElement('div');
      badge.id        = 'free-badge';
      badge.className = 'free-badge';
      badge.style.padding = '0 14px 6px';
      body.appendChild(badge);
    }
  });
}

function autoCheck(id) {
  const val = (document.getElementById('pkey-' + id)?.value || '').trim();
  const cb  = document.getElementById('pchk-' + id);
  if (cb && val) { cb.checked = true; saveEnabled(id, true); }
}
function saveKey(id, v)     { const d = ls(KEYS_KEY);    d[id] = v; localStorage.setItem(KEYS_KEY,    JSON.stringify(d)); }
function saveModel(id, v)   { const d = ls(MODELS_KEY);  d[id] = v; localStorage.setItem(MODELS_KEY,  JSON.stringify(d)); }
function saveEnabled(id, v) { const d = ls(ENABLED_KEY); d[id] = v; localStorage.setItem(ENABLED_KEY, JSON.stringify(d)); }

/** Return providers that are checked. Anthropic may have no key (free tier). */
function getActiveProviders() {
  return PROVIDER_DEFS
    .filter(p => document.getElementById(`pchk-${p.id}`)?.checked)
    .map(p => ({
      ...p,
      key:   (document.getElementById(`pkey-${p.id}`)?.value  || '').trim(),
      model: (document.getElementById(`pmod-${p.id}`)?.value  || p.defaultModel).trim(),
    }))
    .filter(p => {
      // Anthropic allowed with no key if server has one
      if (p.id === 'anthropic' && HAS_SERVER_KEY) return true;
      return !!p.key;
    });
}

// ── Free-tier badge ──────────────────────────────────────────────────────────

/**
 * Fetch today's usage from the server and update the Anthropic badge.
 * The server is authoritative; the badge is purely informational.
 */
async function updateFreeBadge() {
  const badge = document.getElementById('free-badge');
  if (!badge) return;

  const userKey = (document.getElementById('pkey-anthropic')?.value || '').trim();
  if (userKey) {
    badge.textContent  = 'Own key active — no daily limit';
    badge.style.color  = 'var(--green)';
    return;
  }
  if (!HAS_SERVER_KEY) {
    badge.textContent = 'No server key — enter your own key above';
    badge.style.color = 'var(--red)';
    return;
  }

  try {
    const resp = await fetch('/api/free-usage');
    const data = await resp.json();
    const remaining = Math.max(0, data.limit - data.used);
    badge.textContent = remaining > 0
      ? `${remaining} of ${data.limit} free questions left today`
      : 'Daily limit reached — enter your own API key to continue';
    badge.style.color = remaining > 0 ? 'var(--green)' : 'var(--red)';
  } catch {
    badge.textContent = `${FREE_DAILY_LIMIT} free questions/day`;
    badge.style.color = 'var(--ink-faint)';
  }
}

// ── History ───────────────────────────────────────────────────────────────────

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function getHistory() { return lsArr(STORE_KEY); }
function saveEntry(e) {
  const all = getHistory();
  const idx = all.findIndex(x => x.id === e.id);
  if (idx >= 0) all[idx] = e; else all.unshift(e);
  if (all.length > 50) all.splice(50);
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
}
function relTime(ts) {
  const d = Date.now() - ts, m = Math.floor(d / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy === 1) return 'yesterday';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function shortModel(m) {
  m = (m || '').toLowerCase();
  if (m.includes('opus'))    return 'Opus';
  if (m.includes('sonnet'))  return 'Sonnet';
  if (m.includes('haiku'))   return 'Haiku';
  if (m === 'gpt-4o')        return 'GPT-4o';
  if (m.includes('4o-mini')) return '4o-mini';
  if (/^o[134]/.test(m))     return m.split('-')[0].toUpperCase();
  if (m.includes('gemini-2.5')) return 'Gemini 2.5';
  if (m.includes('grok-3'))  return 'Grok 3';
  return m.split('-').slice(-2).join('-');
}
function showHistory() {
  const all  = getHistory();
  const list = document.getElementById('modal-list');
  list.innerHTML = '';
  if (!all.length) {
    list.innerHTML = '<div class="history-empty">No searches yet.</div>';
  } else {
    all.forEach(e => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.onclick   = () => { closeHistory(); loadEntry(e); };
      item.innerHTML = `
        <div class="history-q">${esc(e.question.length > 80 ? e.question.slice(0, 78) + '…' : e.question)}</div>
        <div class="history-meta">${e.model ? esc(shortModel(e.model)) + ' · ' : ''}${relTime(e.timestamp)}</div>`;
      list.appendChild(item);
    });
  }
  document.getElementById('modal-overlay').classList.add('open');
}
function closeHistory() { document.getElementById('modal-overlay').classList.remove('open'); }
function loadEntry(e) {
  document.getElementById('question').value = e.question;
  buildCarousel(e.result, e.thinking || '', e.question);
  showScreen('results');
}

// ── Carousel engine ───────────────────────────────────────────────────────────

let currentIdx  = 0;
let totalPanels = 0;
let touchStartX = 0, touchStartY = 0, touchStartT = 0;
let hintShown   = false;

function buildCarousel(result, thinkingText, question) {
  const track = document.getElementById('carousel-track');
  track.innerHTML = '';

  const contents = [
    buildScenarioPanel(result),
    buildPushbackPanel(result),
    buildScholarlyPanel(result),
    buildReformPanel(result),
    buildProsePanel('mindsets',  result, 'Mindsets & Worldviews'),
    buildProsePanel('parallels', result, 'Comparable Situations'),
    buildPrimarySourcesPanel(result),
    buildDeepDivesPanel(result),
    buildUnknownsPanel(result),
    buildKeySourcesPanel(result),
    buildConfidencePanel(result),
  ];
  const defs = [...PANEL_DEFS];

  // Prepend thinking panel if the model returned reasoning text
  if (thinkingText && thinkingText.trim()) {
    contents.unshift(buildThinkingPanel(thinkingText));
    defs.unshift({ id: 'thinking', title: 'Model Reasoning', icon: '⚡' });
  }

  totalPanels  = contents.length;
  track._defs  = defs;

  contents.forEach(html => {
    const card   = document.createElement('div');
    card.className = 'panel-card';
    const scroll = document.createElement('div');
    scroll.className = 'panel-scroll';
    scroll.innerHTML  = html;
    card.appendChild(scroll);
    track.appendChild(card);
  });

  // Dot nav
  const dotNav = document.getElementById('dot-nav');
  dotNav.innerHTML = '';
  for (let i = 0; i < totalPanels; i++) {
    const dot = document.createElement('button');
    dot.className = 'dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `Panel ${i + 1}`);
    dot.onclick = () => goToPanel(i);
    dotNav.appendChild(dot);
  }

  currentIdx = 0;
  updateCarouselPosition(false);
  setupTouch(document.getElementById('carousel-viewport'));
}

function navigate(dir) { goToPanel((currentIdx + dir + totalPanels) % totalPanels); }
function goToPanel(idx) { currentIdx = idx; updateCarouselPosition(true); }

function updateCarouselPosition(animate) {
  const track = document.getElementById('carousel-track');
  track.style.transition = animate ? 'transform .32s cubic-bezier(.4,0,.2,1)' : 'none';
  track.style.transform  = `translateX(${-currentIdx * 100}%)`;

  const def = (track._defs || PANEL_DEFS)[currentIdx] || {};
  document.getElementById('panel-icon').textContent    = def.icon  || '✦';
  document.getElementById('panel-title').textContent   = def.title || '';
  document.getElementById('panel-counter').textContent = `${currentIdx + 1} / ${totalPanels}`;

  document.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('active', i === currentIdx));

  const cards = track.querySelectorAll('.panel-scroll');
  if (cards[currentIdx]) cards[currentIdx].scrollTop = 0;
}

// ── Touch / swipe ─────────────────────────────────────────────────────────────

function setupTouch(el) {
  // Re-attach by replacing the element (removes all previous listeners)
  const clone = el.cloneNode(false);
  while (el.firstChild) clone.appendChild(el.firstChild);
  el.parentNode.replaceChild(clone, el);
  const newEl = document.getElementById('carousel-viewport');

  newEl.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartT = Date.now();
  }, { passive: true });

  newEl.addEventListener('touchend', e => {
    const dx  = e.changedTouches[0].clientX - touchStartX;
    const dy  = e.changedTouches[0].clientY - touchStartY;
    const vel = Math.abs(dx) / (Date.now() - touchStartT);
    if (Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 45 || vel > 0.4)) {
      navigate(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  newEl.setAttribute('tabindex', '0');
  newEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft')  navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  });
}

// ── Panel content builders ────────────────────────────────────────────────────
// All user-supplied text goes through esc() before innerHTML insertion.

function buildScenarioPanel(r) {
  if (!r.scenario) return '<p style="color:var(--ink-faint);font-style:italic">No scenario in this response.</p>';
  return `<div class="prose">${r.scenario.split('\n\n').map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
}
function buildPushbackPanel(r) {
  if (!r.pushback) return '<p style="color:var(--ink-faint);font-style:italic">No historian\'s objection in this response.</p>';
  return `<div class="pushback-banner"><div class="prose">${r.pushback.split('\n\n').map(p => `<p>${esc(p)}</p>`).join('')}</div></div>`;
}
function buildScholarlyPanel(r) {
  const divs = r.scholarly_divergences || [];
  if (!divs.length) return '<p style="color:var(--ink-faint);font-style:italic">No scholarly corrections in this response.</p>';
  return divs.map(d => `
    <div class="scholarly-item">
      <span class="scholar-row-label">Popular account</span>
      <div class="scholar-popular">${esc(d.popular_claim || '')}</div>
      <span class="scholar-row-label">What specialists argue</span>
      <div class="scholar-reality">${esc(d.scholarly_reality || '')}</div>
      <div class="scholar-matters">${esc(d.why_it_matters || '')}</div>
    </div>`).join('');
}
function buildReformPanel(r) {
  const rf  = r.reform || {};
  const pct = Math.min(100, Math.max(0, parseInt(rf.feasibility_pct) || 0));
  const col = pct < 30 ? '#7a1f1f' : pct < 60 ? '#8b5e1a' : '#2a5c3f';
  return `
    <div class="reform-pct-row">
      <span class="reform-pct-num" style="color:${col}">${pct}%</span>
      <span class="reform-pct-lbl">${esc(rf.feasibility_label || '')}</span>
    </div>
    <div class="bar-bg"><div class="bar-fill" id="reform-bar" style="width:0%;background:${col}"></div></div>
    <div class="reform-two-col">
      <div><div class="reform-col-head reform-for">Champions</div><div class="reform-col-body">${esc(rf.champions || '—')}</div></div>
      <div><div class="reform-col-head reform-against">Resistance</div><div class="reform-col-body">${esc(rf.resistance || '—')}</div></div>
    </div>
    <div class="reform-row"><span class="reform-row-label">Closest analog</span><div class="reform-row-text">${esc(rf.closest_analog || '—')}</div></div>
    <div class="reform-row"><span class="reform-row-label">Most achievable version</span><div class="reform-row-text">${esc(rf.realistic_ceiling || '—')}</div></div>`;
}
function buildProsePanel(field, r, label) {
  const text = r[field] || '';
  if (!text) return `<p style="color:var(--ink-faint);font-style:italic">No ${label.toLowerCase()} in this response.</p>`;
  return `<div class="prose">${text.split('\n\n').map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
}
function buildPrimarySourcesPanel(r) {
  const srcs = r.primary_sources || [];
  if (!srcs.length) return '<p style="color:var(--ink-faint);font-style:italic">No primary sources in this response.</p>';
  return srcs.map((s, i) => `
    <div class="psource-item">
      <div class="psource-head" onclick="togglePs(${i})">
        <span class="psource-icon" id="psi-${i}">▸</span>
        <span class="psource-name">${esc(s.name || '')}</span>
        <span class="psource-type-tag">${esc(s.type || '')}</span>
      </div>
      <div class="psource-body" id="psb-${i}">
        <div class="psource-row"><span class="psource-row-label">Period</span><div class="psource-row-text">${esc(s.period || '')}</div></div>
        <div class="psource-row"><span class="psource-row-label">Contains</span><div class="psource-row-text">${esc(s.what_it_contains || '')}</div></div>
        <div class="psource-row"><span class="psource-row-label">Relevance</span><div class="psource-row-text">${esc(s.relevance || '')}</div></div>
        <div class="psource-row"><span class="psource-row-label">How to use it</span><div class="psource-adapt">${esc(s.how_to_adapt || '')}</div></div>
        <div class="psource-row"><span class="psource-row-label">Limitations</span><div class="psource-row-text" style="font-style:italic">${esc(s.limitations || '')}</div></div>
        <div class="psource-row"><span class="psource-row-label">Access</span><div class="psource-access">${esc(s.access || '')}</div></div>
      </div>
    </div>`).join('');
}
function buildDeepDivesPanel(r) {
  const dives = r.deep_dives || [];
  if (!dives.length) return '<p style="color:var(--ink-faint);font-style:italic">No deep dives in this response.</p>';
  return dives.map((d, i) => `
    <div class="dive-item">
      <div class="dive-head" onclick="toggleDive(${i})">
        <span class="dive-icon" id="di-${i}">▸</span>
        <span class="rel-badge ${relBadge(d.reliability)}">${esc(d.reliability || '')}</span>
        <span class="dive-topic">${esc(d.topic || '')}</span>
      </div>
      <div class="dive-body" id="db-${i}">
        <div class="dive-hook">${esc(d.hook || '')}</div>
        <div class="dive-source-row"><span class="dive-source-label">Start with</span><span class="dive-source">${esc(d.best_source || '')}</span></div>
        <div class="dive-note">${esc(d.note || '')}</div>
      </div>
    </div>`).join('');
}
function buildUnknownsPanel(r) {
  const items = r.unknowns || [];
  if (!items.length) return '<p style="color:var(--ink-faint);font-style:italic">No unknowns listed.</p>';
  return `<ul class="unknowns-list">${items.map(u => `<li>${esc(u)}</li>`).join('')}</ul>`;
}
function buildKeySourcesPanel(r) {
  const srcs = r.key_sources || [];
  if (!srcs.length) return '<p style="color:var(--ink-faint);font-style:italic">No key sources in this response.</p>';
  return srcs.map(s => `
    <div class="source-item">
      <div class="source-claim">
        <span class="rel-badge ${relBadge(s.reliability)}">${esc(s.reliability || '')}</span>
        <span class="source-claim-text">${esc(s.claim || '')}</span>
      </div>
      <div class="source-cite">
        <span class="source-arrow">→</span>
        <span class="source-ref">${esc(s.source || '')}</span>
        <span class="source-access">${esc(s.access || '')}</span>
      </div>
    </div>`).join('');
}
function buildConfidencePanel(r) {
  const pct = Math.min(100, Math.max(0, parseInt(r.confidence) || 0));
  const col = pct < 30 ? 'var(--red)' : pct < 60 ? 'var(--amber)' : 'var(--green)';
  return `
    <div class="conf-pct-row">
      <span class="conf-pct" style="color:${col}">${pct}%</span>
      <span class="conf-tag">${esc(r.confidence_label || '')}</span>
    </div>
    <div class="bar-bg"><div class="bar-fill" id="conf-bar" style="width:0%;background:${col}"></div></div>
    <p class="conf-reason">${esc(r.confidence_reason || '')}</p>`;
}
function buildThinkingPanel(text) {
  return `<div class="thinking-wrap"><pre class="thinking-text">${esc(text)}</pre></div>`;
}

function relBadge(r) {
  const v = (r || '').toLowerCase();
  return v === 'established' ? 'rel-established'
       : v === 'supported'   ? 'rel-supported'
       : v === 'debated'     ? 'rel-debated'
       : 'rel-speculative';
}

// Accordion toggle helpers (called from inline onclick in panel HTML)
function togglePs(i)   { const b = document.getElementById(`psb-${i}`), ic = document.getElementById(`psi-${i}`); ic.textContent = b.classList.toggle('open') ? '▾' : '▸'; }
function toggleDive(i) { const b = document.getElementById(`db-${i}`),  ic = document.getElementById(`di-${i}`);  ic.textContent = b.classList.toggle('open') ? '▾' : '▸'; }

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(name) {
  document.getElementById('screen-setup').classList.toggle('hidden',   name !== 'setup');
  document.getElementById('screen-results').classList.toggle('hidden', name !== 'results');
  document.getElementById('btn-new').style.display = name === 'results' ? 'inline-block' : 'none';
  if (name === 'results' && !hintShown) {
    hintShown = true;
    const hint = document.getElementById('swipe-hint');
    hint.classList.add('show');
    document.getElementById('arrow-prev').classList.add('hint');
    document.getElementById('arrow-next').classList.add('hint');
    setTimeout(() => hint.classList.remove('show'), 2800);
  }
}
function newQuestion() { showScreen('setup'); document.getElementById('question').focus(); }
function fill(t) { document.getElementById('question').value = t; }

// ── Status / timer ────────────────────────────────────────────────────────────

let _timer = null;
function startTimer() {
  const start = Date.now();
  _timer = setInterval(() => {
    document.getElementById('s-elapsed').textContent = Math.floor((Date.now() - start) / 1000) + 's';
  }, 300);
}
function stopTimer() { if (_timer) { clearInterval(_timer); _timer = null; } }
function setStatus(text, cls) {
  const el      = document.getElementById('s-status');
  const spinning = cls.includes('loading') || cls.includes('thinking');
  el.innerHTML  = spinning ? `<span class="spin">⟳</span> ${esc(text)}` : esc(text);
  el.className  = cls;
}
function showError(msg)  { const el = document.getElementById('error-card'); el.textContent = msg; el.style.display = 'block'; }
function clearError()    { document.getElementById('error-card').style.display = 'none'; }

// ── Server API call ───────────────────────────────────────────────────────────

/**
 * POST /api/ask — the ONLY external call this JS file makes.
 * The server handles authentication, rate limiting, and the actual AI request.
 *
 * @param {string}      question - The user's counterfactual question
 * @param {string}      provider - Provider id ('anthropic', 'openai', etc.)
 * @param {string}      model    - Model name
 * @param {string}      effort   - 'low' | 'medium' | 'high'
 * @param {string|null} userKey  - User's own API key (optional; sent to server which
 *                                 forwards it; never stored server-side)
 * @returns {Promise<{result: Object, thinking: string}>}
 */
async function callServerApi(question, provider, model, effort, userKey) {
  const resp = await fetch('/api/ask', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      provider,
      model,
      effort,
      user_key: userKey || null,
    }),
  });

  if (!resp.ok) {
    let detail;
    try { detail = (await resp.json()).detail; } catch { detail = `HTTP ${resp.status}`; }
    // Normalise: detail may be a string or an object with an "error" key
    const msg = typeof detail === 'object'
      ? (detail.error || JSON.stringify(detail))
      : (detail || `Server error ${resp.status}`);
    throw new Error(msg);
  }

  return resp.json();  // { result: {...}, thinking: "..." }
}

// ── Effort estimation ─────────────────────────────────────────────────────────

function calculateEffort(q) {
  const len = q.trim().length;
  const connectives = (q.match(/\b(and|compared|versus|vs\.?|or|while|whereas|whether)\b/gi) || []).length;
  if (len < 80  && connectives < 2) return 'low';
  if (len < 220 && connectives < 4) return 'medium';
  return 'high';
}

// ── Main ask ──────────────────────────────────────────────────────────────────

async function ask() {
  const q = document.getElementById('question').value.trim();
  if (!q) return;

  const active = getActiveProviders();
  if (!active.length) {
    showError(HAS_SERVER_KEY
      ? 'Tick the Anthropic checkbox to use the free tier, or enter an API key.'
      : 'Enter at least one API key and tick its checkbox.');
    return;
  }
  clearError();

  const effort = calculateEffort(q);

  document.getElementById('status-card').style.display = 'block';
  document.getElementById('s-model').textContent = active.map(p => shortModel(p.model)).join(', ');
  setStatus('sending…', 'status-loading');
  startTimer();
  document.getElementById('ask-btn').disabled = true;

  // Run all active providers in parallel (multi-provider comparison)
  let firstResult = null;
  const results = await Promise.allSettled(
    active.map(async prov => {
      setStatus('thinking…', 'status-thinking');
      const { result, thinking } = await callServerApi(q, prov.id, prov.model, effort, prov.key || null);
      return { result, thinking, prov };
    })
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed    = results.filter(r => r.status === 'rejected');

  if (succeeded.length > 0) {
    firstResult = succeeded[0];
    const { result, thinking, prov } = firstResult;

    saveEntry({ id: genId(), timestamp: Date.now(), question: q,
                result, thinking, provider: prov.id, model: prov.model });

    buildCarousel(result, thinking, q);
    showScreen('results');

    // Animate percentage bars after panels are in the DOM
    setTimeout(() => {
      const rb   = document.getElementById('reform-bar');
      const cb   = document.getElementById('conf-bar');
      const pct  = Math.min(100, Math.max(0, parseInt(result.reform?.feasibility_pct) || 0));
      const cpct = Math.min(100, Math.max(0, parseInt(result.confidence) || 0));
      if (rb) rb.style.width = pct  + '%';
      if (cb) cb.style.width = cpct + '%';
    }, 120);

    setStatus('done', 'status-done');
    updateFreeBadge();

  } else {
    // All providers failed — show the first error
    const firstError = failed[0]?.reason?.message || 'Unknown error';
    setStatus('error', 'status-fail');
    showError(firstError);
  }

  stopTimer();
  document.getElementById('ask-btn').disabled = false;
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.getElementById('question').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask();
});

// ── Initialise ────────────────────────────────────────────────────────────────

renderProviders();
updateFreeBadge();
