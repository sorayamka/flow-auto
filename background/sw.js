// Оркестратор: скрапинг Threads (прямой fetch + fallback через вкладку),
// очередь задач, связь side panel ↔ content-драйвер Flow, скачивание результатов.

// ---- парсер Threads (встроен, без ES-модулей — Chrome капризничает с type:module в SW) ----

function normalizeUsername(raw) {
  const s = (raw || '').trim();
  const m = s.match(/threads\.(?:com|net)\/@([A-Za-z0-9_.]+)/);
  if (m) return m[1];
  let t = s;
  if (t.startsWith('@')) t = t.slice(1);
  t = t.split('/')[0].split('?')[0];
  return /^[A-Za-z0-9._]{1,30}$/.test(t) ? t : null;
}

function parseThreadsHtml(html) {
  const rx = /<script type="application\/json"[^>]*data-sjs>(.*?)<\/script>/gs;
  const byId = new Map();
  const order = [];
  for (const m of html.matchAll(rx)) {
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch {
      continue;
    }
    collectRoots(json, (post) => {
      const made = makePost(post);
      if (made && !byId.has(made.id)) {
        byId.set(made.id, made);
        order.push(made.id);
      }
    });
  }
  return order.map((id) => byId.get(id));
}

function collectRoots(node, onRoot) {
  if (Array.isArray(node)) {
    for (const v of node) collectRoots(v, onRoot);
    return;
  }
  if (node && typeof node === 'object') {
    const items = node.thread_items;
    if (Array.isArray(items) && items.length) {
      for (const it of items) {
        if (it && it.post) onRoot(it.post);
      }
    }
    if (looksLikePost(node)) onRoot(node);
    // Медиа карусели и вложенный quoted_post не являются отдельными постами.
    if (!looksLikePost(node)) {
      for (const v of Object.values(node)) collectRoots(v, onRoot);
    }
  }
}

function looksLikePost(p) {
  return (
    typeof p.id === 'string' &&
    (Array.isArray(p.carousel_media) || !!p.image_versions2) &&
    (typeof p.taken_at === 'number' || !!p.caption || !!p.user)
  );
}

function makePost(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
  const urls = [];
  if (Array.isArray(p.carousel_media)) {
    for (const item of p.carousel_media) {
      const u = bestImage(item);
      if (u) urls.push(u);
    }
  }
  if (!urls.length) {
    const u = bestImage(p);
    if (u) urls.push(u);
  }
  if (!urls.length) return null;
  return {
    id: p.id,
    code: p.code || p.shortcode || '',
    username: p.user?.username || '',
    isReply: !!(
      p.text_post_app_info?.reply_to_author ||
      p.text_post_app_info?.reply_to_post_id ||
      p.reply_to_post_id
    ),
    caption: p?.caption?.text || '',
    imageUrls: urls,
    takenAt: Number(p.taken_at) || 0,
  };
}

function bestImage(obj) {
  const candidates = obj?.image_versions2?.candidates;
  if (!Array.isArray(candidates)) return null;
  let best = null;
  let bestW = 0;
  for (const c of candidates) {
    if (!c || typeof c.url !== 'string') continue;
    const w = Number(c.width) || 0;
    if (!best || w > bestW) {
      best = c.url;
      bestW = w;
    }
  }
  return best;
}

// ---- состояние ----
const state = {
  phase: 'idle', // idle | scraping | picking | running | paused | done
  username: '',
  posts: [], // [{id, caption, imageUrls, takenAt}]
  flat: [], // [{postIndex, imageIndex, imageUrl}] — порядок как в галерее панели
  queue: [], // [{jobId, imageUrl, status: pending|running|done|skipped|error|cancelled, note}]
  prompt: '',
  baseImage: null, // dataUrl заранее заданной фотки из промта (только session — тяжёлый)
  mode: 'image', // image | video
  delaySec: 10,
  timeoutSec: 180,
  retryCount: 1,
  retryDelaySec: 5,
  retryViaTile: true,
  autoDownload: true,
  sourceUrl: '', // исходная ссылка Threads для обновления протухших URL
  scrapedAt: 0, // когда выгрузили (подписанные URL CDN живут часы)
  results: [],
  linkQueue: [], // режим очереди ссылок: [{url, status: pending|scraping|running|done|error|cancelled, note}]
  maxPerLink: 0, // лимит фото на одну ссылку (0 = все)
  jobSeq: 0, // счётчик для уникальных jobId
  logs: [], // кольцевой буфер {t, text, level} — переживает рестарт, реплей в панели
  // режим «Выгрузка»: только фото в композер Flow, без промта и без Generate
  upLinks: [], // [{url, status: pending|scraping|uploading|done|error|cancelled, note, total, done}]
  upQueue: [], // [{jobId, imageUrl, postId, imageIndex, linkUrl, status, note}]
  uploadDelaySec: 2,
};

let flowTabId = null;
let driverReady = false;
let seenDriverVersion = null;
let driverCalibrated = false;
let driverWaiters = [];
let currentJob = null;

const FLOW_MATCH = /^https:\/\/(labs\.google|flow\.google\.com)\//;
// версия контент-скрипта: если вкладка держит старую, перезагружаем её,
// иначе все правки драйвера молча игнорируются (окно уже занято)
const DRIVER_VERSION = 'v3.9';

// ---- восстановление состояния после сна/перезапуска SW ----
// session-хранилище живёт до перезапуска браузера, local — переживает его.
// сообщения ждут завершения восстановления (restorePromise)
const LS_KEY = 'flowAutoPersist';

function persistSnapshot() {
  return {
    phase: state.phase,
    username: state.username,
    posts: state.posts,
    flat: state.flat,
    queue: state.queue,
    prompt: state.prompt,
    mode: state.mode,
    delaySec: state.delaySec,
    timeoutSec: state.timeoutSec,
    retryCount: state.retryCount,
    retryDelaySec: state.retryDelaySec,
    retryViaTile: state.retryViaTile,
    autoDownload: state.autoDownload,
    sourceUrl: state.sourceUrl,
    scrapedAt: state.scrapedAt,
    results: state.results,
    linkQueue: state.linkQueue,
    maxPerLink: state.maxPerLink,
    upLinks: state.upLinks,
    upQueue: state.upQueue,
    uploadDelaySec: state.uploadDelaySec,
    logs: (state.logs || []).slice(-120),
  };
}

async function loadPersisted() {
  try {
    const { flowAutoState } = await chrome.storage.session.get('flowAutoState');
    if (
      flowAutoState &&
      ((flowAutoState.flat || []).length || (flowAutoState.posts || []).length)
    ) {
      return flowAutoState;
    }
  } catch {
    /* нет session-состояния */
  }
  try {
    const o = await chrome.storage.local.get(LS_KEY);
    if (o && o[LS_KEY] && ((o[LS_KEY].flat || []).length || (o[LS_KEY].posts || []).length)) {
      return o[LS_KEY];
    }
  } catch {
    /* нет local-состояния */
  }
  return null;
}

const restorePromise = (async () => {
  try {
    const saved = await loadPersisted();
    if (saved) {
      Object.assign(state, saved, { baseImage: saved.baseImage ?? null });
      if (!Array.isArray(state.logs)) state.logs = [];
      else if (state.logs.length > 120) state.logs = state.logs.slice(-120);
      state.queue = (state.queue || []).map((j) =>
        j.status === 'running' ? { ...j, status: 'pending' } : j,
      );
      // очередь ссылок: незаконченную выгрузку начнём заново, «в работе»
      // закроем, если её задач уже не осталось
      state.linkQueue = (state.linkQueue || []).map((l) => {
        if (l.status === 'scraping') return { ...l, status: 'pending' };
        if (l.status === 'running') {
          const left = state.queue.some(
            (j) => j.linkUrl === l.url && (j.status === 'pending' || j.status === 'running'),
          );
          return { ...l, status: left ? 'running' : 'done' };
        }
        return l;
      });
      const pending = state.queue.filter((j) => j.status === 'pending').length;
      if (state.phase === 'uploading') {
        // выгрузку оборвал перезапуском фона — список ссылок на месте, но
        // довести его до конца можно только новым запуском из панели
        state.phase = 'idle';
        state.upQueue = (state.upQueue || []).map((j) =>
          j.status === 'uploading' ? { ...j, status: 'pending' } : j,
        );
        state.upLinks = (state.upLinks || []).map((l) =>
          ['scraping', 'uploading'].includes(l.status) ? { ...l, status: 'pending' } : l,
        );
        blog('Выгрузка в Flow была прервана перезапуском — запусти её заново кнопкой', 'warn');
      } else if (state.phase === 'running') {
        // прогон оборван перезапуском — расстикериваем в паузу, продолжение по кнопке
        state.phase = 'paused';
        blog(
          `Прогон был прерван перезапуском. В очереди осталось ${pending} задач — нажми «Дальше», чтобы продолжить.`,
          'warn',
        );
      } else if (pending || (state.posts || []).length) {
        blog(`Состояние восстановлено: фаза ${state.phase}, в очереди ${pending} задач`);
      }
      notifyPanel();
    }
  } catch {
    /* нет сохранённого состояния */
  }
})();

