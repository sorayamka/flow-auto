// DOM hooks are a contract: report missing controls instead of silently
// registering listeners on detached elements.
const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing panel element: #${id}`);
  return element;
};

const els = {
  dot: $('dot'),
  phaseBadge: $('phaseBadge'),
  buildBadge: $('buildBadge'),
  drvBadge: $('drvBadge'),
  staleWarn: $('staleWarn'),
  link: $('link'),
  grabBtn: $('grabBtn'),
  scrapeErr: $('scrapeErr'),
  modeSingle: $('modeSingle'),
  modeBulk: $('modeBulk'),
  singleRow: $('singleRow'),
  bulkList: $('bulkList'),
  bulkRow: $('bulkRow'),
  bulkBtn: $('bulkBtn'),
  scrapeModeHint: $('scrapeModeHint'),
  pickingSec: $('pickingSec'),
  photoStat: $('photoStat'),
  gallery: $('gallery'),
  selectAll: $('selectAll'),
  selVisible: $('selVisible'),
  clearSel: $('clearSel'),
  selCount: $('selCount'),
  prompt: $('prompt'),
  useBase: $('useBase'),
  baseRow: $('baseRow'),
  baseFile: $('baseFile'),
  clearBase: $('clearBase'),
  mode: $('mode'),
  delay: $('delay'),
  timeout: $('timeout'),
  retryCount: $('retryCount'),
  retryDelay: $('retryDelay'),
  retryViaTile: $('retryViaTile'),
  autoDownload: $('autoDownload'),
  linkList: $('linkList'),
  maxPerLink: $('maxPerLink'),
  queueBtn: $('queueBtn'),
  clearQueueBtn: $('clearQueueBtn'),
  linkStatusList: $('linkStatusList'),
  queueStat: $('queueStat'),
  startBtn: $('startBtn'),
  pauseBtn: $('pauseBtn'),
  resumeBtn: $('resumeBtn'),
  stopBtn: $('stopBtn'),
  diagBtn: $('diagBtn'),
  runSec: $('runSec'),
  retryBtn: $('retryBtn'),
  reloadFlowBtn: $('reloadFlowBtn'),
  dumpBtn: $('dumpBtn'),
  aimBtn: $('aimBtn'),
  aimBadge: $('aimBadge'),
  selfBtn: $('selfBtn'),
  progText: $('progText'),
  pbarFill: $('pbarFill'),
  log: $('log'),
  clearLog: $('clearLog'),
  historyList: $('historyList'),
  histCount: $('histCount'),
  upList: $('upList'),
  upBtn: $('upBtn'),
  upStopBtn: $('upStopBtn'),
  upClearBtn: $('upClearBtn'),
  upSkipBtn: $('upSkipBtn'),
  upCount: $('upCount'),
  upPbar: $('upPbar'),
  upStat: $('upStat'),
  upStatusList: $('upStatusList'),
  toasts: $('toasts'),
};

const PHASE_RU = {
  idle: 'ожидание',
  scraping: 'выгрузка…',
  picking: 'выбор фото',
  running: 'генерация',
  paused: 'пауза',
  done: 'завершено',
  uploading: 'фото в Flow',
};

const LQ_RU = {
  pending: 'ожидает',
  scraping: 'выгрузка…',
  running: 'в работе',
  done: 'готово',
  error: 'ошибка',
  cancelled: 'стоп',
};

const UP_RU = {
  pending: 'ожидает',
  scraping: 'выгрузка…',
  uploading: 'в Flow',
  done: 'готово',
  error: 'ошибка',
  cancelled: 'стоп',
  skipped: 'пропущено',
};

// версия сборки прямо в шапке: видно, что реально загружено в Chrome
try {
  const v = chrome.runtime.getManifest().version;
  els.buildBadge.textContent = `v${v}`;
  els.buildBadge.title = `Сборка расширения ${v}. Если кнопка Generate не жмётся — сначала ⟳ Вкладка Flow.`;
} catch {
  /* ignore */
}

const sel = new Set();
let baseImageData = null;
let galleryKey = '';
let lastState = null;
let busyRun = false; // идёт прогон или выгрузка — вкладка «Работа» заблокирована
const thumbs = [];

