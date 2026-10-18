// Fallback-скрапер Threads: вытаскиваем data-sjs JSON прямо из DOM открытой вкладки.
// Ждём появления script[data-sjs] (SPA может дорисовываться), парсим те же поля,
// что и Swift-граббер: thread_items → post → carousel_media / image_versions2.

(() => {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type !== 'GRAB_FROM_TAB') return;

    const waitAndParse = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const posts = collectPosts();
        if (posts.length) return posts;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return collectPosts();
    };

    waitAndParse()
      .then((posts) =>
        respond({
          ok: true,
          posts,
          url: location.href,
          scripts: document.querySelectorAll('script[data-sjs]').length,
        }),
      )
      .catch((e) => respond({ ok: false, error: e.message }));
    return true;
  });

  function collectPosts() {
    const byId = new Map();
    const order = [];
    for (const el of document.querySelectorAll('script[type="application/json"][data-sjs]')) {
      let json;
      try {
        json = JSON.parse(el.textContent);
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
      // лента профиля может прийти как одним массивом thread_items со всеми
      // постами, так и набором объектов-тредов с одним элементом — берём каждый
      const items = node.thread_items;
      if (Array.isArray(items) && items.length) {
        for (const it of items) {
          if (it && it.post) onRoot(it.post);
        }
      }
      // запасной путь: пост лежит где угодно (edges/nodes/прямые списки) без
      // обёртки thread_items — тащим по признакам самого поста
      if (looksLikePost(node)) onRoot(node);
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
    if (!p || typeof p.id !== 'string') return null;
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
})();