async function persist() {
  const snap = persistSnapshot();
  try {
    await chrome.storage.session.set({
      flowAutoState: { ...snap, baseImage: state.baseImage },
    });
  } catch {
    /* сессия закрыта */
  }
  try {
    await chrome.storage.local.set({ [LS_KEY]: snap });
  } catch {
    /* local недоступен */
  }
}

// ---- утилиты ----
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// лог: в память + персист + рассылка. История видна даже после переоткрытия панели.
function blog(text, level = 'info') {
  try {
    state.logs.push({ t: Date.now(), text: String(text), level });
    if (state.logs.length > 150) state.logs.splice(0, state.logs.length - 150);
  } catch {
    /* ignore */
  }
  send({ type: 'LOG', text, level });
}
const notifyPanel = () => {
  persist();
  send({ type: 'STATE', state: snapshot() });
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// fetch с жёстким таймаутом: зависший CDN/сеть не должны вешать очередь навсегда
async function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError')
      throw new Error(`Сеть висит дольше ${Math.round(ms / 1000)}с: ${url.slice(0, 80)}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// промис с таймаутом (для sendMessage без собственного лимита)
function withTimeout(promise, ms, message) {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer));
}

// держит SW живым, пока висит долгожданный промис:
// каждая запись в storage — активность для Chrome, сбрасывает 30с idle-таймер
async function keepAliveWhile(promise) {
  const beat = setInterval(() => {
    try {
      chrome.storage.session.set({ faAlive: Date.now() });
    } catch {
      /* ignore */
    }
  }, 15000);
  try {
    return await promise;
  } finally {
    clearInterval(beat);
  }
}

// сон кусками с пингом chrome API — голый долгий sleep даёт SW уснуть навсегда
async function sleepAlive(
  ms,
  isAlive = () => state.phase === 'running' || state.phase === 'paused',
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(Math.min(20000, end - Date.now()));
    if (!isAlive()) break;
    try {
      chrome.storage.session.set({ faAlive: Date.now() });
    } catch {
      /* ignore */
    }
  }
}

function snapshot() {
  return {
    phase: state.phase,
    build: chrome.runtime.getManifest().version,
    driverVersion: seenDriverVersion,
    needDriver: DRIVER_VERSION,
    calibrated: driverCalibrated,
    username: state.username,
    posts: state.posts,
    flat: state.flat,
    queue: state.queue,
    prompt: state.prompt,
    hasBaseImage: !!state.baseImage,
    mode: state.mode,
    delaySec: state.delaySec,
    scrapedAt: state.scrapedAt || 0,
    logs: (state.logs || []).slice(-100),
    results: state.results,
    linkQueue: state.linkQueue,
    maxPerLink: state.maxPerLink,
    upLinks: state.upLinks,
    upQueue: state.upQueue,
  };
}

// ---- скрапинг Threads ----

function parseLink(raw) {
  const s = (raw || '').trim();
  let m = s.match(/threads\.(?:com|net)\/((?:@[^/?]+)\/)?(post|p|t)\/([A-Za-z0-9_-]+)/);
  if (m) {
    const seg = m[2] === 'p' ? 'post' : m[2];
    return { kind: 'post', code: m[3], url: `https://www.threads.com/${m[1] || ''}${seg}/${m[3]}` };
  }
  m = s.match(/threads\.(?:com|net)\/@([A-Za-z0-9_.]+)(?:\/?(?:[?#].*)?)$/);
  if (m) return { kind: 'profile', username: m[1] };
  // короткая ссылка из буфера: threads.com/share/_jJtzsbVt/
  m = s.match(/threads\.(?:com|net)\/share\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: 'share', code: m[1] };
  const name = normalizeUsername(s);
  if (name) return { kind: 'profile', username: name };
  return null;
}

function imageIdentity(raw) {
  try {
    // CDN меняет подпись, размер и поддомен, но имя исходного файла сохраняется.
    const url = new URL(raw);
    return /(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)
      ? url.pathname.split('/').pop()
      : url.origin + url.pathname;
  } catch {
    return raw;
  }
}

function selectSourcePosts(posts, target) {
  let selected;
  if (target.kind === 'profile') {
    selected = posts.filter(
      (p) => !p.isReply && p.username?.toLowerCase() === target.username.toLowerCase(),
    );
  } else if (target.code) {
    // Threads shortcode кодирует числовой media id (без суффикса автора).
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const ch of target.code) id = id * 64n + BigInt(alphabet.indexOf(ch));
    selected = posts.filter((p) => p.code === target.code || p.id.split('_')[0] === String(id));
  } else {
    // Неразвёрнутая share-ссылка: только корень треда, не вся дискуссия.
    selected = posts.filter((p) => !p.isReply).slice(0, 1);
  }
  const seenPosts = new Set();
  const seenImages = new Set();
  return selected
    .filter((p) => {
      const id = p.id.split('_')[0];
      if (seenPosts.has(id)) return false;
      seenPosts.add(id);
      return true;
    })
    .map((p) => ({
      ...p,
      imageUrls: p.imageUrls.filter((url) => {
        const key = imageIdentity(url);
        if (seenImages.has(key)) return false;
        seenImages.add(key);
        return true;
      }),
    }))
    .filter((p) => p.imageUrls.length);
}

// короткая ссылка /share/ — это НЕ редирект, а страница-заглушка.
// Настоящий адрес поста лежит в <link rel="canonical"> / og:url.
async function resolveShareTarget(target) {
  const shareUrl = `https://www.threads.com/share/${target.code}`;
  try {
    await ensureSessionRules();
    const resp = await fetchWithTimeout(
      shareUrl,
      { credentials: 'omit', cache: 'no-store', redirect: 'follow' },
      30000,
    );
    const html = (await resp.ok) ? await resp.text() : '';
    const raw =
      (html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) || [])[1] ||
      (html.match(/property="og:url"[^>]+content="([^"]+)"/i) || [])[1] ||
      '';
    if (raw) {
      const clean = raw
        .replace(/&#0?64;/g, '@')
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/');
      // вид @/post/... — автор скрыт, такой адрес бесполезен,
      // оставляем share-ссылку: вкладка с сессией её развернёт сама
      if (/threads\.(com|net)\/@[^/]+\/post\/[A-Za-z0-9_-]+/.test(clean)) {
        const real = parseLink(clean);
        if (real && real.kind === 'post') return real;
      }
    }
    if (html) {
      const posts = parseThreadsHtml(html);
      if (posts.length) return { kind: 'post', url: shareUrl, preloaded: posts };
    }
  } catch (e) {
    blog(`Короткую ссылку не развернул (${e.message}) — открою вкладкой`, 'warn');
  }
  // запасной путь: вкладка сама перейдёт по редиректу и подгрузит данные
  return { kind: 'post', url: shareUrl };
}

function targetUrl(target) {
  return target.kind === 'profile' ? `https://www.threads.com/@${target.username}` : target.url;
}

async function scrapeDirect(target) {
  await ensureSessionRules();
  const url = targetUrl(target);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const resp = await fetchWithTimeout(url, { credentials: 'omit', cache: 'reload' }, 45000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const posts = parseThreadsHtml(html);
      if (posts.length) return posts;
      const sjsCount = (html.match(/data-sjs/g) || []).length;
      const tiCount = (html.match(/thread_items/g) || []).length;
      lastErr = new Error(
        `Пусто в data-sjs (html ${html.length} б, data-sjs: ${sjsCount}, thread_items: ${tiCount})`,
      );
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function waitTabComplete(tabId, timeoutMs = 30000) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.status === 'complete') return;
  } catch {
    /* вкладки уже нет — ждём событие */
  }
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
  });
}

async function scrapeViaTab(target) {
  const url = targetUrl(target);
  const tabs = await chrome.tabs.query({ url: 'https://www.threads.com/*' });
  let tab = tabs[0];
  if (tab) await chrome.tabs.update(tab.id, { url, active: false });
  else tab = await chrome.tabs.create({ url, active: false });
  await waitTabComplete(tab.id);
  const attempts = 3;
  let lastResp = null;
  for (let i = 0; i < attempts; i++) {
    await sleep(4000 + i * 3000);
    const resp = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: 'GRAB_FROM_TAB' }).catch(() => null),
      25000,
      'GRAB_TIMEOUT',
    ).catch(() => null);
    if (resp?.ok && resp.posts?.length) {
      const resolved = parseLink(resp.url || '');
      const posts = selectSourcePosts(resp.posts, resolved?.kind === 'post' ? resolved : target);
      if (posts.length) return posts;
    }
    lastResp = resp;
    // страница могла не досгрузиться — перезагружаем вкладку между попытками
    if (i < attempts - 1) {
      try {
        await chrome.tabs.reload(tab.id);
        await waitTabComplete(tab.id);
      } catch {
        /* ок */
      }
    }
  }
  const diag = lastResp
    ? `скриптов data-sjs: ${lastResp.scripts ?? 0}`
    : 'вкладка не ответила (контент-скрипт не загружен — перезагрузи расширение)';
  throw new Error(`Вкладка Threads не отдала посты (${diag})`);
}