// ---- связь с background ----

// громкий send: ошибки связи с фоном видны сразу, а не молча
async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    const why = (e && e.message) || String(e || 'неизвестная ошибка');
    toast(`Нет связи с расширением: ${why}`, 'err', 5000);
    logLine(
      'Нет связи с фоном расширения — перезагрузи расширение на chrome://extensions',
      'error',
    );
    return undefined;
  }
}

async function refresh() {
  const res = await send({ type: 'GET_STATE' });
  if (res?.state) render(res.state);
  // если res пустой — send() уже показал ошибку
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE') render(msg.state);
  if (msg.type === 'LOG') {
    seenLogTs = Date.now();
    appendLogLine(msg.text, msg.level);
  }
});

// ---- вкладки ----

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    for (const name of ['work', 'upload', 'history']) {
      $(`tab${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle(
        'hidden',
        t.dataset.tab !== name,
      );
    }
    if (t.dataset.tab === 'history') loadHistory();
  });
});

// ---- тосты ----

function toast(text, kind = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  els.toasts.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ---- лог ----

const LOG_LIMIT = 200;
let seenLogTs = 0;

function appendLogLine(text, level = 'info') {
  const line = document.createElement('div');
  if (level !== 'info') line.className = level;
  if (/готово|выгружено|прикреп/i.test(text)) line.className = 'ok';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  els.log.append(line);
  while (els.log.childElementCount > LOG_LIMIT) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

function logLine(text, level) {
  appendLogLine(text, level);
}

// подтягиваем историю из STATE (после переоткрытия панели), без дублей
function replayLogs(logs) {
  if (!Array.isArray(logs)) return;
  let maxTs = seenLogTs;
  for (const e of logs) {
    if (e && typeof e.t === 'number' && e.t > seenLogTs) {
      appendLogLine(e.text, e.level);
      if (e.t > maxTs) maxTs = e.t;
    }
  }
  seenLogTs = maxTs;
}

els.clearLog.addEventListener('click', () => {
  els.log.innerHTML = '';
});

// ---- рендер ----

function render(state) {
  lastState = state;
  replayLogs(state.logs);
  const running = state.phase === 'running';
  const uploading = state.phase === 'uploading';
  // пока идёт прогон или выгрузка, обработчики галереи/очереди не должны
  // возвращать кнопкам жизни в обход блокировки
  busyRun = running || uploading || state.phase === 'paused';
  els.dot.classList.toggle('on', running || uploading);
  els.phaseBadge.textContent = PHASE_RU[state.phase] || state.phase;

  // версии сборки и драйвера: видно, где именно stale
  if (state.build) els.buildBadge.textContent = `v${state.build}`;
  if (state.driverVersion !== undefined) {
    els.drvBadge.textContent = state.driverVersion ? `drv ${state.driverVersion}` : 'drv ?';
  }
  const stale = !!(
    state.driverVersion &&
    state.needDriver &&
    state.driverVersion !== state.needDriver
  );
  els.staleWarn.classList.toggle('hidden', !stale);
  els.aimBadge.textContent = state.calibrated ? 'прицел ✔' : 'прицел ✖';
  els.aimBadge.style.color = state.calibrated ? 'var(--ok)' : 'var(--warn)';

  els.runSec.classList.toggle('glow', state.phase === 'running');

  if (state.posts?.length) {
    const key = `${state.username}#${countImages(state.posts)}#${state.scrapedAt || 0}`;
    if (key !== galleryKey) {
      galleryKey = key;
      buildGallery(state.posts);
    }
  }
  syncGalleryVisibility();
  if (state.posts?.length) {
    els.photoStat.textContent = `@${state.username} · ${state.posts.length} постов · ${countImages(state.posts)} фото${fmtAge(state.scrapedAt)}`;
  }

  els.grabBtn.disabled =
    state.phase === 'scraping' || running || state.phase === 'paused' || uploading;
  els.grabBtn.innerHTML =
    state.phase === 'scraping' ? '<span class="spin">◌</span> Идёт…' : 'Выгрузить';

  const hasQueue = state.queue?.length > 0;
  els.queueBtn.disabled =
    running || state.phase === 'paused' || uploading || !linkCount || !els.prompt.value.trim();
  els.queueBtn.innerHTML = running ? '<span class="spin">◌</span> Идёт…' : '⏵ В очередь';
  els.startBtn.disabled = running || uploading || !hasGallerySource() || (!hasQueue && !sel.size);
  els.pauseBtn.disabled = !running;
  els.resumeBtn.disabled = state.phase !== 'paused';
  els.stopBtn.disabled = !(running || state.phase === 'paused');

  // прогресс
  const total = state.queue?.length || 0;
  const doneCount =
    state.queue?.filter((j) => ['done', 'skipped', 'error', 'cancelled'].includes(j.status))
      .length || 0;
  const workIdx = state.queue?.findIndex((j) => j.status === 'running');
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  els.pbarFill.style.width = `${pct}%`;
  els.progText.textContent = total
    ? `${doneCount}/${total}${workIdx >= 0 ? ` · №${workIdx + 1} в работе` : ''}`
    : '';
  // кнопка пересбоя ошибок видна только когда есть что пересбивать
  const errCount =
    state.queue?.filter((j) => j.status === 'error' || j.status === 'skipped').length || 0;
  els.retryBtn.style.display = errCount && state.phase !== 'running' ? '' : 'none';
  els.retryBtn.textContent = `↻ Повторить ошибки (${errCount})`;

  // подсветка статуса на превью (в режиме очереди ссылок галерея
  // перестраивается на каждую ссылку, поэтому сверяемся ещё и по URL)
  if (state.queue?.length) {
    for (const job of state.queue) {
      let th = thumbs[job.flatIdx];
      if (!th || th.dataset.url !== job.imageUrl) {
        th = thumbs.find((t) => t.dataset.url === job.imageUrl);
      }
      if (!th) continue;
      th.classList.toggle('done', job.status === 'done');
      th.classList.toggle('working', job.status === 'running');
      th.classList.toggle('skipped', job.status === 'skipped');
      th.classList.toggle('error-thumb', job.status === 'error');
    }
  }
  renderLinkQueue(state.linkQueue);
  renderUpload(state);
  updateSelCount();
}

