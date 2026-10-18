// Threads scraper — порт ThreadsGrabber/Sources/Scraper.swift на JS.
// Тот же подход: тянем HTML профиля, парсим <script type="application/json" data-sjs>,
// достаём thread_items → post → carousel_media / image_versions2.candidates.

export function normalizeUsername(raw) {
  const s = (raw || '').trim();
  const m = s.match(/threads\.(?:com|net)\/@([A-Za-z0-9_.]+)/);
  if (m) return m[1];
  let t = s;
  if (t.startsWith('@')) t = t.slice(1);
  t = t.split('/')[0].split('?')[0];
  return /^[A-Za-z0-9._]{1,30}$/.test(t) ? t : null;
}

export class ScraperError extends Error {
  constructor(kind, msg) {
    super(msg);
    this.kind = kind;
  }
}

const ERRORS = {
  badLink: 'Не понял ссылку. Нужна ссылка на аккаунт, например https://www.threads.com/@username',
  noPosts:
    'Не удалось получить посты. Аккаунт может быть закрытым или пустым, либо Meta временно ограничила запрос — попробуй ещё раз.',
};

const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export async function fetchPosts(username, { fetchImpl = fetch } = {}) {
  const url = `https://www.threads.com/@${encodeURIComponent(username)}`;
  let lastError = new ScraperError('noPosts', ERRORS.noPosts);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const html = await downloadString(url, fetchImpl);
      const posts = parse(html);
      if (posts.length) return posts;
      lastError = new ScraperError('noPosts', ERRORS.noPosts);
    } catch (e) {
      lastError = e instanceof ScraperError ? e : new ScraperError('network', `Сеть: ${e.message}`);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadString(url, fetchImpl) {
  const resp = await fetchImpl(url, {
    headers: { 'User-Agent': BOT_UA },
    cache: 'reload',
    credentials: 'omit',
  });
  if (!resp.ok) throw new ScraperError('network', `HTTP ${resp.status}`);
  return resp.text();
}

export function parse(html) {
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
    // лента профиля может прийти как один массив thread_items со всеми постами,
    // так и набором объектов-тредов с одним элементом — берём каждый post
    const items = node.thread_items;
    if (Array.isArray(items) && items.length) {
      for (const it of items) {
        if (it && it.post) onRoot(it.post);
      }
    }
    // запасной путь: пост лежит где угодно (edges/nodes/прямые списки) без
    // обёртки thread_items — тащим по признакам самого поста
    if (looksLikePost(node)) onRoot(node);
    for (const v of Object.values(node)) collectRoots(v, onRoot);
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