function flattenPosts(posts) {
  const flat = [];
  posts.forEach((p, pi) => {
    p.imageUrls.forEach((u, ii) =>
      flat.push({ postIndex: pi, imageIndex: ii, imageUrl: u, linkUrl: p.sourceLink || '' }),
    );
  });
  return flat;
}

// общий скрап по ссылке: { posts, username } или throw
async function doScrape(rawUrl) {
  let target = parseLink(rawUrl);
  if (!target)
    throw new Error(
      'Не понял ссылку. Нужна ссылка на аккаунт, пост Threads или короткая ссылка /share/…',
    );
  if (target.kind === 'share') {
    const code = target.code;
    target = await resolveShareTarget(target);
    blog(`Короткая ссылка /share/${code} → ${shortUrl(target.url || '')}`, 'info');
  }
  let posts = selectSourcePosts(target.preloaded || [], target);
  if (posts.length) {
    // данные уже распознаны при разворачивании ссылки
  } else {
    try {
      posts = selectSourcePosts(await scrapeDirect(target), target);
      if (!posts.length) throw new Error('У исходного поста не найдено фото');
    } catch (directErr) {
      blog(`Прямой fetch не сработал (${directErr.message}), пробую через вкладку Threads`, 'warn');
      posts = await scrapeViaTab(target);
    }
  }
  // SSR мог отдать только первый пост ленты — вкладка после гидратации видит больше
  if (target.kind === 'profile' && posts.length < 2) {
    try {
      const viaTab = await scrapeViaTab(target);
      if (viaTab.length > posts.length) {
        blog(
          `Прямая выгрузка дала мало (${posts.length}), через вкладку нашёл ${viaTab.length}`,
          'warn',
        );
        posts = viaTab;
      }
    } catch {
      /* вкладка не обязательна — оставляем что есть */
    }
  }
  posts = selectSourcePosts(posts, target);
  if (!posts.length) {
    throw new Error('Не удалось получить посты: аккаунт может быть закрытым или пустым');
  }
  return { posts, username: target.kind === 'profile' ? target.username : target.url };
}

// перенос выбора со старых flat-индексов на свежую выгрузку:
// сначала по id поста + номеру картинки, иначе по тем же позициям
function remapSelection(oldFlat, oldPosts, newPosts, selected) {
  const newFlat = flattenPosts(newPosts);
  const byKey = new Map();
  newFlat.forEach((f, ni) => {
    const p = newPosts[f.postIndex];
    byKey.set(`${p.id}#${f.imageIndex}`, ni);
  });
  const mapped = [];
  let lost = 0;
  for (const si of selected || []) {
    const old = oldFlat[si];
    let ni = null;
    if (old) {
      const oldPost = oldPosts[old.postIndex];
      if (oldPost) ni = byKey.get(`${oldPost.id}#${old.imageIndex}`) ?? null;
      if (ni == null && si < newFlat.length) ni = si; // запасной путь: та же позиция
    }
    if (ni == null) lost++;
    else mapped.push(ni);
  }
  return { mapped, lost };
}

// обновить URL одного фото из свежей выгрузки (для протухших CDN-ссылок)
async function refreshImageUrl(job, rawUrl) {
  const { posts } = await doScrape(rawUrl);
  const oldPost = state.posts[job.postIndex];
  let nu = null;
  if (oldPost) {
    const np = posts.find((p) => p.id === oldPost.id) || posts[job.postIndex];
    if (np && np.imageUrls[job.imageIndex]) nu = np.imageUrls[job.imageIndex];
  }
  if (!nu) throw new Error('фото не найдено в обновлённой выгрузке');
  state.posts = posts;
  state.flat = flattenPosts(posts);
  state.scrapedAt = Date.now();
  job.imageUrl = nu;
  notifyPanel();
  return nu;
}

// ---- вкладка Flow и драйвер ----

async function getFlowTab() {
  if (flowTabId !== null) {
    try {
      const tab = await chrome.tabs.get(flowTabId);
      if (tab && FLOW_MATCH.test(tab.url || '')) return tab;
    } catch {
      /* вкладка исчезла */
    }
    flowTabId = null;
  }
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/*', 'https://flow.google.com/*'],
  });
  // предпочитаем активную вкладку — пользователь смотрит на неё, путаницы меньше
  const live = tabs.filter((t) => !t.discarded);
  const active = live.find((t) => t.active) || live[0];
  if (active) {
    flowTabId = active.id;
    return active;
  }
  if (tabs.length) {
    // все вкладки выгружены из памяти — будим первую
    try {
      await chrome.tabs.reload(tabs[0].id);
      await waitTabComplete(tabs[0].id);
      flowTabId = tabs[0].id;
      return chrome.tabs.get(flowTabId);
    } catch {
      /* не разбудили — откроем новую */
    }
  }
  const tab = await chrome.tabs.create({ url: 'https://flow.google.com/', active: true });
  flowTabId = tab.id;
  await waitTabComplete(tab.id);
  await sleep(3000);
  return chrome.tabs.get(flowTabId);
}

let flowTabReloadedForVersion = false;

async function ensureDriver(tabId) {
  const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null);
  if (pong && pong.version === DRIVER_VERSION) {
    driverReady = true;
    if (typeof pong.calibrated === 'boolean') driverCalibrated = pong.calibrated;
    return;
  }
  // драйвера нет вовсе — вживляем
  if (!pong) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/flow-driver.js'],
      });
    } catch (e) {
      throw new Error(`Не вживил драйвер во вкладку Flow: ${e.message}`);
    }
    await waitForDriver(15000);
    return;
  }
  // драйвер есть, но старый: перезагружаем вкладку ровно один раз за сессию,
  // иначе рискуем уйти в бесконечный цикл перезагрузок
  if (flowTabReloadedForVersion) {
    // уже перезагружали — но продолжим на том, что есть, лишь предупредим
    blog(
      `Драйвер ${pong.version || 'без версии'}, нужен ${DRIVER_VERSION} — работаю как есть`,
      'warn',
    );
    driverReady = true;
    return;
  }
  blog(
    `Вкладка Flow со старым драйвером (${pong.version || 'без версии'}) — перезагружаю один раз`,
    'warn',
  );
  flowTabReloadedForVersion = true;
  driverReady = false;
  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
    await waitTabComplete(tabId, 45000);
    await sleep(3000);
  } catch (e) {
    throw new Error(`Не смог перезагрузить вкладку Flow: ${e.message}`);
  }
  const pong2 = await chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null);
  if (pong2) {
    // версия всё ещё старая — но рабочий драйвер лучше, чем отказ по каждой задаче:
    // фото он по-прежнему крепит, предупреждаем и работаем на нём
    blog(
      `Драйвер в вкладке ${pong2.version || 'без версии'}, нужен ${DRIVER_VERSION} — ` +
        `работаю на нём, правки Generate могут не примениться. Закрой вкладку Flow и открой заново.`,
      'warn',
    );
    driverReady = true;
    return;
  }
  throw new Error(
    `После перезагрузки драйвер не ответил. Закрой вкладку Flow целиком и открой заново.`,
  );
}

function waitForDriver(timeoutMs = 30000) {
  if (driverReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    driverWaiters.push(resolve);
    setTimeout(() => reject(new Error('Драйвер Flow не ответил')), timeoutMs);
  });
}

async function callDriver(payload, timeoutMs = 0) {
  const tab = await getFlowTab();
  if (tab.id !== lastFlowTabId) {
    lastFlowTabId = tab.id;
    blog(`Вкладка Flow: #${tab.id} ${(tab.url || '').slice(0, 70)}`);
  }
  await keepAliveWhile(ensureDriver(tab.id));
  const sendP = chrome.tabs.sendMessage(tab.id, payload);
  if (!timeoutMs) return keepAliveWhile(sendP);
  let timer;
  try {
    return await keepAliveWhile(
      Promise.race([
        sendP,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('DRIVER_TIMEOUT')), timeoutMs);
        }),
      ]),
    );
  } finally {
    clearTimeout(timer);
  }
}

let lastFlowTabId = null;

// ---- очередь ----