function countImages(posts) {
  return posts.reduce((n, p) => n + p.imageUrls.length, 0);
}

// Saved background data must not leave an orphaned gallery without a source.
// An active/paused run owns its gallery even if its input fields are cleared.
function hasGallerySource() {
  return !!(els.link.value.trim() || els.bulkList.value.trim() || els.linkList.value.trim());
}

function syncGalleryVisibility() {
  const active = ['running', 'paused', 'uploading'].includes(lastState?.phase);
  const visible = !!lastState?.posts?.length && (hasGallerySource() || active);
  els.pickingSec.classList.toggle('hidden', !visible);
  if (!visible) {
    sel.clear();
    thumbs.forEach((thumb) => thumb.classList.remove('sel'));
    updateSelCount();
  }
}

[els.link, els.bulkList, els.linkList].forEach((input) => {
  input.addEventListener('input', syncGalleryVisibility);
});

// ---- очередь ссылок ----

function parseLinks() {
  return [
    ...new Set(
      els.linkList.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

let linkCount = 0;

function syncLinkCount() {
  linkCount = parseLinks().length;
  els.queueStat.textContent = linkCount ? `${linkCount} в очереди` : '';
  try {
    localStorage.setItem('fa_links', els.linkList.value);
  } catch {
    /* ignore */
  }
  if (busyRun) return; // идёт прогон или выгрузка — кнопку не дёргаем
  els.queueBtn.disabled = !linkCount || !els.prompt.value.trim();
}

function renderLinkQueue(links) {
  els.linkStatusList.innerHTML = '';
  if (!links || !links.length) {
    els.linkStatusList.classList.add('hidden');
    return;
  }
  els.linkStatusList.classList.remove('hidden');
  for (const l of links) {
    const row = document.createElement('div');
    row.className = 'lq-row';
    const u = document.createElement('span');
    u.className = 'lq-url';
    u.textContent = (l.url || '').replace(/^https?:\/\/(www\.)?/, '');
    const s = document.createElement('span');
    s.className = `lq-st st-${l.status}`;
    s.textContent = LQ_RU[l.status] || l.status;
    row.append(u, s);
    if (l.note) row.title = `${LQ_RU[l.status] || l.status}: ${l.note}`;
    els.linkStatusList.append(row);
  }
}

// ---- режим «Выгрузка»: только фото в Flow ----

function parseUpLinks() {
  return [
    ...new Set(
      els.upList.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

let upLinkCount = 0;

function syncUpCount() {
  upLinkCount = parseUpLinks().length;
  els.upCount.textContent = upLinkCount ? `${upLinkCount} ссылок` : '';
  renderUpload(lastState || { phase: 'idle' });
  try {
    localStorage.setItem('fa_up_links', els.upList.value);
  } catch {
    /* ignore */
  }
}

function renderUpload(state) {
  const uploading = state.phase === 'uploading';
  els.upBtn.disabled =
    uploading || state.phase === 'running' || state.phase === 'paused' || !upLinkCount;
  els.upBtn.innerHTML = uploading ? '<span class="spin">◌</span> Идёт…' : '⬆ Выгрузить в Flow';
  els.upStopBtn.disabled = !uploading;
  // «Дальше» только когда действительно есть к чему переходить
  els.upSkipBtn.disabled =
    !uploading ||
    !(state.upLinks || []).some((l) => l.status === 'uploading' || l.status === 'scraping');

  const links = state.upLinks || [];
  const jobs = state.upQueue || [];
  const total = jobs.length || links.reduce((n, l) => n + (l.total || 0), 0);
  const done = jobs.length
    ? jobs.filter((j) => j.status === 'done').length
    : links.reduce((n, l) => n + Math.min(l.done || 0, l.total || 0), 0);
  const bad = jobs.filter((j) => j.status === 'error').length;
  const skipped = jobs.filter((j) => j.status === 'skipped').length;
  els.upPbar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  els.upStat.textContent = total
    ? `${done}/${total} фото в Flow${skipped ? ` · пропущено: ${skipped}` : ''}${bad ? ` · ошибок: ${bad}` : ''}`
    : '';

  els.upStatusList.innerHTML = '';
  if (!links.length) {
    els.upStatusList.classList.add('hidden');
    return;
  }
  els.upStatusList.classList.remove('hidden');
  for (const l of links) {
    const row = document.createElement('div');
    row.className = 'lq-row';
    const u = document.createElement('span');
    u.className = 'lq-url';
    u.textContent = (l.url || '').replace(/^https?:\/\/(www\.)?/, '');
    const s = document.createElement('span');
    s.className = `lq-st st-${l.status}`;
    // пока фото грузятся — показываем счётчик прямо в статусе
    s.textContent =
      l.status === 'uploading' && l.total
        ? `${l.done || 0}/${l.total}`
        : UP_RU[l.status] || l.status;
    row.append(u, s);
    if (l.note) row.title = `${UP_RU[l.status] || l.status}: ${l.note}`;
    els.upStatusList.append(row);
  }
}

els.upBtn.addEventListener('click', () => {
  const urls = parseUpLinks();
  if (!urls.length) {
    toast('Вставь ссылки в столбик', 'warn');
    return;
  }
  send({ type: 'START_UPLOAD', urls });
  toast(`Выгружаю ${urls.length} ссылок в Flow`, 'ok');
});

els.upStopBtn.addEventListener('click', () => send({ type: 'STOP_UPLOAD' }));

els.upSkipBtn.addEventListener('click', () => {
  send({ type: 'SKIP_LINK' });
  toast('Пропускаю текущую ссылку', 'warn', 1600);
});

els.upClearBtn.addEventListener('click', () => {
  els.upList.value = '';
  syncUpCount();
});

els.upList.addEventListener('input', syncUpCount);
try {
  els.upList.value = localStorage.getItem('fa_up_links') || '';
} catch {
  /* ignore */
}
syncUpCount();

function fmtAge(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return ' · только что';
  if (mins < 60) return ` · ${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return ` · ${hours} ч назад`;
  return ` · ${Math.floor(hours / 24)} дн назад`;
}

// выделение переживает закрытие панели (ключ — та же выгрузка)
function saveSel() {
  try {
    localStorage.setItem('fa_sel', JSON.stringify({ key: galleryKey, sel: [...sel] }));
  } catch {}
}
function restoreSel() {
  try {
    const o = JSON.parse(localStorage.getItem('fa_sel') || 'null');
    if (!o || o.key !== galleryKey || !Array.isArray(o.sel)) return;
    for (const i of o.sel) {
      if (thumbs[i]) {
        sel.add(i);
        thumbs[i].classList.add('sel');
      }
    }
  } catch {}
}

function resetGallery() {
  els.gallery.innerHTML = '';
  galleryKey = '';
  sel.clear();
  thumbs.length = 0;
  updateSelCount();
}

function buildGallery(posts) {
  els.gallery.innerHTML = '';
  sel.clear();
  thumbs.length = 0;
  let idx = 0;
  for (const post of posts) {
    for (const url of post.imageUrls) {
      const myIdx = idx;
      idx++;
      const div = document.createElement('div');
      div.className = 'thumb';
      div.dataset.idx = myIdx;
      div.dataset.url = url;
      div.style.animationDelay = `${Math.min(myIdx * 22, 400)}ms`;
      const img = document.createElement('img');
      img.src = url;
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.onerror = () => {
        div.style.opacity = '0.3';
      };
      const badge = document.createElement('span');
      badge.className = 'idx';
      badge.textContent = String(myIdx + 1);
      div.append(img, badge);
      div.addEventListener('click', () => {
        if (sel.has(myIdx)) {
          sel.delete(myIdx);
          div.classList.remove('sel');
        } else {
          sel.add(myIdx);
          div.classList.add('sel');
        }
        updateSelCount();
      });
      els.gallery.append(div);
      thumbs[myIdx] = div;
    }
  }
  restoreSel();
  updateSelCount();
}

function updateSelCount() {
  els.selCount.textContent = sel.size ? `выбрано: ${sel.size}` : '';
  saveSel();
  if (busyRun) return; // идёт прогон или выгрузка
  els.startBtn.disabled = !hasGallerySource() || !sel.size;
}

// ---- история промтов ----

async function loadHistory() {
  const res = await send({ type: 'GET_HISTORY' });
  renderHistory(res?.history || []);
}

function renderHistory(history) {
  els.historyList.innerHTML = '';
  els.histCount.textContent = history.length ? `${history.length} шт` : '';
  if (!history.length) {
    const n = document.createElement('div');
    n.className = 'empty-note';
    n.textContent = 'Пока пусто — запусти прогон с промтом, и он сохранится здесь';
    els.historyList.append(n);
    return;
  }
  for (const h of history) {
    const item = document.createElement('div');
    item.className = 'hist-item';
    const p = document.createElement('div');
    p.className = 'hp';
    p.textContent = h.prompt;
    const m = document.createElement('div');
    m.className = 'hm';
    const d = new Date(h.lastUsed);
    m.innerHTML = `<span>${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}</span><span>· прогонов: ${h.uses}</span>`;
    const x = document.createElement('div');
    x.className = 'hx';
    x.textContent = '✕';
    x.title = 'Удалить';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'DELETE_PROMPT_HISTORY', prompt: h.prompt }).then(() => loadHistory());
    });
    item.append(p, m, x);
    item.addEventListener('click', () => {
      els.prompt.value = h.prompt;
      document.querySelector('.tab[data-tab="work"]').click();
      toast('Промт вставлен', 'ok');
    });
    els.historyList.append(item);
  }
}

// ---- обработчики ----

els.grabBtn.addEventListener('click', async () => {
  if (!els.link.value.trim()) {
    toast('Вставь ссылку Threads', 'warn');
    return;
  }
  els.scrapeErr.textContent = '';
  resetGallery();
  await send({ type: 'SCRAPE', url: els.link.value });
  setTimeout(refresh, 800);
});

// переключение режима выгрузки: одна ссылка / столбик ссылок
let bulkMode = false;
function setBulkMode(on) {
  bulkMode = on;
  els.singleRow.classList.toggle('hidden', on);
  els.bulkList.classList.toggle('hidden', !on);
  els.bulkRow.style.display = on ? '' : 'none';
  els.scrapeModeHint.textContent = on ? 'столбик ссылок' : 'одна ссылка';
  els.modeSingle.classList.toggle('active', !on);
  els.modeBulk.classList.toggle('active', on);
  try {
    localStorage.setItem('fa_bulk_mode', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
els.modeSingle.addEventListener('click', () => setBulkMode(false));
els.modeBulk.addEventListener('click', () => setBulkMode(true));
try {
  setBulkMode(localStorage.getItem('fa_bulk_mode') === '1');
} catch {
  /* ignore */
}

els.bulkBtn.addEventListener('click', async () => {
  const urls = [
    ...new Set(
      els.bulkList.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!urls.length) {
    toast('Вставь ссылки в столбик', 'warn');
    return;
  }
  els.scrapeErr.textContent = '';
  resetGallery();
  await send({ type: 'BULK_SCRAPE', urls });
  toast(`Выгружаю ${urls.length} ссылок…`);
  setTimeout(refresh, 1200);
});

els.selectAll.addEventListener('click', () => {
  [...els.gallery.children].forEach((d) => {
    sel.add(+d.dataset.idx);
    d.classList.add('sel');
  });
  updateSelCount();
});

els.selVisible.addEventListener('click', () => {
  // массовая выгрузка даёт десятки фото — выделяем то, что сейчас на экране
  [...els.gallery.children].forEach((d) => {
    const r = d.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < window.innerHeight;
    if (inView) {
      sel.add(+d.dataset.idx);
      d.classList.add('sel');
    }
  });
  updateSelCount();
});

els.clearSel.addEventListener('click', () => {
  sel.clear();
  [...els.gallery.children].forEach((d) => d.classList.remove('sel'));
  updateSelCount();
});

els.useBase.addEventListener('change', () => {
  els.baseRow.style.display = els.useBase.checked ? '' : 'none';
  if (!els.useBase.checked) {
    baseImageData = null;
    els.baseFile.value = '';
  }
});

els.baseFile.addEventListener('change', () => {
  const f = els.baseFile.files?.[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    baseImageData = fr.result;
    toast('Базовая фотка загружена', 'ok');
  };
  fr.readAsDataURL(f);
});

els.clearBase.addEventListener('click', () => {
  baseImageData = null;
  els.baseFile.value = '';
  els.useBase.checked = false;
  els.baseRow.style.display = 'none';
});

els.startBtn.addEventListener('click', () => {
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    toast('Введи промт', 'warn');
    return;
  }
  if (!sel.size) {
    toast('Выбери фото', 'warn');
    return;
  }
  const selected = [...sel].sort((a, b) => a - b);
  // очередь получает индексы галереи — прокинем их в job для подсветки
  send({
    type: 'START_RUN',
    prompt,
    useBase: els.useBase.checked,
    baseImage: els.useBase.checked ? baseImageData : null,
    mode: els.mode.value,
    delaySec: parseInt(els.delay.value, 10) || 10,
    timeoutSec: parseInt(els.timeout.value, 10) || 180,
    retryCount: Math.max(0, parseInt(els.retryCount.value, 10) || 0),
    retryDelaySec: parseInt(els.retryDelay.value, 10) || 5,
    retryViaTile: els.retryViaTile.checked,
    autoDownload: els.autoDownload.checked,
    selected,
  });
  send({ type: 'SAVE_PROMPT_HISTORY', prompt });
  els.startBtn.disabled = true;
  toast(`Старт: ${selected.length} фото`, 'ok');
  document.querySelector('#runSec').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

els.pauseBtn.addEventListener('click', () => send({ type: 'PAUSE_RUN' }));
els.resumeBtn.addEventListener('click', () => send({ type: 'RESUME_RUN' }));
els.stopBtn.addEventListener('click', () => send({ type: 'STOP_RUN' }));
els.retryBtn.addEventListener('click', () => send({ type: 'RETRY_ERRORS' }));
els.diagBtn.addEventListener('click', () => send({ type: 'DIAGNOSE' }));
els.reloadFlowBtn.addEventListener('click', () => {
  toast('Перезагружаю вкладку Flow…');
  send({ type: 'RELOAD_FLOW_TAB' });
});
els.dumpBtn.addEventListener('click', () => {
  toast('Сохраняю дамп DOM Flow в Загрузки…');
  send({ type: 'DUMP_DOM' });
});
els.aimBtn.addEventListener('click', () => {
  toast('Кликни по белой стрелке в окне Flow');
  send({ type: 'CALIBRATE' });
});
els.selfBtn.addEventListener('click', () => {
  toast('Самотест: отчёт и скриншот уйдут в Загрузки');
  send({ type: 'SELFTEST' });
});

els.queueBtn.addEventListener('click', () => {
  const urls = parseLinks();
  const prompt = els.prompt.value.trim();
  if (!urls.length) {
    toast('Вставь ссылки в очередь', 'warn');
    return;
  }
  if (!prompt) {
    toast('Введи промт — он общий для всех ссылок', 'warn');
    return;
  }
  send({
    type: 'START_LINK_QUEUE',
    urls,
    prompt,
    useBase: els.useBase.checked,
    baseImage: els.useBase.checked ? baseImageData : null,
    mode: els.mode.value,
    delaySec: parseInt(els.delay.value, 10) || 10,
    timeoutSec: parseInt(els.timeout.value, 10) || 180,
    retryCount: Math.max(0, parseInt(els.retryCount.value, 10) || 0),
    retryDelaySec: parseInt(els.retryDelay.value, 10) || 5,
    retryViaTile: els.retryViaTile.checked,
    autoDownload: els.autoDownload.checked,
    maxPerLink: Math.max(0, parseInt(els.maxPerLink.value, 10) || 0),
  });
  send({ type: 'SAVE_PROMPT_HISTORY', prompt });
  els.queueBtn.disabled = true;
  toast(`Очередь: ${urls.length} ссылок`, 'ok');
  document.querySelector('#runSec').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

els.clearQueueBtn.addEventListener('click', () => {
  els.linkList.value = '';
  syncLinkCount();
  syncGalleryVisibility();
});

els.linkList.addEventListener('input', syncLinkCount);
els.prompt.addEventListener('input', syncLinkCount);
try {
  els.linkList.value = localStorage.getItem('fa_links') || '';
} catch {
  /* ignore */
}

// сохраняем промт и настройки
const SETTINGS_KEY = 'fa_settings_v1';
function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        delay: els.delay.value,
        timeout: els.timeout.value,
        retryCount: els.retryCount.value,
        retryDelay: els.retryDelay.value,
        retryViaTile: els.retryViaTile.checked,
        autoDownload: els.autoDownload.checked,
        mode: els.mode.value,
      }),
    );
  } catch {}
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!s) return;
    if (s.delay != null) els.delay.value = s.delay;
    if (s.timeout != null) els.timeout.value = s.timeout;
    if (s.retryCount != null) els.retryCount.value = s.retryCount;
    if (s.retryDelay != null) els.retryDelay.value = s.retryDelay;
    // retryViaTile принудительно выключаем: он кликал «повторить» на чужом
    // тайле и приносил ложные «готово». Старое сохранение игнорируем.
    els.retryViaTile.checked = false;
    if (s.autoDownload != null) els.autoDownload.checked = s.autoDownload;
    if (s.mode) els.mode.value = s.mode;
  } catch {}
}
els.prompt.addEventListener('input', () => {
  try {
    localStorage.setItem('fa_last_prompt', els.prompt.value);
  } catch {}
});
try {
  els.prompt.value = localStorage.getItem('fa_last_prompt') || '';
} catch {}
['delay', 'timeout', 'retryCount', 'retryDelay'].forEach((id) =>
  els[id].addEventListener('change', saveSettings),
);
['retryViaTile', 'autoDownload'].forEach((id) => els[id].addEventListener('change', saveSettings));
els.mode.addEventListener('change', saveSettings);
loadSettings();
syncLinkCount();

refresh();
