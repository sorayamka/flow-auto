// Драйвер Google Flow: живёт на flow.google.com/*, выполняет команды из background/sw.js.
// Селекторы выверены на живом DOM Flow (сентябрь 2026):
//   промт-бокс:  FLOW-RICH-TEXT-EDITOR.prompt-input > .ProseMirror (contenteditable)
//   композер:    FLOW-BASE-PROMPT-BOX
//   «+»:         button[aria-label*="Добавить ингредиенты"]  (eng: "Add media")
//   поповер:     FLOW-ADD-MENU-POPOVER-CONTENT
//   «Загрузки»:  mat-list-item (текст содержит drive_folder_upload+Загрузки)
//   «Загрузить»: span.upload-container > span «Загрузить» → появляется input[type=file]
//   ассет:       button.asset-item (в поповере) → кнопка «Добавить в запрос»
//   Generate:    button[aria-label*="Начать генерацию" i] (eng: "Generate"/"arrow_forward")
//   тайлы:       FLOW-GRID-TILE-CONTAINER > img (src flow-content.google/image/...)
//   готовый URL: img[src*="flow-content.google/image/"]

(() => {
  if (window.__FLOW_AUTO_DRIVER__) return;
  window.__FLOW_AUTO_DRIVER__ = true;
  const DRIVER_VERSION = 'v3.9';

  const ping = () =>
    chrome.runtime.sendMessage({ type: 'DRIVER_PONG', version: DRIVER_VERSION }).catch(() => {});
  ping();

  let currentJobLabel = '';
  const uploadCommands = new Map();

  const log = (text, level) => {
    const prefix = currentJobLabel ? `[${currentJobLabel}] ` : '';
    chrome.runtime.sendMessage({ type: 'DRIVER_LOG', text: prefix + text, level }).catch(() => {});
  };

  // ---------- базовые утилиты ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function byAria(substr, root = document) {
    const s = substr.toLowerCase();
    return (
      [
        ...root.querySelectorAll(
          'button, [role="button"], [role="menuitem"], [role="tab"], mat-list-item',
        ),
      ].find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes(s)) || null
    );
  }

  function byText(text, root = document, { deep = true } = {}) {
    const els = [...root.querySelectorAll('button, span, div, mat-list-item')].filter(
      (e) => isVisible(e) && (e.textContent || '').trim() === text,
    );
    if (!els.length) return null;
    return deep ? els[els.length - 1] : els[0];
  }

  // ---------- элементы Flow ----------

  function getPromptEditor() {
    return document.querySelector('.ProseMirror');
  }

  function getComposer() {
    return document.querySelector('FLOW-BASE-PROMPT-BOX');
  }

  // общий список кнопок-кандидатов (запасной путь, когда панель не нашлась)
  function generateButtonCandidates() {
    const root = getComposer() || document;
    return [
      ...new Set([
        ...root.querySelectorAll('button, [role="button"], [role="submit"]'),
        ...document.querySelectorAll('button, [role="button"]'),
      ]),
    ].filter((b) => b.isConnected);
  }

  function isGenerateButton(b) {
    const al =
      `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`.toLowerCase();
    if (/начать генерацию|сгенерировать|generate|отправить|send|создать|create|запустить/.test(al))
      return true;
    const txt = (b.textContent || '').toLowerCase();
    if (/arrow_forward|arrow_upward|send\b/.test(txt))
      return getComposer()?.contains(b) || !b.textContent.trim();
    const icon = b.querySelector('.material-icons, mat-icon, .mat-icon');
    if (icon && /arrow_forward|send|auto_awesome/.test((icon.textContent || '').toLowerCase())) {
      return getComposer()?.contains(b) || !b.textContent.trim();
    }
    return false;
  }

  // Поиск с протыканием shadow DOM: Google Labs/Flow держит части интерфейса
  // в теневых деревьях, обычный querySelector их не видит
  function deepQuery(selector, root = document) {
    const out = [];
    const seenRoots = new Set();
    const walk = (node) => {
      if (!node || seenRoots.has(node) || !node.querySelectorAll) return;
      seenRoots.add(node);
      try {
        for (const el of node.querySelectorAll(selector)) out.push(el);
      } catch {
        /* ignore */
      }
      let all;
      try {
        all = node.querySelectorAll('*');
      } catch {
        return;
      }
      for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root);
    return out;
  }

  function interactiveEls(root = document) {
    return deepQuery('button, [role="button"], [role="submit"]', root);
  }

  // elementFromPoint НЕ проваливается в shadow root и возвращает хост.
  // Без этого клик по стрелке уходил в пустоту.
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard++ < 10) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // обычный contains() не видит узлы из другого дерева (shadow DOM)
  function containsDeep(container, el) {
    let cur = el;
    for (let i = 0; i < 60 && cur; i++) {
      if (cur === container) return true;
      const root = cur.getRootNode ? cur.getRootNode() : null;
      cur = cur.parentElement || (root && root.host) || null;
    }
    return false;
  }

  // ---------- ПРИЦЕЛ: калибровка кнопки Generate одним кликом ----------
  // Перебирать селекторы наугад бессмысленно: путь до кнопки меняется,
  // а человек знает, где она. Один клик пользователя — и дальше клик точный.

  const CAL_KEY = 'fa_generate_calibration';
  let calibration = null;

  async function loadCalibration() {
    try {
      const o = await chrome.storage.local.get(CAL_KEY);
      calibration = o && o[CAL_KEY] ? o[CAL_KEY] : null;
    } catch {
      calibration = null;
    }
  }
  loadCalibration();

  // устойчивый CSS-путь: id, если есть, иначе tag:nth-of-type
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      let nth = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) nth++;
        sib = sib.previousElementSibling;
      }
      const cls = (cur.className || '')
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length < 30)
        .slice(0, 2);
      parts.unshift(
        cur.tagName.toLowerCase() +
          (cls.length ? '.' + cls.join('.') : '') +
          `:nth-of-type(${nth})`,
      );
      cur = cur.parentElement;
      if (parts.length > 12) break;
    }
    return parts.join(' > ');
  }

  // точный кандидат по калибровке: сначала сохранённый путь, потом геометрия
  // от правого-нижнего угла композера (переживает переименование классов)
  function calibratedCandidate() {
    if (!calibration) return null;
    const comp = getComposer();
    if (!comp || !isVisible(comp)) return null;
    if (calibration.path) {
      try {
        const el = document.querySelector(calibration.path);
        if (el && isVisible(el) && comp.contains(el)) return el;
      } catch {
        /* путь невалиден — идём по геометрии */
      }
    }
    const cr = comp.getBoundingClientRect();
    const x = cr.right + (calibration.dx || 0) - (calibration.w || 20) / 2;
    const y = cr.bottom + (calibration.dy || 0) - (calibration.h || 20) / 2;
    const at = deepElementFromPoint(x, y);
    if (at && (containsDeep(comp, at) || isVisible(at))) {
      const btn = at.closest?.('button, [role="button"], [role="submit"]') || at;
      if (isVisible(btn)) return btn;
    }
    return null;
  }

  function startCalibration() {
    const hint = document.createElement('div');
    hint.textContent = '🎯 Кликни по кнопке отправки (белая стрелка)';
    hint.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:16px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'background:#7c5cff',
      'color:#fff',
      'font:600 14px sans-serif',
      'padding:10px 16px',
      'border-radius:12px',
      'box-shadow:0 8px 30px rgba(0,0,0,.5)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(hint);
    const onClick = (ev) => {
      // ev.target для shadow DOM — это хост; настоящий элемент даёт composedPath
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      const el = path[0] && path[0].nodeType === 1 ? path[0] : ev.target;
      const comp = getComposer();
      hint.remove();
      if (!el || !comp) {
        log('Прицел не задан: не нашёл композер', 'error');
        return;
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) {
        log('Прицел не задан: по клику нет элемента', 'error');
        return;
      }
      const btn = el.closest?.('button, [role="button"], [role="submit"]') || el;
      const br = btn.getBoundingClientRect();
      const cr = comp.getBoundingClientRect();
      const rootHost = btn.getRootNode && btn.getRootNode().host;
      calibration = {
        path: rootHost ? '' : cssPath(btn),
        dx: Math.round(br.right - cr.right),
        dy: Math.round(br.bottom - cr.bottom),
        w: Math.round(br.width),
        h: Math.round(br.height),
        tag: btn.tagName.toLowerCase(),
        aria: btn.getAttribute('aria-label') || '',
        inShadow: !!rootHost,
        hostTag: rootHost ? rootHost.tagName.toLowerCase() : '',
        ts: Date.now(),
      };
      chrome.storage.local.set({ [CAL_KEY]: calibration }).catch(() => {});
      log(
        `Прицел сохранён: ${calibration.tag}${calibration.aria ? '[' + calibration.aria + ']' : ''}` +
          `${calibration.inShadow ? ' (внутри ' + calibration.hostTag + ')' : ''}, ` +
          `смещение ${calibration.dx},${calibration.dy}, размер ${calibration.w}x${calibration.h}`,
        'ok',
      );
    };
    document.addEventListener('click', onClick, { capture: true, once: true });
    log('Прицел: кликни по кнопке отправки в окне Flow', 'warn');
  }

  // Кандидаты на кнопку отправки.
  // Ключевое: берём ТОЛЬКО то, что физически лежит внутри панели композера.
  // Раньше был запасной путь «маленькие кнопки внизу экрана» — он цеплял
  // кнопки на фотках в сетке, и клик уходил по плитке вместо отправки.
  function launchCandidates() {
    const pm = getPromptEditor();
    const comp = getComposer();
    const compRect = comp ? comp.getBoundingClientRect() : null;
    const hasArea = !!(compRect && compRect.width > 200 && compRect.height > 40);
    const out = [];
    const seen = new Set();
    const forbidden =
      /плюс|\badd\b|добав|agent|агент|модель|model|nano|banana|\bpro\b|close|закрыт|крест|очист|clear|delete|удал|attachment|настр|settings|help|справк|zoom|share|скач|download|копир|copy|fullscreen|history|истори/i;
    // внутри плитки/медиа-кнопки — это точно не отправка
    const inTile = (el) =>
      !!el.closest?.(
        'flow-grid-tile-container, [class*="tile"], [class*="media-item"], [class*="thumb"]',
      );
    const add = (el, score, opts = {}) => {
      if (!el || seen.has(el) || !el.isConnected || !isVisible(el)) return;
      if (el === pm || el.contains(pm) || el.querySelector?.('.ProseMirror')) return;
      if (inTile(el)) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.width > 150 || r.height > 150) return;
      // кнопка с явной подписью отправки может лежать вне композера
      // (Flow меняет вёрстку) — для неё геометрию не проверяем,
      // она и так однозначно опозналась
      if (hasArea && !opts.outside) {
        // центр кнопки должен быть внутри панели композера.
        // contains() не работает для shadow DOM — проверяем и геометрией,
        // и shadow-aware containsDeep, иначе отбрасываем настоящую кнопку
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const pad = 14;
        const insideByRect =
          cx >= compRect.left - pad &&
          cx <= compRect.right + pad &&
          cy >= compRect.top - pad &&
          cy <= compRect.bottom + pad;
        if (!insideByRect && !containsDeep(comp, el)) return;
      }
      const txt = (el.textContent || '').trim();
      if (txt.length > 4) return;
      if (/^[×✕✖x✗+]$/i.test(txt)) return;
      const cls = (el.className || '') + '' + ' ' + ((el.className || '').baseVal || '');
      if (/close|clear|dismiss|cancel|remove|delete|icon-close|icon-clear/i.test(cls)) return;
      const al = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''}`;
      if (forbidden.test(al)) return;
      seen.add(el);
      out.push({ el, score });
    };

    // 0) ПРИЦЕЛ — если пользователь один раз показал кнопку, бьём точно в неё
    const cal = calibratedCandidate();
    if (cal) add(cal, 5000);

    // 1) сильная подпись — главный путь. outside: такая кнопка может лежать
    // вне композера (новая вёрстка Flow), отбрасывать её нельзя —
    // иначе отправка никогда не кликнется
    for (const b of interactiveEls()) {
      const al = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`;
      if (
        /начать генерац|сгенерировать|generate|отправить|send|создать|create|запуст|submit|поставить задач/i.test(
          al,
        )
      ) {
        add(b, 1000, { outside: true });
      }
    }
    // 2) кнопки композера: СНИЗУ ВВЕРХ, потом справа налево.
    // В реальном Flow «×» закрытия сидит вверху справа, а стрелка отправки —
    // внизу справа, поэтому сортировка по правому краю выбирала «×».
    if (comp) {
      const btns = interactiveEls(comp);
      btns.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.abs(rb.bottom - ra.bottom) > 12) return rb.bottom - ra.bottom;
        return rb.left - ra.left;
      });
      btns.forEach((b, i) => add(b, 600 - i));
    }
    // 3) иконки композера и их кнопки — тоже снизу вверх
    if (comp) {
      const icons = deepQuery('svg, mat-icon, .material-icons, [class*="icon"]', comp);
      icons.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      icons.forEach((e, i) => {
        add(e.closest?.('button, [role="button"]'), 400 - i);
        add(e, 300 - i);
      });
    }
    // 4) если панель не нашлась — узкий запасной путь: строка редактора
    if (!hasArea && pm) {
      const pr = pm.getBoundingClientRect();
      const row = interactiveEls().filter((b) => {
        if (inTile(b)) return false;
        const r = b.getBoundingClientRect();
        if (r.width > 96 || r.height > 96) return false;
        return (
          Math.abs(r.top + r.height / 2 - (pr.top + pr.height / 2)) < 90 && r.left > pr.right - 40
        );
      });
      row.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      row.forEach((b, i) => add(b, 200 - i));
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  // Панель промта в Flow: поднимаемся от ProseMirror до контейнера, который
  // содержит и поле ввода, и кнопки справа (модель, «x1», стрелка отправки)
  function getPromptBar() {
    const pm = getPromptEditor();
    if (!pm) return null;
    let el = pm;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelector('button') && el.getBoundingClientRect().height < 420) return el;
    }
    return el;
  }

  // Отчёт о реальной странице: координаты, классы, кто где — для точной диагностики
  function buildSelfTest() {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.left),
        y: Math.round(b.top),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    };
    const comp = getComposer();
    const pm = getPromptEditor();
    const compRect = comp ? r(comp) : null;
    const shadowHosts = deepQuery('*')
      .filter((e) => e.shadowRoot)
      .map((e) => {
        const b = r(e);
        return `${e.tagName.toLowerCase()} shadow=${e.shadowRoot.children.length} ${b.w}x${b.h}@${b.x},${b.y}`;
      });
    const allBtns = [...new Set([...interactiveEls(), ...interactiveEls(comp || document)])]
      .filter(isVisible)
      .map((b) => {
        const bb = r(b);
        return {
          tag: b.tagName.toLowerCase(),
          aria: b.getAttribute('aria-label') || '',
          title: b.getAttribute('title') || '',
          cls: ((b.className || '') + '' || '').split(' ').slice(0, 3).join('.'),
          rect: bb,
          disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
          inComposer: comp ? containsDeep(comp, b) : false,
          inShadow: !!(b.getRootNode && b.getRootNode().host),
          text: (b.textContent || '').trim().slice(0, 24),
        };
      });
    const cands = launchCandidates();
    const probes = cands.map(({ el, score }, i) => {
      const bb = r(el);
      const cx = Math.round(bb.x + bb.w / 2);
      const cy = Math.round(bb.y + bb.h / 2);
      const at = deepElementFromPoint(cx, cy);
      return {
        i,
        score,
        tag: el.tagName.toLowerCase(),
        aria: el.getAttribute('aria-label') || '',
        cls: ((el.className || '') + '' || '').split(' ').slice(0, 2).join('.'),
        rect: bb,
        atPoint: at
          ? `${at.tagName.toLowerCase()}${at.className ? '.' + String(at.className).split(' ')[0] : ''}`
          : 'ничего',
        inShadow: !!(el.getRootNode && el.getRootNode().host),
      };
    });
    let calProbe = null;
    if (calibration && compRect) {
      const cx = Math.round(
        compRect.x + compRect.w + (calibration.dx || 0) - (calibration.w || 20) / 2,
      );
      const cy = Math.round(
        compRect.y + compRect.h + (calibration.dy || 0) - (calibration.h || 20) / 2,
      );
      const at = deepElementFromPoint(cx, cy);
      calProbe = {
        x: cx,
        y: cy,
        calibration,
        atPoint: at
          ? `${at.tagName.toLowerCase()} aria="${at.getAttribute?.('aria-label') || ''}"`
          : 'ничего',
      };
    }
    return {
      version: DRIVER_VERSION,
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      promeMirror: pm ? r(pm) : null,
      composer: compRect,
      composerTag: comp ? comp.tagName.toLowerCase() : null,
      chips: chipCount(),
      tiles: document.querySelectorAll('FLOW-GRID-TILE-CONTAINER').length,
      shadowHosts: shadowHosts.slice(0, 30),
      buttons: allBtns.slice(0, 60),
      candidates: probes,
      calProbe,
    };
  }

  // Полный дамп композера: то, что нужно чтобы написать точный селектор
  function buildDomDump() {
    const out = [];
    const push = (s) => out.push(s);
    push(`# Дамп Flow ${DRIVER_VERSION} @ ${location.href}`);
    const pm = getPromptEditor();
    const comp = getComposer();
    push(`ProseMirror: ${pm ? 'есть' : 'НЕТ'}`);
    push(`FLOW-BASE-PROMPT-BOX: ${comp ? 'есть' : 'НЕТ'}`);

    // цепочка контейнеров от редактора вверх
    let el = pm;
    const chain = [];
    for (let i = 0; i < 8 && el && el !== document.documentElement; i++) {
      const cls = ((el.className || '') + '').split(' ').filter(Boolean).slice(0, 3).join('.');
      const r = el.getBoundingClientRect();
      chain.push(
        `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} [${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}]`,
      );
      el = el.parentElement;
    }
    push(`\n## Цепочка от ProseMirror вверх\n${chain.join('\n')}`);

    // shadow roots
    const hosts = deepQuery('*').filter((e) => e.shadowRoot);
    push(
      `\n## Shadow roots: ${hosts.length}\n` +
        hosts
          .slice(0, 40)
          .map((h) => {
            const r = h.getBoundingClientRect();
            return `${h.tagName.toLowerCase()}.${((h.className || '') + '').split(' ')[0]} shadow=${h.shadowRoot.children.length} @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
          })
          .join('\n'),
    );

    // все интерактивные элементы в радиусе композера
    const scope = comp || pm || document.body;
    const all = [...new Set([...interactiveEls(scope), ...interactiveEls(document)])];
    const rows = [];
    for (const b of all) {
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cls = ((b.className || '') + '').split(' ').filter(Boolean).slice(0, 3).join('.');
      const al = b.getAttribute('aria-label') || '';
      const ti = b.getAttribute('title') || '';
      const ds = b.getAttribute('data-tooltip') || b.getAttribute('mattooltip') || '';
      const inBar = scope !== document.body && scope.contains(b);
      rows.push({
        inBar: inBar ? 'BAR' : '---',
        tag: b.tagName.toLowerCase(),
        cls,
        aria: al,
        title: ti,
        tip: ds,
        rect: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`,
        html: b.outerHTML.slice(0, 220).replace(/\s+/g, ' '),
      });
    }
    rows.sort((a, b) =>
      a.inBar === b.inBar ? a.rect.localeCompare(b.rect) : a.inBar === 'BAR' ? -1 : 1,
    );
    push(`\n## Интерактивные элементы (${rows.length})`);
    for (const r of rows.slice(0, 120)) {
      push(
        `[${r.inBar}] ${r.tag}${r.cls ? '.' + r.cls : ''} aria="${r.aria}" title="${r.title}" tip="${r.tip}" ${r.rect}\n    ${r.html}`,
      );
    }

    // outerHTML композера
    if (comp)
      push(`\n## outerHTML FLOW-BASE-PROMPT-BOX (обрезан)\n${comp.outerHTML.slice(0, 12000)}`);
    else if (pm && pm.parentElement)
      push(
        `\n## outerHTML родителя ProseMirror (обрезан)\n${pm.parentElement.outerHTML.slice(0, 12000)}`,
      );

    // текущие кандидаты
    push(
      `\n## Кандидаты launchCandidates()\n` +
        launchCandidates()
          .map((c, i) => {
            const r = c.el.getBoundingClientRect();
            return `${i + 1}. score=${c.score} ${c.el.tagName.toLowerCase()} aria="${c.el.getAttribute('aria-label') || ''}" ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
          })
          .join('\n'),
    );

    return out.join('\n');
  }

  // снимок геометрии панели — для диагностики, если кнопка снова не находится
  function dumpPromptBar(n = 16) {
    const pm = getPromptEditor();
    if (!pm) return 'ProseMirror не найден';
    const bar = getPromptBar();
    const parts = [];
    const chain = [];
    let el = pm;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      const cls = ((el.className || '') + '').split(' ').filter(Boolean).slice(0, 2).join('.');
      const r = el.getBoundingClientRect();
      chain.push(
        `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${Math.round(r.width)}x${Math.round(r.height)}`,
      );
      el = el.parentElement;
    }
    parts.push(`цепочка: ${chain.join(' > ')}`);
    if (bar) {
      const scope = new Set([
        ...interactiveEls(bar),
        ...deepQuery('svg, mat-icon, .material-icons, [class*="icon"]', bar),
      ]);
      for (const e of scope) {
        if (parts.length >= n) break;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const al = e.getAttribute('aria-label') || e.getAttribute('title') || '';
        const cls = ((e.className || '') + '' || (e.className || '').baseVal || '')
          .split(' ')
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        parts.push(
          `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}[${al}]${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`,
        );
      }
    }
    // и все кнопки с «говорящими» подписями на странице
    const labelled = interactiveEls()
      .filter((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim())
      .slice(0, 10)
      .map(
        (b) =>
          `${b.tagName.toLowerCase()}[${b.getAttribute('aria-label') || b.getAttribute('title')}]`,
      );
    if (labelled.length) parts.push(`подписанные: ${labelled.join(' ')}`);
    return parts.join(' || ');
  }

  function allButtons(scope) {
    const seen = new Set();
    const out = [];
    for (const b of scope.querySelectorAll('button, [role="button"], [role="submit"]')) {
      if (!seen.has(b)) {
        seen.add(b);
        out.push(b);
      }
    }
    return out;
  }

  // кнопка Generate = самая правая маленькая безымянная кнопка в панели промта.
  // Иконка в Flow — это svg, поэтому ориентируемся на геометрию, а не на текст.
  function findGenerateButton() {
    const bar = getPromptBar();
    if (bar) {
      const barRect = bar.getBoundingClientRect();
      const inBar = allButtons(bar).filter(isVisible);
      // 1) по подписи — если Flow её всё-таки проставил
      const byLabel = inBar.find((b) => {
        const al =
          `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`.toLowerCase();
        return /начать генерацию|сгенерировать|generate|отправить|send|создать|create|запустить/.test(
          al,
        );
      });
      if (byLabel) return byLabel;
      // 2) геометрия: маленькая, без текста, правее всего в панели промта
      const small = inBar.filter((b) => {
        const r = b.getBoundingClientRect();
        if (r.width > 84 || r.height > 84) return false;
        if ((b.textContent || '').trim().length > 2) return false;
        if (r.right > barRect.right + 100 || r.left < barRect.left - 30) return false;
        return true;
      });
      if (small.length) {
        small.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        return small[0];
      }
    }
    // 3) запасной путь по всему документу
    return generateButtonCandidates().find((b) => isVisible(b) && isGenerateButton(b)) || null;
  }

  function describeButtons(n = 8) {
    const bar = getPromptBar();
    const list = (bar ? allButtons(bar) : generateButtonCandidates()).filter(isVisible);
    return (
      list
        .map((b) => {
          const r = b.getBoundingClientRect();
          return `aria="${b.getAttribute('aria-label') || ''}" txt="${(b.textContent || '').trim().slice(0, 14)}" ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)}`;
        })
        .slice(0, n)
        .join(' | ') || 'нет'
    );
  }

  // кнопка отключена: Flow держит её серой/неактивной, пока не валидны
  // и фото, и промт. Клик по такой кнопке (белая стрелка) ничего не запускает
  function isDisabledBtn(b) {
    if (!b) return true;
    return !!(
      b.disabled ||
      b.getAttribute('aria-disabled') === 'true' ||
      b.getAttribute('disabled') !== null
    );
  }

  // кнопка появляется/активируется не сразу после вложения фото и ввода промта —
  // ждём её и переводим в кликабельное состояние.
  // ВАЖНО: раньше эту функцию никто не вызывал, и шотган бил по отключенной
  // кнопке — со стороны это выглядит как «кнопка не нажимается».
  async function waitForGenerateButton(timeoutMs = 22000) {
    const t0 = Date.now();
    let lastPing = 0;
    while (Date.now() - t0 < timeoutMs) {
      const cands = launchCandidates();
      const gen = cands.length ? cands[0].el : findGenerateButton();
      if (gen && !isDisabledBtn(gen)) return gen;
      await sleep(700);
      if (Date.now() - lastPing > 9000) {
        lastPing = Date.now();
        const cands2 = launchCandidates();
        const top = cands2.length
          ? `${cands2[0].el.tagName.toLowerCase()} disabled=${isDisabledBtn(cands2[0].el)} aria="${cands2[0].el.getAttribute('aria-label') || ''}"`
          : 'кандидатов нет';
        log(
          `Жду активную кнопку Generate… ${Math.round((Date.now() - t0) / 1000)}с. Верхний: ${top}. Кнопки в панели: ${describeButtons()}`,
          'warn',
        );
      }
    }
    return null;
  }

  // клик по реальному элементу под курсором: у Flow поверх кнопки лежит svg/спан,
  // и клик по самой <button> уходит в пустоту.
  // ВАЖНО: клик диспатчим ровно один — самому верхнему элементу. Событие
  // само всплывёт до button. Если дёрнуть и span, и button — Flow запустит
  // генерацию два-три раза на одну задачу.
  function clickGenerate(gen) {
    try {
      const r = gen.getBoundingClientRect();
      if (!r.width || !r.height) {
        gen.click();
        return;
      }
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      // важно: elementFromPoint не видит shadow root — проваливаемся в него
      const onTop = deepElementFromPoint(x, y) || gen;
      const downOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
      };
      onTop.dispatchEvent(
        new PointerEvent('pointerdown', { ...downOpts, buttons: 1, pointerId: 1, isPrimary: true }),
      );
      onTop.dispatchEvent(new MouseEvent('mousedown', { ...downOpts, buttons: 1 }));
      onTop.dispatchEvent(
        new PointerEvent('pointerup', { ...downOpts, buttons: 0, pointerId: 1, isPrimary: true }),
      );
      onTop.dispatchEvent(new MouseEvent('mouseup', { ...downOpts, buttons: 0 }));
      onTop.dispatchEvent(new MouseEvent('click', downOpts));
    } catch {
      gen.click();
    }
  }

  // если клик не «взлетел» — отправка с клавиатуры.
  // В Flow отправка часто по Ctrl+Enter, поэтому пробуем все варианты.
  function submitByEnter(withCtrl = false) {
    const pm = getPromptEditor();
    if (!pm) return false;
    try {
      pm.focus();
    } catch {
      /* ignore */
    }
    const fire = (key, code, keyCode, ctrl) => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        pm.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            code,
            keyCode,
            which: keyCode,
            charCode: type === 'keypress' ? keyCode : 0,
            ctrlKey: !!ctrl,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    };
    fire('Enter', 'Enter', 13, withCtrl);
    return true;
  }

  // ---------- прикрепление фото (найденный путь) ----------

  async function ensureAddPopover() {
    const existing = document.querySelector('FLOW-ADD-MENU-POPOVER-CONTENT');
    if (existing && isVisible(existing)) return existing;
    const addBtn =
      byAria('добавить ингредиенты') ||
      byAria('добавления медиа') ||
      byAria('меню добавления') ||
      byAria('add media') ||
      byAria('add') ||
      [...document.querySelectorAll('button')].find((b) => {
        const t = (b.textContent || '').trim();
        return isVisible(b) && (t === '+' || t === 'add');
      }) ||
      null;
    if (!addBtn) throw new Error('Кнопка «Добавить ингредиенты» не найдена');
    addBtn.click();
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const pop = document.querySelector('FLOW-ADD-MENU-POPOVER-CONTENT');
      if (pop && isVisible(pop)) return pop;
    }
    throw new Error('Поповер добавления не открылся');
  }

  async function openUploadInput() {
    const pop = await ensureAddPopover();
    // в поповере: пункт сайд-нава «Загрузки» не нужен, сразу span.upload-container «Загрузить»
    const uploadSpan = [...pop.querySelectorAll('span.upload-container span, span')].find(
      (e) => isVisible(e) && (e.textContent || '').trim() === 'Загрузить',
    );
    if (!uploadSpan) throw new Error('Пункт «Загрузить» не найден в поповере');
    uploadSpan.click();
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      const input = document.querySelector('input[type="file"]');
      if (input) return input;
    }
    throw new Error('input[type=file] не появился');
  }

  function dataUrlToFile(dataUrl, name) {
    return fetch(dataUrl)
      .then((r) => r.blob())
      .then((blob) => new File([blob], name, { type: blob.type || 'image/jpeg' }));
  }

  function setFilesOnInput(input, files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // после upload файл появляется в поповере как button.asset-item (новые — в начале списка)
  function findAssetInPopup(name) {
    const pop = document.querySelector('FLOW-ADD-MENU-POPOVER-CONTENT');
    if (!pop) return null;
    const items = [...pop.querySelectorAll('button.asset-item')];
    const shortName = name.replace(/\.[^.]+$/, '');
    return items.find((b) => (b.textContent || '').includes(shortName)) || null;
  }

  async function waitForAssetInPopup(name, timeoutMs = 30000) {
    const t0 = Date.now();
    let lastPing = 0;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1200);
      const found = findAssetInPopup(name);
      if (found) return found;
      if (Date.now() - lastPing > 10000) {
        lastPing = Date.now();
        log(`Жду загрузку ${name} в поповере… ${Math.round((Date.now() - t0) / 1000)}с`);
      }
    }
    return null;
  }

  // ассет готов к выбору, когда у него нет состояния загрузки
  function assetReady(btn) {
    const txt = (btn.textContent || '').toLowerCase();
    if (/upload|загрузк|processing|в обраб/.test(txt) && !btn.querySelector('img')) return false;
    return true;
  }

  async function selectAssetAndAdd(assetBtn) {
    // кликаем, пока кнопка не перешла в состояние выбранной (asset-item-active / aria-selected)
    for (let i = 0; i < 6; i++) {
      assetBtn.click();
      await sleep(1200);
      const cls = String(assetBtn.className || '');
      const selected =
        /asset-item-active/.test(cls) ||
        assetBtn.getAttribute('aria-selected') === 'true' ||
        assetBtn.getAttribute('aria-pressed') === 'true';
      if (selected) break;
      // поповер мог перерисоваться — переищем кнопку по имени
      const fresh = findAssetInPopup(assetBtn.getAttribute('data-fa-name') || '') || assetBtn;
      if (fresh !== assetBtn) assetBtn = fresh;
    }
    const pop = document.querySelector('FLOW-ADD-MENU-POPOVER-CONTENT');
    const addBtn = [...(pop || document).querySelectorAll('button')].find((b) => {
      const label = b.querySelector('.mdc-button__label')?.textContent || b.textContent;
      return isVisible(b) && (label || '').trim() === 'Добавить в запрос';
    });
    if (!addBtn) throw new Error('Кнопка «Добавить в запрос» не найдена');
    // ждём, пока кнопка станет активной
    for (let i = 0; i < 8; i++) {
      const disabled = addBtn.disabled || addBtn.getAttribute('aria-disabled') === 'true';
      if (!disabled) break;
      await sleep(700);
    }
    addBtn.click();
  }

  async function closePopover() {
    const pop = document.querySelector('FLOW-ADD-MENU-POPOVER-CONTENT');
    if (!pop) return;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(600);
  }

  async function verifyChipAttached(targetCount = 1, timeoutMs = 20000) {
    const t0 = Date.now();
    let lastPing = 0;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1000);
      const box = getComposer();
      if (box && box.querySelectorAll('img').length >= targetCount) return true;
      if (Date.now() - lastPing > 10000) {
        lastPing = Date.now();
        log(`Жду чип у промт-бокса… ${Math.round((Date.now() - t0) / 1000)}с`);
      }
    }
    return false;
  }

  // ---------- контроль лишних фото ----------
  // Чипы прикрепления живут в композере и НЕ снимаются между задачами
  // (setPromptText('') чистит только текст). Поэтому копятся: в запросе
  // оказывается 3+ фото, хотя нужны 2 (базовое + из Threads). Считаем чипы
  // и срезаем лишнее кнопкой удаления.

  function chipCount() {
    return getComposer()?.querySelectorAll('img').length || 0;
  }

  // кнопка удаления на чипе: Flow прячет её до наведения, поэтому ховерим
  function findChipRemoveButton() {
    const box = getComposer();
    if (!box) return null;
    const cands = [...box.querySelectorAll('button, [role="button"], [aria-label]')];
    for (const el of cands) {
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      if (!al) continue;
      const hit = /remove|удалить|удалени|detach|отцеп|close|закрыть|clear|очистить|убрать/.test(
        al,
      );
      if (hit && isVisible(el)) return el;
    }
    return null;
  }

  async function removeOneChip() {
    const box = getComposer();
    if (!box) return false;
    const imgs = [...box.querySelectorAll('img')];
    if (!imgs.length) return false;
    // удаляем крайний (свежий) чип — лишние всегда добавляются последними
    const last = imgs[imgs.length - 1];
    const chip =
      last.closest(
        'button, [role="button"], [class*="chip"], [class*="attach"], [class*="media"]',
      ) || last.parentElement;
    if (chip) {
      for (const type of ['mouseover', 'mousemove', 'mouseenter']) {
        chip.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    }
    await sleep(350);
    let btn = findChipRemoveButton();
    if (!btn) {
      // запасной путь: Backspace/Delete на сфокусированном чипе
      if (chip) {
        try {
          chip.focus();
        } catch {
          /* не критично */
        }
        chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await sleep(500);
      }
      return chipCount() === 0;
    }
    btn.click();
    await sleep(650);
    return true;
  }

  async function removeAllChips() {
    let removed = 0;
    for (let i = 0; i < 12; i++) {
      if (!chipCount()) break;
      const ok = await removeOneChip();
      if (!ok) break;
      removed++;
    }
    return removed;
  }

  // оставить ровно expected чипов, лишние срезать
  async function trimChips(expected) {
    let removed = 0;
    for (let i = 0; i < 10 && chipCount() > expected; i++) {
      const ok = await removeOneChip();
      if (!ok) break;
      removed++;
    }
    return removed;
  }

  async function attachImage(dataUrl, name) {
    // сколько чипов уже висит — цель: +1
    const before = getComposer()?.querySelectorAll('img').length || 0;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ensureAddPopover();
        // ассет мог остаться от прошлой попытки — не грузим дубликат
        let asset = findAssetInPopup(name);
        if (!asset) {
          const input = await openUploadInput();
          const file = await dataUrlToFile(dataUrl, name);
          setFilesOnInput(input, [file]);
          asset = await waitForAssetInPopup(name);
        }
        if (!asset) throw new Error(`Файл ${name} не появился в ассетах поповера`);
        asset.setAttribute('data-fa-name', name);
        if (!assetReady(asset)) {
          await sleep(3000);
        }
        await selectAssetAndAdd(asset);
        const ok = await verifyChipAttached(before + 1);
        if (!ok) throw new Error('Чип фото не появился у промт-бокса');
        // на ретраях могло прицепиться больше одного — чистим хвосты сразу
        const extra = chipCount() - (before + 1);
        if (extra > 0) {
          log(`${name}: прицепилось лишних ${extra} — срезаю`, 'warn');
          await trimChips(before + 1);
        }
        return true;
      } catch (e) {
        lastErr = e;
        log(`Прикрепление ${name}: попытка ${attempt} не удалась — ${e.message}`, 'warn');
        await closePopover();
        // неудачная попытка могла оставить чип. verifyChipAttached проверяет
        // «>=», поэтому остаток проходит как успех, а следующая попытка
        // добавит то же фото вторым дублем. Убираем хвост до исходного
        // количества ДО ретрая, иначе фото задваивается.
        const left = chipCount() - before;
        if (left > 0) {
          log(
            `${name}: после неудачной попытки в композере +${left} — убираю перед повтором`,
            'warn',
          );
          await trimChips(before);
        }
        if (attempt === 3) throw lastErr;
        await sleep(1500);
      }
    }
    throw lastErr;
  }

  // ---------- промт ----------

  // фокус на contenteditable: простой .focus() не всегда доходит до
  // ProseMirror (Angular может перехватывать), поэтому дёргаем и мышь
  async function focusEditor(pm) {
    try {
      pm.focus({ preventScroll: true });
      const r = pm.getBoundingClientRect();
      if (r.width && r.height) {
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // реальный клик мышью ставит курсор как у человека
        if (await realClickAt(x, y)) return;
        // синтетический — на случай, если CDP недоступен
        pm.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }),
        );
        pm.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }),
        );
        pm.dispatchEvent(
          new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }),
        );
      }
    } catch {
      /* ignore */
    }
  }

  // посимвольный ввод через InputEvent — ProseMirror слушает именно его,
  // execCommand('insertText') в новом Chrome выброшен и текст в модель не попадает
  async function typeIntoEditor(pm, text) {
    const chunkSize = 40;
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      // современный ProseMirror ловит beforeinput, старый — input
      pm.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: chunk,
          inputType: 'insertText',
          isComposing: false,
        }),
      );
      pm.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: chunk,
          inputType: 'insertText',
          isComposing: false,
        }),
      );
    }
  }

  async function setPromptText(text) {
    const pm = getPromptEditor();
    if (!pm) throw new Error('Промт-бокс (ProseMirror) не найден');
    await focusEditor(pm);
    await sleep(200);

    // очищаем старое: выделение + удаление реальными клавишами
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(pm);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    pm.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Delete',
        code: 'Delete',
        keyCode: 46,
        bubbles: true,
        cancelable: true,
      }),
    );
    pm.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Delete',
        code: 'Delete',
        keyCode: 46,
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(150);

    const target = text.trim();
    if (!target) {
      await sleep(300);
      return;
    }

    // основной путь — посимвольный InputEvent, его видит ProseMirror
    await typeIntoEditor(pm, target);
    await sleep(400);
    if ((pm.textContent || '').trim() === target) return;

    // execCommand всё-таки работает на некоторых сборках Chrome
    try {
      pm.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      if (document.execCommand('insertText', false, target)) {
        await sleep(400);
        if ((pm.textContent || '').trim() === target) return;
      }
    } catch {
      /* ignore */
    }

    // запасной путь: прямой текст + input-событие целиком
    pm.textContent = target;
    pm.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: target, inputType: 'insertText' }),
    );
    await sleep(300);
    if ((pm.textContent || '').trim() === target) return;

    // последний шанс: вставка через ClipboardEvent (Flow поддерживает paste)
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', target);
      pm.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }),
      );
    } catch {
      /* ignore */
    }
    await sleep(300);
    if ((pm.textContent || '').trim() !== target) {
      throw new Error(
        `Промт не введён: в редакторе «${(pm.textContent || '').trim().slice(0, 40)}» вместо «${target.slice(0, 40)}»`,
      );
    }
  }

  // ---------- ожидание результата ----------

  function currentTiles() {
    return [...document.querySelectorAll('FLOW-GRID-TILE-CONTAINER')]
      .map((t) => {
        const img = t.querySelector(
          'img[src*="flow-content.google/image/"], img[src*="googleusercontent"], img[src*="lh3.googleusercontent"]',
        );
        return img ? img.src : null;
      })
      .filter(Boolean);
  }

  // Спиннер: только реальный индикатор в сетке результатов.
  // Раньше матчились [class*="shimmer"]/[class*="spinner"] — это ловило
  // любые декоративные элементы страницы и давало ложный «старт генерации».
  function generationSpinnerVisible() {
    const firstTile = document.querySelector('flow-grid-tile-container');
    const scope = firstTile ? firstTile.parentElement : document;
    return [...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
  }

  // композер очищен: Flow принял запрос (пропал промт и чипы)
  function composerCleared() {
    const pm = getPromptEditor();
    const promptGone = !pm || !(pm.textContent || '').trim();
    return promptGone && chipCount() === 0;
  }

  function generationStarted(before) {
    if (generationSpinnerVisible()) return true;
    // новый тайл СЧИТАЕТСЯ стартом только если композер очистился:
    // сетка догружается лениво и без отправки появляются новые плитки
    if (currentTiles().some((s) => !before.has(s))) return composerCleared();
    return false;
  }

  // настоящий клик мышью через CDP — его невозможно проигнорировать
  async function realClickAt(x, y) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'CDP_CLICK', x, y });
      if (r && r.ok) return true;
      // CDP упал (DevTools открыт / отказано в разрешении) — видно в логе,
      // а не тихо падаем в синтетический клик, который Flow игнорирует
      log(`CDP-клик не удался: ${r?.error || 'нет ответа'} — пробую синтетический`, 'warn');
      return false;
    } catch (e) {
      log(`CDP-клик не отправился: ${e?.message || e} — пробую синтетический`, 'warn');
      return false;
    }
  }

  // клик по элементу: сначала реальный ввод, затем синтетический как запасной
  async function pressElement(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    if (await realClickAt(x, y)) return true;
    clickGenerate(el);
    return true;
  }

  // Дойти до настоящей кнопки даже если поверх неё лежит svg/span,
  // и отдать DOM-кнопку — на ней проверяем disabled-состояние.
  function unwrapToButton(el) {
    if (!el) return null;
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      if (cur.matches?.('button, [role="button"], [role="submit"]')) return cur;
      const p = cur.parentElement || cur.getRootNode?.().host;
      if (!p || p === cur) break;
      cur = p;
    }
    if (el.matches?.('button, [role="button"], [role="submit"]')) return el;
    // последняя попытка: кнопка в той же точке через composedPath-аналог
    const r = el.getBoundingClientRect();
    return el.closest?.('button, [role="button"], [role="submit"]') || null;
  }

  // клик в точку (x,y) через CDP, но кнопка под точкой переопределяется
  // прицельной геометрией, если она валидна — иначе клик мажет мимо кнопки
  async function pressPoint(x, y) {
    if (await realClickAt(x, y)) return true;
    const onTop = deepElementFromPoint(x, y);
    const btn = onTop?.closest?.('button, [role="button"], [role="submit"]') || onTop;
    if (btn) {
      clickGenerate(btn);
      return true;
    }
    return false;
  }

  // ШОТГАН: перебираем кандидатов на кнопку отправки, после каждого клика
  // проверяем, запустилась ли генерация. Останавливаемся на первом успехе.
  async function ensureGenerationStarted(before, promptText = '', timeoutMs = 45000) {
    const promptAlive = () => {
      const pm = getPromptEditor();
      return !pm || !!(pm.textContent || '').trim();
    };
    const restore = async () => {
      if (promptText) {
        log('Кандидат снёс промт — возвращаю текст', 'warn');
        try {
          await setPromptText(promptText);
        } catch {
          /* ignore */
        }
        await sleep(600);
      }
    };

    // Главный путь: дождаться именно активной кнопки Generate и ударить в неё.
    // Клик по отключённой (белая стрелка) — это и есть «кнопка не нажимается».
    const gen = await waitForGenerateButton(25000);
    if (gen) {
      log('Кнопка Generate активна — жму', 'info');
      await pressElement(gen);
      for (let t = 0; t < 3; t++) {
        await sleep(1000);
        if (generationStarted(before)) {
          log('Генерация запущена (главная кнопка)', 'info');
          return true;
        }
      }
      if (!promptAlive()) await restore();
      log('Основной клик не запустил генерацию — перебираю кандидатов', 'warn');
    } else {
      log('Активная кнопка Generate не дождалась — перебираю кандидатов', 'warn');
    }

    const cands = launchCandidates();
    if (!cands.length) {
      log('Кандидатов на кнопку Generate не нашёл — пробую Enter', 'warn');
      if (!promptAlive()) await restore();
      submitByEnter();
      for (let t = 0; t < 12; t++) {
        await sleep(1000);
        if (generationStarted(before)) return true;
      }
      return false;
    }
    // Если есть прицел (пользователь один раз показал кнопку) — бьём только
    // в неё. Перебор остальных кнопок лишь сносит промт (клик по «×», «+»).
    const only = calibration ? [cands[0]] : cands;
    log(
      calibration
        ? `Бью по прицелу (смещение ${calibration.dx},${calibration.dy}${calibration.inShadow ? ', внутри ' + calibration.hostTag : ''})`
        : `Кандидатов на Generate: ${cands.length}, пробую`,
      'info',
    );
    for (let i = 0; i < only.length; i++) {
      const { el } = only[i];
      if (!el.isConnected || !isVisible(el)) continue;
      await pressElement(el);
      for (let t = 0; t < 3; t++) {
        await sleep(1000);
        if (generationStarted(before)) {
          log(
            `Генерация запущена (${calibration ? 'прицел' : 'кандидат ' + (i + 1) + '/' + cands.length})`,
            'info',
          );
          return true;
        }
      }
      if (!calibration) {
        if (!promptAlive()) await restore();
        log(`Кандидат ${i + 1}/${cands.length} не сработал, беру следующий`, 'warn');
      }
    }
    // всё мимо — последний шанс через клавиатуру: Enter, затем Ctrl+Enter
    log('Ни один кандидат не сработал — пробую Enter и Ctrl+Enter', 'warn');
    if (!promptAlive()) await restore();
    for (const withCtrl of [false, true]) {
      submitByEnter(withCtrl);
      for (let t = 0; t < 5; t++) {
        await sleep(1000);
        if (generationStarted(before)) {
          log(`Генерация запущена с клавиатуры (${withCtrl ? 'Ctrl+Enter' : 'Enter'})`, 'info');
          return true;
        }
      }
    }
    return false;
  }

  async function waitForResult(timeoutMs, beforeSet) {
    const before = beforeSet || new Set(currentTiles());
    const t0 = Date.now();
    let seenGenerating = false;
    let lastPing = 0;
    // если за 45с нет ни спиннера, ни нового тайла — клик, похоже, не сел.
    // ждать дальше timeout бессмысленно, лучше быстро вернуть ошибку и повторить
    const DEAD_CLICK_MS = Math.min(45000, Math.max(20000, timeoutMs * 0.3));
    while (Date.now() - t0 < timeoutMs) {
      await sleep(2000);
      if (generationSpinnerVisible()) seenGenerating = true;
      const now = currentTiles();
      const fresh = now.filter((s) => !before.has(s));
      if (fresh.length) {
        await sleep(4000);
        const stable = currentTiles().filter((s) => !before.has(s));
        return {
          ok: true,
          resultUrl: stable[0] || fresh[0],
          note: `${stable.length || 1} результат(ов)`,
        };
      }
      // проверка отказа
      const errEl = document.querySelector('[class*="error"], [class*="warning"]');
      const errText = errEl?.textContent || '';
      if (seenGenerating && /violat|policy|couldn|not allowed|не удалось|нарушен/i.test(errText)) {
        return { ok: false, skipped: true, note: 'Модерация Flow отклонила запрос' };
      }
      const elapsed = Date.now() - t0;
      if (!seenGenerating && elapsed > DEAD_CLICK_MS) {
        return { ok: false, note: 'Генерация не запустилась (клик Generate не сработал)' };
      }
      if (Date.now() - lastPing > 30000) {
        lastPing = Date.now();
        log(
          `Жду генерацию… ${Math.round(elapsed / 1000)}с${seenGenerating ? '' : ' (индикатора пока нет)'}`,
        );
      }
    }
    return {
      ok: false,
      note: seenGenerating
        ? 'Таймаут: генерация шла, но результат не появился'
        : 'Таймаут: признаков генерации не было',
    };
  }

  // ---------- конвейер одной задачи ----------

  // кнопка «Сгенерировать повторно» на тайле (retry по цензуре/ошибке)
  function findRegenerateButton() {
    return byAria('сгенерировать повторно') || byAria('regenerate') || byAria('retry') || null;
  }

  async function runJob(msg) {
    const pm = getPromptEditor();
    if (!pm) {
      return { ok: false, note: 'Нет ProseMirror — открой проект в Flow' };
    }
    // сколько фото должно быть в запросе: базовое (из промта) + фото Threads
    const expected = Math.max(1, msg.expectedImages || (msg.baseImage ? 2 : 1));
    currentJobLabel = `Задача ${
      String(msg.jobId || '')
        .split('_')
        .pop() || '?'
    }`;
    try {
      // композер не чистит чипы между задачами — иначе копятся 3+ фото
      const leftover = chipCount();
      if (leftover) {
        log(`Очищаю ${leftover} фото прошлой задачи`);
        await removeAllChips();
      }
      // очистить промт-бокс
      await setPromptText('');
      await sleep(300);

      if (msg.baseImage) {
        log('Креплю базовую фотку из промта');
        await attachImage(msg.baseImage, `flow-auto-${msg.jobId}-base.jpg`);
      }
      log('Креплю фото из Threads');
      await attachImage(msg.threadImage, `flow-auto-${msg.jobId}.jpg`);

      // страховка: в запросе должно быть ровно expected фото, лишние срезаем
      const have = chipCount();
      if (have > expected) {
        log(`Лишних фото в запросе: ${have - expected} — удаляю`, 'warn');
        const removed = await trimChips(expected);
        log(`Удалено лишних: ${removed}`);
      }
      const final = chipCount();
      if (final !== expected) {
        return {
          ok: false,
          note: `Прикреплено фото: ${final}, ожидалось ${expected} — перепроверь вложения`,
        };
      }

      log('Ввожу промт');
      await setPromptText(msg.prompt);
      await sleep(800);

      // снимок тайлов ДО запуска — по нему поймём, что генерация реально пошла
      const before = new Set(currentTiles());
      // маркер фазы для внешней диагностики: что именно сейчас нажимается
      try {
        window.__FA_PHASE = 'generate';
      } catch {
        /* не критично */
      }
      log('Жму Generate');
      // кликает шотган: перебирает кандидатов и проверяет старт после каждого
      const started = await ensureGenerationStarted(before, msg.prompt || '');
      if (!started) {
        // дамп целиком снимается по кнопке «⬇ DOM Flow» — не засоряем канал
        return {
          ok: false,
          note: `Не удалось запустить генерацию — жми «⬇ DOM Flow» и скинь файл из Загрузок. Панель: ${dumpPromptBar(8)}`,
        };
      }

      const timeout = (msg.timeoutSec || 180) * 1000;
      const res = await waitForResult(timeout, before);
      if (res.ok && res.resultUrl) {
        chrome.runtime
          .sendMessage({ type: 'SAVE_RESULT_FILE', url: res.resultUrl })
          .catch(() => {});
      }
      log(res.ok ? `готово: ${res.note || 'ок'}` : res.note, res.ok ? 'info' : 'warn');
      return res;
    } catch (e) {
      return { ok: false, note: `Драйвер: ${e.message}` };
    } finally {
      currentJobLabel = '';
    }
  }

  // повтор через кнопку «Сгенерировать повторно» на отклонённом тайле.
  // Отключён: кликал по чужому тайлу и приносил ложные «готово».
  async function runRetryViaTile(msg) {
    return runJob(msg);
  }

  // ---------- режим «Выгрузка»: только вложение ----------
  // Фото крепится в композер и всё: промт не трогаем, Generate не жмём,
  // чипы не снимаем — они копятся, как и просил пользователь.
  // Постусловие жёсткое: за одну команду в композере добавляется РОВНО один
  // чип. В режиме генерации этим же занимается runJob (там чипы чистятся
  // перед каждой задачей), а здесь накапливаем — значит дубль не спрячется.
  async function attachOnly(msg) {
    if (!getPromptEditor()) {
      return { ok: false, note: 'Нет ProseMirror — открой проект в Flow' };
    }
    const name = msg.name || 'flow-auto-upload.jpg';
    currentJobLabel = `Фото ${
      String(msg.jobId || '')
        .split('_')
        .pop() || '?'
    }`;
    const before = chipCount();
    const target = before + 1;
    try {
      await attachImage(msg.imageDataUrl, name);
      await closePopover();
      // attachImage уже следит за числом чипов, но подстрахуемся: показываем
      // в лог фактическое количество и приводим его к ровно одному новому
      const got = chipCount();
      if (got !== target) {
        log(`Вложений стало ${got}, ждали ${target} — правлю`, 'warn');
        if (got > target) await trimChips(target);
      }
      const total = chipCount();
      if (total !== target) {
        return { ok: false, note: `Ожидалось вложений: ${target}, получилось: ${total}` };
      }
      return { ok: true, note: `в Flow (вложений: ${total})` };
    } catch (e) {
      return { ok: false, note: `Драйвер: ${e.message}` };
    } finally {
      currentJobLabel = '';
    }
  }

  // ---------- приём команд ----------

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === 'PING') {
      respond({ ok: true, version: DRIVER_VERSION, calibrated: !!calibration });
      ping();
      return;
    }
    if (msg.type === 'CALIBRATE') {
      startCalibration();
      respond({ ok: true });
      return;
    }
    if (msg.type === 'DIAGNOSE_FLOW') {
      const pm = getPromptEditor();
      const gen = findGenerateButton();
      respond({
        ok: true,
        version: DRIVER_VERSION,
        url: location.href,
        promptBox: pm ? 'ProseMirror' : null,
        composer: !!getComposer(),
        generate: gen
          ? `aria="${gen.getAttribute('aria-label')}" disabled=${!!gen.disabled || gen.getAttribute('aria-disabled') === 'true'}`
          : null,
        fileInput: !!document.querySelector('input[type="file"]'),
        tiles: document.querySelectorAll('FLOW-GRID-TILE-CONTAINER').length,
        promptBar: dumpPromptBar(12),
        generateCandidates: launchCandidates()
          .slice(0, 6)
          .map(({ el, score }) => {
            const r = el.getBoundingClientRect();
            const al = el.getAttribute('aria-label') || '';
            return `${el.tagName.toLowerCase()}[${al}] ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} score=${score}`;
          }),
        visibleButtons: [...document.querySelectorAll('button')]
          .filter(isVisible)
          .map((b) => b.getAttribute('aria-label'))
          .filter(Boolean)
          .slice(0, 40),
      });
      return;
    }
    if (msg.type === 'DUMP_DOM') {
      try {
        respond({ ok: true, dump: buildDomDump() });
      } catch (e) {
        respond({ ok: false, error: e.message });
      }
      return;
    }
    if (msg.type === 'SELFTEST') {
      // подробный отчёт о реальной странице: что есть, где что, что за кнопка
      try {
        respond({ ok: true, report: buildSelfTest() });
      } catch (e) {
        respond({ ok: false, error: e.message });
      }
      return;
    }
    if (msg.type === 'RUN_JOB') {
      const run = msg.retryHint ? runRetryViaTile(msg) : runJob(msg);
      run.then(respond);
      return true; // async
    }
    if (msg.type === 'ATTACH_ONLY') {
      // Повтор доставки той же команды не должен второй раз прикреплять файл.
      const key = msg.jobId || msg.name;
      if (!uploadCommands.has(key)) uploadCommands.set(key, attachOnly(msg));
      uploadCommands.get(key).then(respond);
      return true; // async
    }
  });

  log(`Драйвер Flow готов (${DRIVER_VERSION}, шотган-клик по Generate)`);
})();