let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (state.phase === 'running') {
      let job = state.queue.find((j) => j.status === 'pending');
      if (!job) {
        // режим очереди ссылок: выгружаем следующую и докладываем задачи
        const nextLink = (state.linkQueue || []).find((l) => l.status === 'pending');
        if (nextLink) {
          await loadLinkIntoQueue(nextLink);
          job = state.queue.find((j) => j.status === 'pending');
        }
      }
      if (!job) {
        state.phase = 'done';
        // честный итог: пользователь должен видеть, сколько реально готово
        const st = {};
        for (const j of state.queue) st[j.status] = (st[j.status] || 0) + 1;
        const bad = (st.error || 0) + (st.skipped || 0) + (st.cancelled || 0);
        if (bad) {
          blog(
            `Прогон закончен: готово ${st.done || 0}, ошибок ${st.error || 0}, ` +
              `пропущено ${st.skipped || 0}, отменено ${st.cancelled || 0}. ` +
              `Красные превью можно погнать заново кнопкой «Повторить ошибки»`,
            'warn',
          );
        } else {
          blog(`Прогон закончен: все ${st.done || 0} фото готовы`, 'ok');
        }
        notifyPanel();
        break;
      }
      currentJob = job;
      job.status = 'running';
      notifyPanel();
      try {
        await processJob(job);
      } catch (e) {
        job.status = 'error';
        job.note = e.message;
        blog(`Ошибка: ${e.message}`, 'error');
      }
      currentJob = null;
      checkLinkDone(job.linkUrl);
      notifyPanel();
      if (state.phase !== 'running') break;
      await sleepAlive(Math.max(2, state.delaySec) * 1000);
    }
  } catch (e) {
    blog(`Очередь упала: ${e.message}`, 'error');
    state.phase = 'done';
    notifyPanel();
  } finally {
    running = false;
  }
}

// ---- очередь ссылок ----

function shortUrl(u) {
  return (u || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 52);
}

// выгрузить одну ссылку и положить её фото в общую очередь задач
async function loadLinkIntoQueue(link) {
  link.status = 'scraping';
  notifyPanel();
  try {
    const { posts } = await doScrape(link.url);
    const flat = flattenPosts(posts);
    const max = Math.max(0, state.maxPerLink || 0);
    const items = max ? flat.slice(0, max) : flat;
    const jobs = items.map((item) => ({
      jobId: `j${Date.now()}_${++state.jobSeq}`,
      imageUrl: item.imageUrl,
      postIndex: item.postIndex,
      imageIndex: item.imageIndex,
      flatIdx: flat.indexOf(item),
      linkUrl: link.url,
      status: 'pending',
    }));
    state.posts = posts;
    state.flat = flat;
    state.sourceUrl = link.url;
    state.scrapedAt = Date.now();
    state.queue.push(...jobs);
    link.status = 'running';
    link.note = `${jobs.length} фото`;
    blog(`«${shortUrl(link.url)}»: ${posts.length} постов, в очередь → ${jobs.length} фото`);
    if (!jobs.length) {
      // фото нет, но и зависать ссылка не должна
      link.status = 'done';
      link.note = 'нет фото';
    }
    return true;
  } catch (e) {
    link.status = 'error';
    link.note = e.message;
    blog(`«${shortUrl(link.url)}»: ${e.message} — иду к следующей ссылке`, 'error');
    return false;
  } finally {
    notifyPanel();
  }
}

// пометить ссылку готовой, когда все её задачи закрылись
function checkLinkDone(linkUrl) {
  if (!linkUrl || !Array.isArray(state.linkQueue)) return;
  const link = state.linkQueue.find((l) => l.url === linkUrl);
  if (!link || link.status !== 'running') return;
  const left = state.queue.some(
    (j) => j.linkUrl === linkUrl && (j.status === 'pending' || j.status === 'running'),
  );
  if (!left) link.status = 'done';
}

// ---- режим «Выгрузка»: только фото в Flow, без промта и без генерации ----
// Ссылки идут строго по порядку, фото внутри ссылки — тоже. Промт не трогаем,
// Generate не жмём, чипы не снимаем: фото просто копятся в композере Flow,
// дальше пользователь решает сам, что с ними делать.

let uploading = false;

async function runUpload() {
  if (uploading) return;
  uploading = true;
  try {
    while (state.phase === 'uploading') {
      let job = state.upQueue.find((j) => j.status === 'pending');
      if (!job) {
        const next = state.upLinks.find((l) => l.status === 'pending');
        if (next) {
          await loadUploadLink(next);
          if (state.phase !== 'uploading') break;
          job = state.upQueue.find((j) => j.status === 'pending');
          if (!job && state.upLinks.some((l) => l.status === 'pending')) continue;
        }
      }
      if (!job) {
        state.phase = 'done';
        const st = {};
        for (const j of state.upQueue) st[j.status] = (st[j.status] || 0) + 1;
        const linksOk = state.upLinks.filter((l) => l.status === 'done').length;
        const linksSkip = state.upLinks.filter((l) => l.status === 'skipped').length;
        const bad = (st.error || 0) + (st.cancelled || 0);
        blog(
          `Выгрузка закончена: ссылок ${linksOk}/${state.upLinks.length}` +
            (linksSkip ? `, пропущено ${linksSkip}` : '') +
            `, фото в Flow ${st.done || 0}` +
            (st.skipped ? `, пропущено фото ${st.skipped}` : '') +
            (bad ? `, не загружено ${bad}` : ''),
          bad ? 'warn' : 'ok',
        );
        notifyPanel();
        break;
      }
      job.status = 'uploading';
      notifyPanel();
      try {
        const res = await attachPhotoToFlow(job);
        job.status = 'done';
        job.note = res?.note || 'в Flow';
        const link = state.upLinks.find((l) => l.url === job.linkUrl);
        if (link) link.done = (link.done || 0) + 1;
      } catch (e) {
        job.status = 'error';
        job.note = e.message;
        blog(`«${shortUrl(job.linkUrl)}»: ${e.message} — иду дальше`, 'error');
      }
      checkUploadLinkDone(job.linkUrl);
      notifyPanel();
      if (state.phase !== 'uploading') break;
      await sleepAlive(
        Math.max(0, state.uploadDelaySec || 0) * 1000,
        () => state.phase === 'uploading',
      );
    }
  } catch (e) {
    blog(`Выгрузка упала: ${e.message}`, 'error');
    state.phase = 'done';
    notifyPanel();
  } finally {
    uploading = false;
  }
}

// выгрузить одну ссылку: её фото становятся задачами загрузки в Flow
async function loadUploadLink(link) {
  link.status = 'scraping';
  link.total = 0;
  link.done = 0;
  link.note = '';
  notifyPanel();
  try {
    const { posts } = await doScrape(link.url);
    const jobs = [];
    const seen = new Set(
      state.upQueue
        .filter((j) => !['skipped', 'cancelled', 'error'].includes(j.status))
        .map((j) => j.imageKey || imageIdentity(j.imageUrl)),
    );
    for (const p of posts) {
      p.imageUrls.forEach((u, ii) => {
        const imageKey = imageIdentity(u);
        if (seen.has(imageKey)) return;
        seen.add(imageKey);
        jobs.push({
          jobId: `u${Date.now()}_${++state.jobSeq}`,
          imageUrl: u,
          imageKey,
          postId: p.id,
          imageIndex: ii,
          linkUrl: link.url,
          status: 'pending',
          note: '',
        });
      });
    }
    state.upQueue.push(...jobs);
    link.total = jobs.length;
    // «Дальше» могли нажать, пока ссылка ещё выгружалась — уважаем это,
    // иначе фото всё равно поедут в Flow, хотя пользователь их уже отменил
    if (link.skip) {
      for (const j of jobs) j.status = 'skipped';
      link.status = 'skipped';
      link.note = 'пропущено';
      blog(`«${shortUrl(link.url)}»: пропущено, ${jobs.length} фото не грузил`, 'info');
      return;
    }
    link.status = 'uploading';
    blog(`«${shortUrl(link.url)}»: ${posts.length} постов, ${jobs.length} фото в Flow`);
    if (!jobs.length) {
      link.status = 'done';
      link.note = 'нет фото';
    }
  } catch (e) {
    link.status = 'error';
    link.note = e.message;
    blog(`«${shortUrl(link.url)}»: ${e.message} — иду к следующей ссылке`, 'error');
  } finally {
    notifyPanel();
  }
}

function checkUploadLinkDone(linkUrl) {
  if (!linkUrl || !Array.isArray(state.upLinks)) return;
  const link = state.upLinks.find((l) => l.url === linkUrl);
  if (!link || link.status !== 'uploading') return;
  const left = state.upQueue.some(
    (j) => j.linkUrl === linkUrl && (j.status === 'pending' || j.status === 'uploading'),
  );
  if (left) return;
  link.status = 'done';
  if (!link.note) link.note = `${link.done || 0} фото в Flow`;
}

// протухший URL фото: перевыгружаем ссылку и берём тот же кадр по id поста
async function refreshUploadImageUrl(job) {
  const { posts } = await doScrape(job.linkUrl);
  const post = posts.find((p) => p.id === job.postId);
  const fresh = post?.imageUrls?.[job.imageIndex];
  if (!fresh) throw new Error('фото не найдено в обновлённой выгрузке');
  return fresh;
}

async function attachPhotoToFlow(job) {
  let dataUrl;
  try {
    dataUrl = await fetchAsDataUrl(job.imageUrl);
  } catch (e) {
    // подписанные URL Threads протухают за часы — обновляем выгрузку и повторяем один раз
    if (!/HTTP 40[13]/.test(e.message) || !job.linkUrl || job._refreshed) throw e;
    job._refreshed = true;
    blog('Ссылка на фото протухла (403) — обновляю выгрузку и повторяю…', 'warn');
    job.imageUrl = await refreshUploadImageUrl(job);
    dataUrl = await fetchAsDataUrl(job.imageUrl);
  }
  const payload = {
    type: 'ATTACH_ONLY',
    jobId: job.jobId,
    name: `flow-auto-up-${job.jobId}.jpg`,
    imageDataUrl: dataUrl,
  };
  let res;
  try {
    res = await callDriver(payload, 150000);
  } catch (e) {
    // вкладка могла уснуть или перезагрузиться — переподключаемся и пробуем раз
    blog(`Связь с драйвером оборвалась (${e.message}), переподключаюсь…`, 'warn');
    driverReady = false;
    flowTabId = null;
    res = await callDriver(payload, 150000).catch((e2) => ({
      ok: false,
      note:
        e2.message === 'DRIVER_TIMEOUT'
          ? 'драйвер молчит дольше лимита — проверь вкладку Flow'
          : `драйвер недоступен: ${e2.message}`,
    }));
  }
  if (!res?.ok) throw new Error(res?.note || 'Flow не принял фото');
  return res;
}

async function processJob(job) {
  blog('Готовлю фото и подключаюсь к Flow…');
  let threadDataUrl;
  try {
    threadDataUrl = await fetchAsDataUrl(job.imageUrl);
  } catch (e) {
    // подписанные URL Threads протухают за часы — обновляем выгрузку и повторяем один раз
    if (!/HTTP 40[13]/.test(e.message) || !state.sourceUrl || job._refreshed) throw e;
    job._refreshed = true;
    blog('Ссылка на фото протухла (403) — обновляю выгрузку и повторяю…', 'warn');
    await refreshImageUrl(job, job.linkUrl || state.sourceUrl);
    threadDataUrl = await fetchAsDataUrl(job.imageUrl);
  }
  const maxRetries = state.retryCount ?? 0;
  const retryDelay = state.retryDelaySec ?? 5;
  let attempt = 0;
  let res = null;

  while (true) {
    attempt++;
    if (attempt > 1) {
      blog(`Повтор ${attempt - 1}/${maxRetries} (пауза ${retryDelay} c)…`, 'warn');
      await sleepAlive(Math.max(1, retryDelay) * 1000);
      job.status = 'running';
      job.note = `попытка ${attempt}`;
      notifyPanel();
    }
    try {
      // таймаут = ожидание генерации + 3 мин запаса: драйвер не должен молчать вечно
      // (например, вкладку перезагрузили посреди задачи)
      const driverTimeout = (state.timeoutSec || 180) * 1000 + 180000;
      res = await callDriver(
        {
          type: 'RUN_JOB',
          mode: state.mode,
          timeoutSec: state.timeoutSec,
          prompt: state.prompt,
          baseImage: state.baseImage,
          threadImage: threadDataUrl,
          jobId: job.jobId,
          expectedImages: (state.baseImage ? 1 : 0) + 1,
          retryHint: attempt > 1 && state.retryViaTile !== false,
        },
        driverTimeout,
      );
    } catch (e) {
      if (e.message === 'DRIVER_TIMEOUT') {
        res = { ok: false, note: 'Драйвер замолчал (вкладка перезагружена?) — повторю задачу' };
        driverReady = false;
        flowTabId = null;
      } else {
        // вкладка могла умереть/уснуть — переподключение
        blog(`Связь с драйвером оборвалась (${e.message}), переподключаюсь…`, 'warn');
        driverReady = false;
        flowTabId = null;
        try {
          const driverTimeout = (state.timeoutSec || 180) * 1000 + 180000;
          res = await callDriver(
            {
              type: 'RUN_JOB',
              mode: state.mode,
              timeoutSec: state.timeoutSec,
              prompt: state.prompt,
              baseImage: state.baseImage,
              threadImage: threadDataUrl,
              jobId: job.jobId,
              expectedImages: (state.baseImage ? 1 : 0) + 1,
              retryHint: attempt > 1 && state.retryViaTile !== false,
            },
            driverTimeout,
          );
        } catch (e2) {
          res =
            e2.message === 'DRIVER_TIMEOUT'
              ? { ok: false, note: 'Драйвер молчит дольше лимита — проверь вкладку Flow' }
              : { ok: false, note: `Драйвер недоступен: ${e2.message}` };
        }
      }
    }

    const retryable = !res?.ok && !res?.fatal;
    if (retryable && attempt <= maxRetries) continue;
    break;
  }

  if (!res || !res.ok) {
    job.status = res?.skipped ? 'skipped' : 'error';
    job.note = res?.note || 'Flow не вернул результат';
    if (attempt > 1) job.note += ` (после ${attempt - 1} повторов)`;
    blog(`Пропущено/ошибка: ${job.note}`, 'warn');
    return;
  }
  job.status = 'done';
  job.note = res.note || '';
  const resultUrl = res.resultUrl || null;
  state.results.push({
    jobId: job.jobId,
    imageUrl: job.imageUrl,
    resultUrl,
    note: job.note,
    ts: Date.now(),
    prompt: state.prompt,
  });
  // в историю промтов
  const hist = (await chrome.storage.local.get('faHistory')).faHistory || [];
  const key = state.prompt.trim();
  const entry = hist.find((h) => h.prompt === key);
  if (entry) {
    entry.uses += 1;
    entry.lastUsed = Date.now();
  } else {
    hist.unshift({ prompt: key, uses: 1, lastUsed: Date.now() });
  }
  await chrome.storage.local.set({ faHistory: hist.slice(0, 30) });
  // скачивание
  if (resultUrl && state.autoDownload !== false) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    // Windows не терпит <>:"/\|?* в именах — вычищаем
    const tail = (resultUrl.split('/').pop() || 'flow-result')
      .split('?')[0]
      .slice(0, 40)
      .replace(/[<>:"/\\|?*]/g, '');
    try {
      await Promise.resolve(
        chrome.downloads.download({ url: resultUrl, filename: `flow-auto/${stamp}_${tail}` }),
      );
    } catch (e) {
      blog(
        `Не скачалось автоматически (${e.message}) — забери результат из вкладки Flow вручную`,
        'warn',
      );
    }
  }
  blog(`Готово: ${res.note || 'ок'}`);
}

async function fetchAsDataUrl(url) {
  await ensureSessionRules();
  const resp = await fetchWithTimeout(url, { credentials: 'omit', cache: 'reload' }, 60000);
  if (!resp.ok) throw new Error(`Не скачал фото Threads: HTTP ${resp.status}`);
  const blob = await resp.blob();
  return await blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  // FileReader в MV3 service worker недоступен (это не DOM-контекст),
  // поэтому читаем ArrayBuffer и кодируем вручную — работает на любой платформе.
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000; // String.fromCharCode.apply дробится порогами стека
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
  });
}

// ---- DNR session-правила (только для запросов самого расширения, tabId -1) ----
// 1) Threads отдаёт SSR-HTML с data-sjs только Googlebot'у — как в Swift-граббере.
// 2) CDN-картинки требуют Referer threads.com — как RemoteImageView в Swift-граббере.
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SESSION_RULE_IDS = [9001, 9002];

async function installSessionRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: SESSION_RULE_IDS,
    addRules: [
      {
        id: 9001,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: GOOGLEBOT_UA },
            { header: 'Referer', operation: 'remove' },
            { header: 'Cookie', operation: 'remove' },
          ],
        },
        condition: {
          requestDomains: ['threads.com', 'threads.net'],
          resourceTypes: ['xmlhttprequest'],
          tabIds: [-1],
        },
      },
      {
        id: 9002,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.threads.com/' },
          ],
        },
        condition: {
          requestDomains: ['cdninstagram.com', 'fbcdn.net'],
          resourceTypes: ['xmlhttprequest'],
          tabIds: [-1],
        },
      },
    ],
  });
}

installSessionRules().catch((e) => {
  blog(`Не смог поставить session-правила: ${e.message}`, 'error');
});

// правила session-scoped: слетают при рестарте браузера, установка асинхронна —
// перед сетевыми запросами дожидаемся их через этот хелпер (без гонок)
let rulesPromise = null;
function ensureSessionRules() {
  if (!rulesPromise) {
    rulesPromise = installSessionRules().catch((e) => {
      rulesPromise = null;
      throw e;
    });
  }
  return rulesPromise;
}

ensureSessionRules().catch(() => {});

// ---- сообщения ----

// односторонние сообщения: отвечаем сразу (ack), чтобы у отправителя
// никогда не висел открытый канал ("message channel closed").
const ONE_WAY = new Set([
  'START_RUN',
  'START_LINK_QUEUE',
  'START_UPLOAD',
  'STOP_UPLOAD',
  'SKIP_LINK',
  'BULK_SCRAPE',
  'SCRAPE',
  'PAUSE_RUN',
  'RESUME_RUN',
  'STOP_RUN',
  'RETRY_ERRORS',
  'RELOAD_FLOW_TAB',
  'DUMP_DOM',
  'CALIBRATE',
  'SELFTEST',
  'DRIVER_DUMP',
  'SAVE_RESULT_FILE',
  'SAVE_PROMPT_HISTORY',
  'DRIVER_PONG',
  'DRIVER_LOG',
]);

// режим «Выгрузка» занимает вкладку Flow так же, как обычный прогон:
// пока он идёт, галерею и очереди трогать нельзя
const BUSY_PHASES = new Set(['running', 'paused', 'uploading']);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      await restorePromise;
      if (ONE_WAY.has(msg?.type)) {
        try {
          respond({ accepted: true });
        } catch {
          /* канал уже мёртв */
        }
      }
      await routeMessage(msg, respond);
    } catch (e) {
      try {
        respond({ ok: false, error: e.message });
      } catch {
        /* ignore */
      }
      blog(`Ошибка обработки ${msg?.type}: ${e.message}`, 'error');
      state.phase = state.phase === 'running' ? 'paused' : state.phase;
      notifyPanel();
    }
  })();
  return true;
});

// ---- РЕАЛЬНЫЙ КЛИК через CDP ----
// Синтетические события из content-скрипта (isTrusted: false) часть
// приложений игнорирует. CDP Input.dispatchMouseEvent отправляет настоящее
// событие ввода — ровно то же, что от мыши. Работает и через shadow DOM,
// потому что кликает по координатам, как это делает человек.

let debuggerAttachedTab = null;

async function realClickAt(tabId, x, y) {
  const pt = { x: Math.round(x), y: Math.round(y) };
  let attachedHere = false;
  try {
    if (debuggerAttachedTab === tabId) {
      // уже подключены — просто шлём событие
    } else {
      if (debuggerAttachedTab !== null) {
        try {
          await chrome.debugger.detach({ tabId: debuggerAttachedTab });
        } catch {
          /* уже отвалился */
        }
        debuggerAttachedTab = null;
      }
      await chrome.debugger.attach({ tabId }, '1.3');
      debuggerAttachedTab = tabId;
      attachedHere = true;
    }
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...pt,
      button: 'none',
      buttons: 0,
    });
    await sleep(60);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...pt,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(50);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...pt,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    return true;
  } catch (e) {
    const why = String((e && e.message) || e);
    if (/DevTools|devtools/i.test(why)) {
      throw new Error(
        'закрой DevTools (F12) на вкладке Flow — пока он открыт, реальный клик невозможен',
      );
    }
    throw new Error(`реальный клик не удался: ${why}`);
  } finally {
    // отключаемся, чтобы не висела полоса «отлаживается» и не мешали DevTools
    if (attachedHere) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* ок */
      }
      debuggerAttachedTab = null;
    }
  }
}

async function routeMessage(msg, respond) {
  switch (msg.type) {
    case 'GET_STATE':
      respond({ type: 'STATE', state: snapshot() });
      break;
    case 'DRIVER_PONG':
      driverReady = true;
      seenDriverVersion = msg.version || null;
      if (typeof msg.calibrated === 'boolean') driverCalibrated = msg.calibrated;
      driverWaiters.splice(0).forEach((w) => w());
      break;
    case 'DRIVER_LOG':
      blog(msg.text, msg.level || 'info');
      break;
    case 'DIAGNOSE': {
      try {
        const lines = [];
        const byStatus = {};
        for (const j of state.queue) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
        const qs =
          Object.entries(byStatus)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ') || 'пусто';
        lines.push(`фаза: ${state.phase}, очередь: ${state.queue.length} [${qs}]`);
        const tabs = await chrome.tabs.query({
          url: ['https://labs.google/*', 'https://flow.google.com/*'],
        });
        lines.push(
          `вкладок Flow: ${tabs.length}${tabs.length ? ` (${tabs.map((t) => t.id).join(', ')})` : ''}`,
        );
        if (tabs.length) {
          const t = tabs[0];
          await ensureDriver(t.id);
          const diag = await chrome.tabs
            .sendMessage(t.id, { type: 'DIAGNOSE_FLOW' })
            .catch((e) => ({ error: e.message }));
          if (diag.error) {
            lines.push(`драйвер: ошибка ${diag.error}`);
          } else {
            lines.push(`драйвер: ${diag.version || 'без версии'}`);
            lines.push(`url: ${diag.url}`);
            lines.push(
              `промт-бокс: ${diag.promptBox || 'НЕ НАЙДЕН'} (editable: ${diag.editableCount}, textarea: ${diag.textareas})`,
            );
            lines.push(`композер: ${diag.composer ? 'есть' : 'НЕТ'}`);
            lines.push(`Generate: ${diag.generate || 'НЕ НАЙДЕНА'}`);
            lines.push(`file input: ${diag.fileInput ? 'есть' : 'нет'}`);
            lines.push(`тайлов в проекте: ${diag.tiles ?? '?'}`);
            if (diag.promptBar) lines.push(`панель промта: ${diag.promptBar}`);
            if (diag.generateCandidates?.length) {
              lines.push(`кандидаты Generate: ${diag.generateCandidates.join(' | ')}`);
            } else {
              lines.push('кандидаты Generate: НЕ НАЙДЕНЫ');
            }
            lines.push(`кнопки: ${diag.visibleButtons.join(' | ') || '—'}`);
          }
        } else {
          lines.push('вкладок Flow нет — открой проект');
        }
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        lines.push(`DNR-правил: ${rules.length} (${rules.map((r) => r.id).join(',') || '—'})`);
        const persisted = await loadPersisted();
        lines.push(
          `persist: ${persisted ? `есть, фаза ${persisted.phase}, фото ${(persisted.flat || []).length}` : 'пусто'}`,
        );
        blog(`Диагностика:\n  ${lines.join('\n  ')}`, 'warn');
        respond({ ok: true });
      } catch (e) {
        blog(`Диагностика упала: ${e.message}`, 'error');
        respond({ ok: false });
      }
      break;
    }
    case 'SCRAPE': {
      if (BUSY_PHASES.has(state.phase)) {
        blog('Сначала останови текущий прогон (Стоп) — иначе очередь будет затёрта', 'warn');
        break;
      }
      try {
        state.phase = 'scraping';
        notifyPanel();
        const { posts, username } = await doScrape(msg.url);
        state.username = username;
        state.posts = posts;
        state.flat = flattenPosts(posts);
        state.queue = [];
        state.results = [];
        state.linkQueue = [];
        state.sourceUrl = (msg.url || '').trim();
        state.scrapedAt = Date.now();
        state.phase = 'picking';
        blog(`Выгружено: ${posts.length} постов, ${state.flat.length} фото`);
      } catch (e) {
        state.phase = 'idle';
        blog(e.message, 'error');
      }
      notifyPanel();
      break;
    }
    case 'START_RUN': {
      if (state.phase === 'running') {
        blog('Прогон уже идёт — сначала останови его', 'warn');
        break;
      }
      // если вкладка Flow держит старый content-скрипт — кликов не будет,
      // лучше честно сказать об этом, чем молча ничего не делать
      try {
        const ftab = await getFlowTab();
        const p = await chrome.tabs.sendMessage(ftab.id, { type: 'PING' }).catch(() => null);
        if (p && p.version && p.version !== DRIVER_VERSION) {
          state.phase = 'idle';
          notifyPanel();
          blog(
            `Вкладка Flow держит драйвер ${p.version}, а нужен ${DRIVER_VERSION}. ` +
              `Клики работать не будут — закрой вкладку Flow целиком и открой заново.`,
            'error',
          );
          break;
        }
      } catch {
        /* вкладка недоступна — дальше ensureDriver разберётся */
      }
      if (!state.flat.length) {
        state.phase = 'idle';
        notifyPanel();
        blog('Нет выгруженных фото — нажми «Выгрузить» заново', 'error');
        break;
      }
      let selected = msg.selected || [];
      // подписанные URL CDN протухают за часы — старую выгрузку обновляем автоматически
      const STALE_MS = 6 * 3600 * 1000;
      if (state.sourceUrl && state.scrapedAt && Date.now() - state.scrapedAt > STALE_MS) {
        blog('Выгрузка старая — обновляю ссылки на фото…', 'warn');
        try {
          const { posts } = await doScrape(state.sourceUrl);
          const { mapped, lost } = remapSelection(state.flat, state.posts, posts, selected);
          state.posts = posts;
          state.flat = flattenPosts(posts);
          state.scrapedAt = Date.now();
          selected = mapped;
          if (lost) blog(`Не нашлось в обновлённой выгрузке: ${lost} фото`, 'warn');
          if (!selected.length) throw new Error('после обновления не осталось выбранных фото');
          blog(`Выгрузка обновлена: ${posts.length} постов`);
        } catch (e) {
          state.phase = 'idle';
          notifyPanel();
          blog(`Не смог обновить выгрузку: ${e.message}. Нажми «Выгрузить» заново.`, 'error');
          break;
        }
      }
      state.prompt = msg.prompt || '';
      state.baseImage = msg.baseImage || null;
      state.mode = msg.mode || 'image';
      state.delaySec = msg.delaySec ?? 10;
      state.timeoutSec = msg.timeoutSec ?? 180;
      state.retryCount = msg.retryCount ?? 1;
      state.retryDelaySec = msg.retryDelaySec ?? 5;
      state.retryViaTile = msg.retryViaTile !== false;
      state.autoDownload = msg.autoDownload !== false;
      if (msg.useBase && !msg.baseImage) {
        blog('Галочка базовой фотки стоит, но файл не загружен — иду без неё', 'warn');
      }
      state.queue = (selected || [])
        .filter((flatIdx) => state.flat[flatIdx])
        .map((flatIdx, i) => {
          const item = state.flat[flatIdx];
          return {
            jobId: `j${Date.now()}_${i}`,
            imageUrl: item.imageUrl,
            postIndex: item.postIndex,
            imageIndex: item.imageIndex,
            linkUrl: item.linkUrl || state.sourceUrl,
            flatIdx, // индекс в галерее панели для подсветки
            status: 'pending',
          };
        });
      state.results = [];
      state.linkQueue = [];
      state.phase = 'running';
      notifyPanel();
      runQueue();
      break;
    }
    case 'PAUSE_RUN':
      if (state.phase === 'running') {
        state.phase = 'paused';
        notifyPanel();
      }
      break;
    case 'RESUME_RUN':
      if (state.phase === 'paused') {
        state.phase = 'running';
        notifyPanel();
        runQueue();
      }
      break;
    case 'STOP_RUN':
      state.phase = 'done';
      if (currentJob) {
        currentJob.status = 'cancelled';
        currentJob = null;
      }
      // недоделанное помечаем — чтобы прогресс-бар и галерея не висели «в вечности»
      for (const j of state.queue) if (j.status === 'pending') j.status = 'cancelled';
      for (const l of state.linkQueue || []) {
        if (['pending', 'scraping', 'running'].includes(l.status)) l.status = 'cancelled';
      }
      notifyPanel();
      break;
    case 'SELFTEST': {
      // Полная диагностика живой вкладки: отчёт о DOM + скриншот в Загрузки
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      try {
        const tab = await getFlowTab();
        await ensureDriver(tab.id);
        const res = await withTimeout(
          chrome.tabs.sendMessage(tab.id, { type: 'SELFTEST' }),
          20000,
          'SELFTEST_TIMEOUT',
        );
        if (!res?.ok) throw new Error(res?.error || 'драйвер не ответил');
        const report = res.report;
        const text = JSON.stringify(report, null, 2);
        await chrome.downloads.download({
          url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text),
          filename: `flow-auto-selftest-${stamp}.json`,
          saveAs: false,
        });
        blog(
          `Самотест: композитор ${report.composerTag || 'НЕ НАЙДЕН'}, кандидатов ${report.candidates.length}, отчёт сохранён`,
          'ok',
        );
      } catch (e) {
        blog(`Самотест не удался: ${e.message}`, 'error');
      }
      // скриншот живой вкладки через CDP
      try {
        const tab = await getFlowTab();
        await chrome.debugger.attach({ tabId: tab.id }, '1.3');
        const shot = await chrome.debugger.sendCommand(
          { tabId: tab.id },
          'Page.captureScreenshot',
          { format: 'png' },
        );
        await chrome.debugger.detach({ tabId: tab.id });
        await chrome.downloads.download({
          url: 'data:image/png;base64,' + shot.data,
          filename: `flow-auto-screen-${stamp}.png`,
          saveAs: false,
        });
        blog('Скриншот вкладки Flow сохранён в Загрузки', 'ok');
      } catch (e) {
        blog(`Скриншот не снят: ${e.message}`, 'warn');
      }
      notifyPanel();
      break;
    }
    case 'CDP_CLICK': {
      try {
        const tab = await getFlowTab();
        const ok = await realClickAt(tab.id, msg.x, msg.y);
        respond({ ok });
      } catch (e) {
        blog(String(e.message), 'warn');
        respond({ ok: false, error: e.message });
      }
      break;
    }
    case 'CALIBRATE': {
      try {
        const tab = await getFlowTab();
        await ensureDriver(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'CALIBRATE' }).catch(() => {});
        blog('Кликни по белой стрелке (отправке) прямо в окне Flow — запомню её', 'warn');
      } catch (e) {
        blog(`Прицел не поставился: ${e.message}`, 'error');
      }
      notifyPanel();
      break;
    }
    case 'DUMP_DOM': {
      // сохраняем дамп DOM Flow файлом — чтобы разобрать структуру без копипаста
      try {
        const tab = await getFlowTab();
        await ensureDriver(tab.id);
        const res = await withTimeout(
          chrome.tabs.sendMessage(tab.id, { type: 'DUMP_DOM' }),
          20000,
          'DUMP_TIMEOUT',
        );
        const text = res?.dump || `ошибка: ${res?.error || res?.message || 'пусто'}`;
        const capped = text.length > 1_500_000 ? text.slice(0, 1_500_000) + '\n\n[обрезано]' : text;
        const filename = `flow-auto-dom-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
        const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(capped);
        const dlId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
        const [info] = await Promise.all([
          new Promise((r) => {
            const l = (d) => {
              if (d.id === dlId && d.state && d.state !== 'in_progress') {
                chrome.downloads.onChanged.removeListener(l);
                r(d);
              }
            };
            chrome.downloads.onChanged.addListener(l);
            setTimeout(() => r({ state: 'complete' }), 8000);
          }),
        ]);
        const where = info?.filename || 'Загрузки';
        blog(`Дамп DOM сохранён: ${where} (${Math.round(capped.length / 1024)} КБ)`, 'ok');
        respond({ ok: true, file: where });
      } catch (e) {
        blog(`Дамп DOM не сохранился: ${e.message}`, 'error');
        respond({ ok: false, error: e.message });
      }
      break;
    }
    case 'DRIVER_DUMP': {
      // драйвер сам попросил сохранить дамп (генерация не запустилась)
      try {
        const text = (msg.dump || '').slice(0, 1_500_000);
        if (!text) break;
        const filename = `flow-auto-dom-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
        const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
        const dlId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
        const [info] = await Promise.all([
          new Promise((r) => {
            const l = (d) => {
              if (d.id === dlId && d.state && d.state !== 'in_progress') {
                chrome.downloads.onChanged.removeListener(l);
                r(d);
              }
            };
            chrome.downloads.onChanged.addListener(l);
            setTimeout(() => r({ state: 'complete' }), 8000);
          }),
        ]);
        blog(
          `Дамп DOM сохранён: ${info?.filename || 'Загрузки'} (${Math.round(text.length / 1024)} КБ)`,
          'ok',
        );
      } catch (e) {
        blog(`Дамп DOM не сохранился: ${e.message}`, 'error');
      }
      break;
    }
    case 'RELOAD_FLOW_TAB': {
      // ручная перезагрузка вкладки Flow — обычно нужно после обновления расширения
      try {
        const tab = await getFlowTab();
        await chrome.tabs.reload(tab.id, { bypassCache: true });
        await waitTabComplete(tab.id, 45000);
        await sleep(2500);
        driverReady = false;
        await ensureDriver(tab.id);
        blog('Вкладка Flow перезагружена, драйвер обновлён', 'ok');
      } catch (e) {
        blog(`Не смог перезагрузить вкладку Flow: ${e.message}`, 'error');
      }
      notifyPanel();
      break;
    }
    case 'RETRY_ERRORS': {
      // перезапуск только ошибшихся/пропущенных задач — с тем же промтом и фото
      if (BUSY_PHASES.has(state.phase)) {
        blog('Прогон ещё идёт — сначала останови его', 'warn');
        break;
      }
      const bad = state.queue.filter((j) => j.status === 'error' || j.status === 'skipped');
      if (!bad.length) {
        blog('Ошибок нет — перезапускать нечего', 'warn');
        break;
      }
      for (const j of bad) {
        j.status = 'pending';
        j.note = '';
        delete j._refreshed;
      }
      state.results = [];
      state.phase = 'running';
      notifyPanel();
      blog(`Повторяю ошибки: ${bad.length} задач`);
      runQueue();
      break;
    }
    case 'START_LINK_QUEUE': {
      if (BUSY_PHASES.has(state.phase)) {
        blog('Прогон уже идёт — сначала останови его', 'warn');
        break;
      }
      const urls = [...new Set((msg.urls || []).map((u) => String(u).trim()).filter(Boolean))];
      if (!urls.length) {
        blog('В очереди нет ни одной ссылки', 'error');
        break;
      }
      if (!(msg.prompt || '').trim()) {
        blog('Введи промт — он общий для всех ссылок', 'error');
        break;
      }
      state.prompt = msg.prompt;
      state.baseImage = msg.baseImage || null;
      state.mode = msg.mode || 'image';
      state.delaySec = msg.delaySec ?? 10;
      state.timeoutSec = msg.timeoutSec ?? 180;
      state.retryCount = msg.retryCount ?? 1;
      state.retryDelaySec = msg.retryDelaySec ?? 5;
      state.retryViaTile = msg.retryViaTile !== false;
      state.autoDownload = msg.autoDownload !== false;
      state.maxPerLink = Math.max(0, parseInt(msg.maxPerLink, 10) || 0);
      state.linkQueue = urls.map((u) => ({ url: u, status: 'pending' }));
      state.queue = [];
      state.results = [];
      state.posts = [];
      state.flat = [];
      state.username = '';
      state.phase = 'running';
      notifyPanel();
      blog(`Очередь из ${urls.length} ссылок — погнали`);
      runQueue();
      break;
    }
    case 'START_UPLOAD': {
      // режим «Выгрузка»: ссылки идут по порядку, фото уходят в композер Flow
      // одно за другим. Промт не вводим, Generate не жмём — только вложения.
      if (BUSY_PHASES.has(state.phase)) {
        blog('Уже идёт прогон или выгрузка — сначала останови их', 'warn');
        break;
      }
      const urls = [...new Set((msg.urls || []).map((u) => String(u).trim()).filter(Boolean))];
      if (!urls.length) {
        blog('В списке нет ни одной ссылки', 'error');
        break;
      }
      state.uploadDelaySec = Math.max(0, parseInt(msg.delaySec, 10) || 0);
      state.upLinks = urls.map((u) => ({ url: u, status: 'pending', note: '', total: 0, done: 0 }));
      state.upQueue = [];
      state.phase = 'uploading';
      notifyPanel();
      blog(`Выгрузка в Flow: ${urls.length} ссылок, фото пойдут друг за другом`, 'info');
      runUpload();
      break;
    }
    case 'SKIP_LINK': {
      // «Дальше»: бросаем остаток текущей ссылки и уходим на следующую.
      // Фото, которое уже крепится, не трогаем — дождаться безопаснее, чем
      // рвать вкладку Flow посреди загрузки.
      const link = state.upLinks.find((l) => l.status === 'uploading' || l.status === 'scraping');
      if (!link) {
        blog('Сейчас не идёт ни одна ссылка — пропускать нечего', 'warn');
        break;
      }
      link.skip = true;
      for (const j of state.upQueue) {
        if (j.linkUrl === link.url && j.status === 'pending') j.status = 'skipped';
      }
      if (link.status === 'scraping') {
        link.note = 'пропускаю…';
      } else {
        // если необработанных фото не осталось (жмили на последнем), ссылка
        // фактически успела — не помечаем её пропущенной
        const left = state.upQueue.filter(
          (j) => j.linkUrl === link.url && (j.status === 'pending' || j.status === 'uploading'),
        ).length;
        const missed = state.upQueue.filter(
          (j) => j.linkUrl === link.url && j.status === 'skipped',
        ).length;
        link.status = left ? 'skipped' : 'done';
        link.note = missed ? `пропущено, мимо ${missed} фото` : `${link.done || 0} фото в Flow`;
      }
      const nxt = state.upLinks.find((l) => l.status === 'pending');
      blog(
        `Пропускаю «${shortUrl(link.url)}»` +
          (nxt ? `, дальше «${shortUrl(nxt.url)}»` : ', это была последняя ссылка'),
        'info',
      );
      notifyPanel();
      break;
    }
    case 'STOP_UPLOAD': {
      if (state.phase !== 'uploading') break;
      state.phase = 'done';
      for (const j of state.upQueue) {
        if (j.status === 'pending' || j.status === 'uploading') j.status = 'cancelled';
      }
      for (const l of state.upLinks) {
        if (['pending', 'scraping', 'uploading'].includes(l.status)) l.status = 'cancelled';
      }
      const done = state.upQueue.filter((j) => j.status === 'done').length;
      const linksOk = state.upLinks.filter((l) => l.status === 'done').length;
      blog(`Остановлено: ссылок ${linksOk}/${state.upLinks.length}, фото в Flow ${done}`, 'warn');
      notifyPanel();
      break;
    }
    case 'BULK_SCRAPE': {
      // режим «выгрузить всё столбиком»: тащим все ссылки разом (параллельно,
      // с ограничением одновременных), все фото падают в одну общую галерею,
      // где пользователь выделяет нужные и жмёт «Старт» как обычно
      if (BUSY_PHASES.has(state.phase)) {
        blog('Прогон уже идёт — сначала останови его', 'warn');
        break;
      }
      const raw = (msg.urls || []).map((u) => String(u).trim()).filter(Boolean);
      // дубли могли прийти из кэша — игнорируем
      const urls = [...new Set(raw)];
      if (!urls.length) {
        blog('Нет ни одной ссылки для выгрузки', 'error');
        break;
      }
      state.phase = 'scraping';
      state.username = `${urls.length} ссылок`;
      state.linkQueue = urls.map((u) => ({ url: u, status: 'pending' }));
      state.posts = [];
      state.flat = [];
      state.queue = [];
      state.results = [];
      notifyPanel();
      blog(`Массовая выгрузка: ${urls.length} ссылок…`, 'info');
      const CONCURRENCY = 3;
      let idx = 0;
      let okCount = 0;
      const failed = [];
      const worker = async () => {
        while (idx < urls.length) {
          const my = idx++;
          const url = urls[my];
          const link = state.linkQueue[my];
          link.status = 'scraping';
          notifyPanel();
          try {
            const { posts } = await doScrape(url);
            for (const p of posts) p.sourceLink = url;
            state.posts.push(...posts);
            link.status = 'done';
            link.note = `${posts.length} постов`;
            okCount++;
          } catch (e) {
            link.status = 'error';
            link.note = e.message;
            failed.push(url);
            blog(`«${shortUrl(url)}»: ${e.message}`, 'error');
          }
          notifyPanel();
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
        state.flat = flattenPosts(state.posts);
        state.sourceUrl = '';
        state.scrapedAt = Date.now();
        state.phase = 'picking';
        if (state.flat.length) {
          blog(
            `Массовая выгрузка готова: ${okCount} ссылок ок, ${state.flat.length} фото в галерее` +
              (failed.length ? `, ${failed.length} ссылок с ошибкой` : ''),
            'ok',
          );
        } else {
          blog('Все ссылки отдали ноль фото — проверь ссылки или аккаунты', 'error');
        }
      } catch (e) {
        state.phase = 'idle';
        blog(`Массовая выгрузка упала: ${e.message}`, 'error');
      }
      notifyPanel();
      break;
    }
    case 'SAVE_RESULT_FILE':
      // скачивание теперь в processJob; оставлено для совместимости
      break;
    case 'GET_HISTORY': {
      const { faHistory = [] } = await chrome.storage.local.get('faHistory');
      respond({ type: 'HISTORY', history: faHistory });
      break;
    }
    case 'SAVE_PROMPT_HISTORY': {
      const { faHistory = [] } = await chrome.storage.local.get('faHistory');
      const p = (msg.prompt || '').trim();
      if (p) {
        const key = p.slice(0, 120);
        const entry = faHistory.find((h) => h.prompt === key);
        if (entry) {
          entry.uses += 1;
          entry.lastUsed = Date.now();
        } else {
          faHistory.unshift({ prompt: p, uses: 1, lastUsed: Date.now() });
        }
        await chrome.storage.local.set({ faHistory: faHistory.slice(0, 30) });
      }
      respond({ type: 'HISTORY', history: faHistory });
      break;
    }
    case 'DELETE_PROMPT_HISTORY': {
      const { faHistory = [] } = await chrome.storage.local.get('faHistory');
      const next = faHistory.filter((h) => h.prompt !== msg.prompt);
      await chrome.storage.local.set({ faHistory: next });
      respond({ type: 'HISTORY', history: next });
      break;
    }
  }
}

// иконка тулбара открывает side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// heartbeat на время прогона: storage-запись каждые 20с не даёт Chrome убить SW
setInterval(() => {
  if (state.phase === 'running' || state.phase === 'uploading') {
    try {
      chrome.storage.session.set({ faAlive: Date.now() });
    } catch {
      /* ignore */
    }
  }
}, 20000);
