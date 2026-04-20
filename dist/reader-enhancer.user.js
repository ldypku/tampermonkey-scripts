// ==UserScript==
// @name         Universal Reader Lite Ultimate Sequential Cache
// @namespace    https://greasyfork.org/
// @version      2026.04.19.10
// @description  通用阅读模式最终整合顺序缓存版：单滚动条、连续阅读、手选正文、字体/宽度调整、顺序缓存、导出 md/txt
// @author       OpenAI
// @match        http*://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_ID = 'universal-reader-lite-ultimate-seq';
  const STORAGE_KEY = `${APP_ID}:settings:v1`;
  const READER_ROOT_ID = `${APP_ID}-root`;
  const FLOAT_BUTTON_ID = `${APP_ID}-button`;
  const PICK_MASK_ID = `${APP_ID}-pick-mask`;
  const READER_CONTENT_ID = `${APP_ID}-content`;

  const DEFAULT_SETTINGS = {
    autoEnableByHost: {},

    width: 860,
    minWidth: 560,
    maxWidth: 1400,
    widthStep: 60,

    fontSize: 20,
    minFontSize: 14,
    maxFontSize: 36,
    fontSizeStep: 1,

    lineHeight: 1.95,

    theme: 'sepia',
    showButton: true,

    autoPageEnabled: false,
    autoPageScrollThreshold: 0.985,

    manualPickRemember: false,
    appendSeparator: true,
    maxAutoAppendChapters: 30,

    exportMarkdownWithFrontMatter: true
  };

  const state = {
    enabled: false,
    settings: loadSettings(),
    pageType: 'article',
    floatButton: null,

    readerRoot: null,
    readerContent: null,

    pickerMask: null,
    pickerBox: null,
    picking: false,

    pickedNode: null,
    hiddenNodes: [],
    savedScrollY: 0,

    readerTitle: '',
    navLinks: {
      prev: null,
      next: null,
      index: null
    },

    autoPageTimer: 0,
    autoPagingTriggered: false,
    isAppendingNextChapter: false,
    loadedChapterUrls: new Set(),
    appendedChapterCount: 0,
    currentPrevUrl: '',
    currentNextUrl: '',
    currentIndexUrl: '',

    novelCacheJob: null
  };

  const SELECTORS = {
    novel: {
      title: [
        '.bookname h1',
        '.book .info h1',
        '.novel h1',
        '.chapter-title',
        '.article-title',
        '.content h1',
        'h1'
      ],
      content: [
        '#content',
        '#chaptercontent',
        '#chapterContent',
        '#articlecontent',
        '.read-content',
        '.chapter-content',
        '.yd_text2',
        '.txtnav',
        '.txt',
        '.articlecon',
        '.noveltext',
        '.content',
        '.box_con #content'
      ],
      remove: [
        'script', 'style', 'iframe', 'ins',
        '.ad', '.ads', '.advert', '.banner',
        '.recommend', '.related', '.share',
        '.footer', '.header', '.comment', '.comments',
        '.pagination', '.pager', '.nav', '.breadcrumb',
        '.tips', '.readad',
        '[id*="ad"]',
        '[class*="ad-"]',
        '[class^="ad"]'
      ]
    },
    forum: {
      title: [
        '.thread_subject',
        '#thread_subject',
        '.ts h1',
        '.ts',
        '.post-title',
        '.entry-title',
        'h1'
      ],
      content: [
        '.pcb .t_f',
        '.t_fsz .t_f',
        '.t_f',
        '.pct',
        '.postmessage',
        '.message',
        '.postbody',
        '.entry-content',
        '.article-content',
        '.post-content'
      ],
      remove: [
        'script', 'style', 'iframe', 'ins',
        '.sign', '.signature', '.postauthor',
        '.authorinfo', '.userinfo', '.avatar',
        '.quote', '.reply', '.replybtn',
        '.fastreply', '.comment', '.comments',
        '.share', '.toolbox', '.ad', '.ads',
        '.banner', '.sidebar'
      ]
    },
    article: {
      title: [
        '.article-title',
        '.entry-title',
        '.post-title',
        'article h1',
        'main h1',
        'h1'
      ],
      content: [
        'article',
        '.article-content',
        '.entry-content',
        '.post-content',
        '.content',
        'main'
      ],
      remove: [
        'script', 'style', 'iframe', 'ins',
        '.ad', '.ads', '.banner', '.share',
        '.related', '.recommend', '.comments',
        '.comment', '.sidebar', '.footer', '.header'
      ]
    }
  };

  const LINK_TEXT = {
    prev: ['上一页', '上页', '上一章', '上一节', 'Prev', 'previous', '前一页', '前一章', '上一回'],
    next: ['下一页', '下页', '下一章', '下一节', 'Next', 'next', '后一页', '后一章', '下一回'],
    index: ['目录', '章节目录', '返回目录', '书页', '目录页', '返回书页', '章节列表', '全部章节']
  };

  const DISCUZ_HINTS = [
    '.pcb .t_f',
    '.t_fsz .t_f',
    '#thread_subject',
    '.pg a.nxt',
    '.pg a.prev'
  ];

  const TEXT_CLEAN_RULES = [
    [/\u00A0/g, ' '],
    [/&nbsp;/g, ' '],
    [/[ \t]+\n/g, '\n'],
    [/\n[ \t]+/g, '\n'],
    [/\n{3,}/g, '\n\n'],
    [/^\s+|\s+$/g, ''],
    [/最新网址[：:]\S+/g, ''],
    [/请记住本书首发域名\S*/g, ''],
    [/手机用户请到.*?阅读。?/g, ''],
    [/本章未完，请点击下一页继续阅读。?/g, ''],
    [/请收藏本站.*?更新最快。?/g, ''],
    [/天才一秒记住.*?提供精彩小说阅读。?/g, '']
  ];

  const NOVEL_DB = {
    dbName: `${APP_ID}-novels-db`,
    dbVersion: 1,
    storeBooks: 'books',
    storeChapters: 'chapters',

    async open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, this.dbVersion);

        req.onupgradeneeded = () => {
          const db = req.result;

          if (!db.objectStoreNames.contains(this.storeBooks)) {
            const books = db.createObjectStore(this.storeBooks, { keyPath: 'bookId' });
            books.createIndex('updatedAt', 'updatedAt', { unique: false });
            books.createIndex('host', 'host', { unique: false });
          }

          if (!db.objectStoreNames.contains(this.storeChapters)) {
            const chapters = db.createObjectStore(this.storeChapters, { keyPath: 'chapterKey' });
            chapters.createIndex('bookId', 'bookId', { unique: false });
            chapters.createIndex('bookId_order', ['bookId', 'order'], { unique: false });
            chapters.createIndex('url', 'url', { unique: false });
          }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async tx(storeNames, mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const stores = {};
        storeNames.forEach(name => {
          stores[name] = tx.objectStore(name);
        });

        let result;
        Promise.resolve(fn(stores, tx))
          .then(r => { result = r; })
          .catch(reject);

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    },

    async putBook(book) {
      return this.tx([this.storeBooks], 'readwrite', ({ books }) => {
        books.put(book);
      });
    },

    async getBook(bookId) {
      return this.tx([this.storeBooks], 'readonly', ({ books }) => {
        return new Promise((resolve, reject) => {
          const req = books.get(bookId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      });
    },

    async putChapter(chapter) {
      return this.tx([this.storeChapters], 'readwrite', ({ chapters }) => {
        chapters.put(chapter);
      });
    },

    async getChaptersByBook(bookId) {
      return this.tx([this.storeChapters], 'readonly', ({ chapters }) => {
        return new Promise((resolve, reject) => {
          const idx = chapters.index('bookId_order');
          const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
          const req = idx.getAll(range);
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    }
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...(parsed || {}),
        autoEnableByHost: {
          ...DEFAULT_SETTINGS.autoEnableByHost,
          ...((parsed && parsed.autoEnableByHost) || {})
        }
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  }

  function $(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function $all(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function textOf(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeExportText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function absoluteUrl(url, base = location.href) {
    try {
      return new URL(url, base).href;
    } catch {
      return '';
    }
  }

  function getHostKey() {
    return location.hostname.replace(/^www\./, '');
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function makeBookId(title, host = location.hostname) {
    const safeTitle = String(title || document.title || 'untitled').trim().toLowerCase();
    return `${host}::${safeTitle}`;
  }

  function safeFilename(name) {
    return String(name || 'novel')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function loadManualPickSelectorForHost() {
    return localStorage.getItem(`${STORAGE_KEY}:manual-pick:${location.hostname}`) || '';
  }

  function saveManualPickSelectorForHost(selector) {
    const key = `${STORAGE_KEY}:manual-pick:${location.hostname}`;
    if (selector) localStorage.setItem(key, selector);
    else localStorage.removeItem(key);
  }

  function detectPageType(doc = document) {
    const q = (sel) => {
      try { return doc.querySelector(sel); } catch { return null; }
    };

    if (DISCUZ_HINTS.some(sel => q(sel))) return 'forum';
    if (q('.pcb .t_f, .t_f, .postmessage, .postbody, .pct')) return 'forum';

    const bodyText = (doc.body?.innerText || '').slice(0, 8000);
    if (/上一章|下一章|章节目录|返回目录|本章|小说|最新章节/.test(bodyText)) {
      return 'novel';
    }

    return 'article';
  }

  function scoreContentElement(el) {
    const text = (el.innerText || '').trim();
    const len = text.length;
    const pCount = el.querySelectorAll('p, br').length;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 600, height: 600 };
    const area = rect.width * rect.height;
    const links = el.querySelectorAll('a').length;
    const imgs = el.querySelectorAll('img').length;
    const linkPenalty = Math.min(links * 15, 1400);
    const imagePenalty = Math.min(imgs * 20, 400);

    return len + pCount * 80 + Math.min(area / 20, 3200) - linkPenalty - imagePenalty;
  }

  function pickBestElement(selectors, root = document) {
    let best = null;
    let bestScore = -1;

    for (const selector of selectors) {
      for (const el of $all(selector, root)) {
        if (root === document && !isVisible(el)) continue;
        const score = scoreContentElement(el);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function pickBestFallbackContent(root = document) {
    const candidates = $all('article, main, .content, .main, .container, .post, .entry, .article, .pct', root);
    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      const score = scoreContentElement(el);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function pickTitle(pageType, root = document) {
    for (const selector of SELECTORS[pageType].title) {
      for (const el of $all(selector, root)) {
        const t = textOf(el);
        if (t && t.length >= 2 && t.length <= 120) {
          return t;
        }
      }
    }

    if (root.title) return root.title.replace(/[_|\-].*$/, '').trim();
    return document.title.replace(/[_|\-].*$/, '').trim();
  }

  function scoreNavAnchor(a, type) {
    const txt = textOf(a);
    const href = a.href || '';
    let score = 0;

    if (!href || href.startsWith('javascript:')) return -999;
    if (a.rel && type === 'next' && /next/i.test(a.rel)) score += 120;
    if (a.rel && type === 'prev' && /prev/i.test(a.rel)) score += 120;

    for (const key of LINK_TEXT[type]) {
      if (txt.includes(key)) score += 80;
    }

    const meta = `${a.className || ''} ${href}`;
    if (type === 'next' && /next|nxt|chapter|page/i.test(meta)) score += 30;
    if (type === 'prev' && /prev|chapter|page/i.test(meta)) score += 30;
    if (type === 'index' && /index|list|catalog|chapter/i.test(meta)) score += 30;

    const parentText = textOf(a.parentElement);
    if (/(上一页|下一页|上一章|下一章|目录)/.test(parentText)) score += 20;

    return score;
  }

  function findNavLink(type, root = document, baseUrl = location.href) {
    const anchors = $all('a[href]', root);
    let best = null;
    let bestScore = -999;

    for (const a of anchors) {
      if (root === document && !isVisible(a)) continue;
      const score = scoreNavAnchor(a, type);
      if (score > bestScore) {
        best = a;
        bestScore = score;
      }
    }

    if (best && bestScore > 40) {
      return {
        href: absoluteUrl(best.getAttribute('href'), baseUrl),
        text: textOf(best)
      };
    }

    return null;
  }

  function traverseTextNodes(root, fn) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    nodes.forEach(fn);
  }

  function stripInlineTypography(root) {
    const nodes = root.querySelectorAll('*');
    nodes.forEach(el => {
      if (!(el instanceof HTMLElement)) return;
      el.style.removeProperty('font-size');
      el.style.removeProperty('line-height');
      el.removeAttribute('size');
      if (el.tagName.toLowerCase() === 'font') {
        el.removeAttribute('style');
      }
    });
  }

  function normalizeContent(root, pageType) {
    if (pageType === 'novel') {
      const html = root.innerHTML;
      const normalized = html
        .replace(/(<br\s*\/?>\s*){2,}/gi, '</p><p>')
        .replace(/^\s*/, '<p>')
        .replace(/\s*$/, '</p>');
      root.innerHTML = normalized;
    }

    traverseTextNodes(root, (node) => {
      let value = node.nodeValue || '';
      for (const [rule, replacement] of TEXT_CLEAN_RULES) {
        value = value.replace(rule, replacement);
      }
      node.nodeValue = value;
    });

    stripInlineTypography(root);

    $all('p, div, span, section', root).forEach(el => {
      if (!el.children.length && !textOf(el)) el.remove();
    });
  }

  function cloneAndCleanContent(node, pageType) {
    const clone = node.cloneNode(true);

    for (const sel of SELECTORS[pageType].remove) {
      $all(sel, clone).forEach(el => el.remove());
    }

    $all('[style*="display:none"]', clone).forEach(el => el.remove());
    $all('input, button, textarea, form, nav, aside', clone).forEach(el => el.remove());

    $all('div, section, table, ul, ol', clone).forEach(el => {
      const txt = textOf(el);
      const linkCount = el.querySelectorAll('a').length;
      if (txt.length > 0 && txt.length < 30 && linkCount >= 2) {
        el.remove();
      }
    });

    normalizeContent(clone, pageType);
    return clone;
  }

  function extractPageInfo(doc = document, manualNode = null, baseUrl = location.href) {
    const pageType = detectPageType(doc);
    let rawContentNode = null;

    if (manualNode) {
      rawContentNode = manualNode;
    } else if (doc === document) {
      const rememberedSelector = loadManualPickSelectorForHost();
      if (rememberedSelector) rawContentNode = $(rememberedSelector, doc);
    }

    if (!rawContentNode) {
      rawContentNode = pickBestElement(SELECTORS[pageType].content, doc) || pickBestFallbackContent(doc);
    }

    if (!rawContentNode) return null;

    const title = pickTitle(pageType, doc);
    const prev = findNavLink('prev', doc, baseUrl);
    const next = findNavLink('next', doc, baseUrl);
    const index = findNavLink('index', doc, baseUrl);
    const cleaned = cloneAndCleanContent(rawContentNode, pageType);

    return {
      pageType,
      title,
      contentHtml: cleaned.innerHTML,
      prev,
      next,
      index
    };
  }

  function createFloatButton() {
    if (!state.settings.showButton || document.getElementById(FLOAT_BUTTON_ID)) return;

    const button = document.createElement('div');
    button.id = FLOAT_BUTTON_ID;
    button.textContent = '阅';
    button.title = '阅读模式（Alt + R）';
    button.style.cssText = `
      position: fixed;
      top: 18px;
      right: 18px;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: rgba(20,20,20,.82);
      color: #fff;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
      font: 700 18px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
      box-shadow: 0 6px 18px rgba(0,0,0,.25);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.12);
    `;
    button.addEventListener('click', toggleReader);
    document.documentElement.appendChild(button);
    state.floatButton = button;
  }

  function buildReaderRootHtml(contentHtml) {
    const theme = getThemeColors(state.settings.theme);
    const host = getHostKey();

    return `
      <div style="
        position: sticky;
        top: 0;
        z-index: 10;
        backdrop-filter: blur(10px);
        background: ${theme.headerBg};
        border-bottom: 1px solid ${theme.border};
        padding: 12px 16px;
      ">
        <div data-reader-width-wrap="1" style="max-width:${state.settings.width}px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="min-width:0;">
            <div style="font-size:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${escapeHtml(state.readerTitle)}
            </div>
            <div id="${APP_ID}-meta" style="font-size:12px;opacity:.72;margin-top:4px;">
              ${escapeHtml(host)} ｜ ${escapeHtml(state.pageType)} ｜ 连续阅读：${state.settings.autoPageEnabled ? '开' : '关'} ｜ 字号：${state.settings.fontSize}px ｜ 宽度：${state.settings.width}px
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
            ${navBtnHtml('prev', '上一页')}
            ${navBtnHtml('index', '目录')}
            ${navBtnHtml('next', '下一页')}
            <button data-action="append-next" style="${toolbarBtnStyle()}">加载下一章</button>
            <button data-action="cache-book" style="${toolbarBtnStyle()}">顺序缓存</button>
            <button data-action="export-md" style="${toolbarBtnStyle()}">导出MD</button>
            <button data-action="export-txt" style="${toolbarBtnStyle()}">导出TXT</button>
            <button data-action="font-dec" style="${toolbarBtnStyle()}">字-</button>
            <button data-action="font-inc" style="${toolbarBtnStyle()}">字+</button>
            <button data-action="width-dec" style="${toolbarBtnStyle()}">窄</button>
            <button data-action="width-inc" style="${toolbarBtnStyle()}">宽</button>
            <button data-action="pick" style="${toolbarBtnStyle()}">手选正文</button>
            <button data-action="autopage" style="${toolbarBtnStyle()}">${state.settings.autoPageEnabled ? '停连续阅读' : '开连续阅读'}</button>
            <button data-action="theme" style="${toolbarBtnStyle()}">主题</button>
            <button data-action="autohost" style="${toolbarBtnStyle()}">本站默认</button>
            <button data-action="close" style="${toolbarBtnStyle(true)}">退出</button>
          </div>
        </div>
      </div>

      <div data-reader-width-wrap="1" style="max-width:${state.settings.width}px;margin:0 auto;padding:28px 22px 80px;">
        <div style="font-size:14px;opacity:.72;margin-bottom:14px;">
          Alt + R 开关 ｜ [ / ] 翻页 ｜ Shift + ] 连续阅读 ｜ Alt + N 加载下一章 ｜ Alt + P 手选正文 ｜ Alt + = / - 调字 ｜ Alt + [ / ] 调宽 ｜ Alt + B 顺序缓存 ｜ Alt + M 导出MD ｜ Alt + T 导出TXT ｜ Esc 退出
        </div>

        <article id="${READER_CONTENT_ID}" style="
          font-size:${state.settings.fontSize}px;
          line-height:${state.settings.lineHeight};
          word-break:break-word;
          letter-spacing:.01em;
        ">
          ${contentHtml}
        </article>

        <div id="${APP_ID}-append-status" style="margin-top:18px;font-size:13px;opacity:.72;"></div>

        <div style="margin-top:36px;padding-top:18px;border-top:1px solid ${theme.border};display:flex;gap:10px;flex-wrap:wrap;">
          ${navBtnHtml('prev', '← 上一页')}
          ${navBtnHtml('index', '目录')}
          ${navBtnHtml('next', '下一页 →')}
        </div>
      </div>
    `;
  }

  function navBtnHtml(type, fallbackText) {
    const info = state.navLinks[type];
    if (!info) return '';
    return `<a href="${escapeAttr(info.href)}" style="${toolbarLinkStyle()}">${escapeHtml(info.text || fallbackText)}</a>`;
  }

  function toolbarBtnStyle(primary = false) {
    return `
      all: initial;
      box-sizing: border-box;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      height:34px;
      padding:0 12px;
      border-radius:8px;
      cursor:pointer;
      user-select:none;
      font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
      color:${primary ? '#fff' : 'inherit'};
      background:${primary ? 'rgba(60,60,60,.82)' : 'rgba(127,127,127,.12)'};
      border:1px solid rgba(127,127,127,.22);
    `;
  }

  function toolbarLinkStyle() {
    return `
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:34px;
      padding:0 12px;
      border-radius:8px;
      text-decoration:none;
      color:inherit;
      background:rgba(127,127,127,.12);
      border:1px solid rgba(127,127,127,.22);
      font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    `;
  }

  function getThemeColors(theme) {
    if (theme === 'dark') {
      return {
        bg: '#111315',
        text: '#e7e7e7',
        border: 'rgba(255,255,255,.12)',
        headerBg: 'rgba(17,19,21,.84)'
      };
    }
    if (theme === 'light') {
      return {
        bg: '#f6f7f8',
        text: '#1f2328',
        border: 'rgba(0,0,0,.12)',
        headerBg: 'rgba(246,247,248,.86)'
      };
    }
    return {
      bg: '#f3ead8',
      text: '#2c241b',
      border: 'rgba(60,40,20,.12)',
      headerBg: 'rgba(243,234,216,.86)'
    };
  }

  function applyGlobalReaderTheme() {
    const theme = getThemeColors(state.settings.theme);
    document.documentElement.style.background = theme.bg;
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
  }

  function restoreGlobalTheme() {
    document.documentElement.style.background = '';
    document.body.style.background = '';
    document.body.style.color = '';
  }

  function applyReaderTypography() {
    if (!state.readerContent) return;

    const base = state.settings.fontSize;
    const lh = state.settings.lineHeight;

    state.readerContent.style.fontSize = `${base}px`;
    state.readerContent.style.lineHeight = String(lh);

    const textNodes = state.readerContent.querySelectorAll(
      'p, div, span, section, article, li, td, th, blockquote, font, strong, em, b, i, a, pre, code'
    );

    textNodes.forEach(el => {
      if (!(el instanceof HTMLElement)) return;
      el.style.setProperty('font-size', `${base}px`, 'important');
      el.style.setProperty('line-height', String(lh), 'important');
    });

    state.readerContent.querySelectorAll('h1').forEach(el => {
      el.style.setProperty('font-size', `${Math.round(base * 1.8)}px`, 'important');
      el.style.setProperty('line-height', '1.4', 'important');
    });

    state.readerContent.querySelectorAll('h2').forEach(el => {
      el.style.setProperty('font-size', `${Math.round(base * 1.5)}px`, 'important');
      el.style.setProperty('line-height', '1.4', 'important');
    });

    state.readerContent.querySelectorAll('h3').forEach(el => {
      el.style.setProperty('font-size', `${Math.round(base * 1.25)}px`, 'important');
      el.style.setProperty('line-height', '1.4', 'important');
    });

    state.readerContent.querySelectorAll('h4, h5, h6').forEach(el => {
      el.style.setProperty('font-size', `${Math.round(base * 1.1)}px`, 'important');
      el.style.setProperty('line-height', '1.4', 'important');
    });

    $all('img', state.readerContent).forEach(img => {
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      img.style.display = 'block';
      img.style.margin = '1em auto';
    });

    $all('table', state.readerContent).forEach(table => {
      table.style.maxWidth = '100%';
      table.style.display = 'block';
      table.style.overflowX = 'auto';
    });

    if (state.pageType === 'novel') {
      $all('p', state.readerContent).forEach(p => {
        p.style.textIndent = '2em';
        p.style.margin = '.7em 0';
      });
    } else {
      $all('p', state.readerContent).forEach(p => {
        p.style.margin = '.85em 0';
      });
    }
  }

  function updateMeta() {
    const meta = document.getElementById(`${APP_ID}-meta`);
    if (!meta) return;
    meta.textContent =
      `${getHostKey()} ｜ ${state.pageType} ｜ 连续阅读：${state.settings.autoPageEnabled ? '开' : '关'} ｜ 已拼接：${state.appendedChapterCount} ｜ 字号：${state.settings.fontSize}px ｜ 宽度：${state.settings.width}px`;
  }

  function setAppendStatus(msg) {
    const el = document.getElementById(`${APP_ID}-append-status`);
    if (el) el.textContent = msg || '';
  }

  function hideOriginalPage() {
    state.hiddenNodes = [];

    const root = state.readerRoot;
    const floatBtn = state.floatButton;

    Array.from(document.body.children).forEach(node => {
      if (node === root || node === floatBtn) return;
      if (node.id === PICK_MASK_ID) return;
      state.hiddenNodes.push({
        node,
        display: node.style.display
      });
      node.style.display = 'none';
    });
  }

  function restoreOriginalPage() {
    state.hiddenNodes.forEach(({ node, display }) => {
      if (node && node.isConnected) {
        node.style.display = display || '';
      }
    });
    state.hiddenNodes = [];
  }

  function mountReaderRoot(contentHtml) {
    const theme = getThemeColors(state.settings.theme);
    const root = document.createElement('div');
    root.id = READER_ROOT_ID;
    root.setAttribute('data-reader-overlay', '1');
    root.style.cssText = `
      position: relative;
      z-index: 2147483646;
      min-height: 100vh;
      background: ${theme.bg};
      color: ${theme.text};
      font-family: Georgia, "Times New Roman", "PingFang SC", "Microsoft YaHei", serif;
    `;

    root.innerHTML = buildReaderRootHtml(contentHtml);
    root.addEventListener('click', onReaderRootClick);

    document.body.appendChild(root);
    state.readerRoot = root;
    state.readerContent = document.getElementById(READER_CONTENT_ID);
    applyReaderTypography();
    updateMeta();
  }

  function unmountReaderRoot() {
    if (state.readerRoot) {
      state.readerRoot.removeEventListener('click', onReaderRootClick);
      state.readerRoot.remove();
    }
    state.readerRoot = null;
    state.readerContent = null;
  }

  function buildInitialReader(manualNode = null) {
    const info = extractPageInfo(document, manualNode, location.href);
    if (!info) return null;

    state.pageType = info.pageType;
    state.readerTitle = info.title;
    state.navLinks.prev = info.prev;
    state.navLinks.next = info.next;
    state.navLinks.index = info.index;
    state.currentPrevUrl = info.prev?.href || '';
    state.currentNextUrl = info.next?.href || '';
    state.currentIndexUrl = info.index?.href || '';
    state.loadedChapterUrls = new Set([location.href, location.pathname + location.search]);
    state.appendedChapterCount = 0;

    return info.contentHtml;
  }

  function enableReader(manualNode = null) {
    if (state.enabled) return;

    const html = buildInitialReader(manualNode);
    if (!html || html.replace(/\s+/g, '').length < 80) {
      alert('未能识别出合适的正文区域，可以用“手选正文”再试。');
      return;
    }

    state.savedScrollY = window.scrollY;

    mountReaderRoot(html);
    hideOriginalPage();
    applyGlobalReaderTheme();

    state.enabled = true;
    state.autoPagingTriggered = false;
    state.isAppendingNextChapter = false;
    setAppendStatus('');

    window.scrollTo({ top: 0, behavior: 'auto' });

    if (state.floatButton) {
      state.floatButton.style.background = 'rgba(42,110,67,.88)';
      state.floatButton.textContent = '读';
    }
  }

  function disableReader(resetPicked = true) {
    clearTimeout(state.autoPageTimer);
    state.autoPagingTriggered = false;
    state.isAppendingNextChapter = false;

    restoreOriginalPage();
    unmountReaderRoot();
    restoreGlobalTheme();

    if (resetPicked) state.pickedNode = null;
    state.enabled = false;

    if (state.floatButton) {
      state.floatButton.style.background = 'rgba(20,20,20,.82)';
      state.floatButton.textContent = '阅';
    }

    window.scrollTo({ top: state.savedScrollY || 0, behavior: 'auto' });
  }

  function toggleReader() {
    if (state.enabled) disableReader();
    else enableReader();
  }

  function refreshReaderPreserveScroll() {
    if (!state.enabled || !state.readerContent) return;

    const prevScroll = window.scrollY;
    const prevHtml = state.readerContent.innerHTML;
    const appendedCount = state.appendedChapterCount;
    const currentNextUrl = state.currentNextUrl;
    const currentPrevUrl = state.currentPrevUrl;
    const currentIndexUrl = state.currentIndexUrl;
    const loadedUrls = new Set(state.loadedChapterUrls);

    unmountReaderRoot();
    mountReaderRoot(prevHtml);

    state.appendedChapterCount = appendedCount;
    state.currentNextUrl = currentNextUrl;
    state.currentPrevUrl = currentPrevUrl;
    state.currentIndexUrl = currentIndexUrl;
    state.loadedChapterUrls = loadedUrls;
    updateMeta();

    window.scrollTo({ top: prevScroll, behavior: 'auto' });
  }

  function cycleTheme() {
    const order = ['sepia', 'dark', 'light'];
    const idx = order.indexOf(state.settings.theme);
    state.settings.theme = order[(idx + 1) % order.length];
    saveSettings();

    if (state.enabled) {
      applyGlobalReaderTheme();
      refreshReaderPreserveScroll();
    }
  }

  function adjustFontSize(diff) {
    const min = state.settings.minFontSize ?? 14;
    const max = state.settings.maxFontSize ?? 36;
    const step = state.settings.fontSizeStep ?? 1;

    const next = clamp(state.settings.fontSize + diff * step, min, max);
    if (next === state.settings.fontSize) return;

    state.settings.fontSize = next;
    saveSettings();
    applyReaderTypography();
    updateMeta();
    setAppendStatus(`字号已调整为 ${state.settings.fontSize}px`);
  }

  function adjustReaderWidth(diff) {
    const min = state.settings.minWidth ?? 560;
    const max = state.settings.maxWidth ?? 1400;
    const step = state.settings.widthStep ?? 60;

    const next = clamp(state.settings.width + diff * step, min, max);
    if (next === state.settings.width) return;

    state.settings.width = next;
    saveSettings();

    if (state.readerRoot) {
      const wrappers = state.readerRoot.querySelectorAll('[data-reader-width-wrap="1"]');
      wrappers.forEach(el => {
        el.style.maxWidth = `${state.settings.width}px`;
      });
    }

    updateMeta();
    setAppendStatus(`正文宽度已调整为 ${state.settings.width}px`);
  }

  function onReaderRootClick(e) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.getAttribute('data-action');
    if (!action) return;

    if (action === 'close') {
      disableReader();
      return;
    }

    if (action === 'theme') {
      cycleTheme();
      return;
    }

    if (action === 'autohost') {
      const host = getHostKey();
      const current = !!state.settings.autoEnableByHost[host];
      state.settings.autoEnableByHost[host] = !current;
      saveSettings();
      alert(`本站默认阅读模式：${!current ? '已开启' : '已关闭'}`);
      return;
    }

    if (action === 'pick') {
      disableReader(false);
      startManualPickMode();
      return;
    }

    if (action === 'autopage') {
      state.settings.autoPageEnabled = !state.settings.autoPageEnabled;
      saveSettings();
      updateMeta();
      setAppendStatus(state.settings.autoPageEnabled ? '已开启连续阅读，到底自动加载下一章。' : '已关闭连续阅读。');
      return;
    }

    if (action === 'append-next') {
      appendNextChapter();
      return;
    }

    if (action === 'cache-book') {
      cacheEntireNovel();
      return;
    }

    if (action === 'export-md') {
      exportCurrentNovelAsMarkdown();
      return;
    }

    if (action === 'export-txt') {
      exportCurrentNovelAsTxt();
      return;
    }

    if (action === 'font-dec') {
      adjustFontSize(-1);
      return;
    }

    if (action === 'font-inc') {
      adjustFontSize(1);
      return;
    }

    if (action === 'width-dec') {
      adjustReaderWidth(-1);
      return;
    }

    if (action === 'width-inc') {
      adjustReaderWidth(1);
    }
  }

  function startManualPickMode() {
    if (state.picking) return;
    state.picking = true;

    const mask = document.createElement('div');
    mask.id = PICK_MASK_ID;
    mask.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      cursor: crosshair;
      background: rgba(0,0,0,.08);
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      border: 2px solid #4a90e2;
      background: rgba(74,144,226,.12);
      box-shadow: 0 0 0 99999px rgba(0,0,0,.18);
    `;

    const tip = document.createElement('div');
    tip.style.cssText = `
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: rgba(20,20,20,.92);
      color: #fff;
      border-radius: 10px;
      padding: 10px 14px;
      font: 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.25);
    `;
    tip.textContent = '手选正文：移动鼠标高亮区域，点击选中，Esc 取消';

    document.documentElement.appendChild(mask);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);

    state.pickerMask = mask;
    state.pickerBox = box;

    let currentTarget = null;

    function onMove(e) {
      mask.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      mask.style.pointerEvents = 'auto';

      if (!el || el === document.documentElement || el === document.body) return;
      if (el.id === FLOAT_BUTTON_ID) return;

      currentTarget = pickReadableAncestor(el);
      if (!currentTarget) return;

      const rect = currentTarget.getBoundingClientRect();
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();

      if (!currentTarget) return cleanup();

      state.pickedNode = currentTarget;

      if (state.settings.manualPickRemember) {
        const selector = buildSimpleSelector(currentTarget);
        saveManualPickSelectorForHost(selector);
      }

      cleanup();
      enableReader(currentTarget);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') cleanup();
    }

    function cleanup() {
      mask.removeEventListener('mousemove', onMove, true);
      mask.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);

      mask.remove();
      box.remove();
      tip.remove();

      state.pickerMask = null;
      state.pickerBox = null;
      state.picking = false;
    }

    mask.addEventListener('mousemove', onMove, true);
    mask.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  function pickReadableAncestor(el) {
    let cur = el;
    let best = null;
    let bestScore = -1;

    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur instanceof HTMLElement && isVisible(cur)) {
        const score = scoreContentElement(cur);
        if (score > bestScore) {
          best = cur;
          bestScore = score;
        }
      }
      cur = cur.parentElement;
    }

    return best;
  }

  function buildSimpleSelector(el) {
    if (!el || !(el instanceof HTMLElement)) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    let selector = el.tagName.toLowerCase();
    if (el.classList.length) {
      selector += '.' + Array.from(el.classList).slice(0, 3).map(c => CSS.escape(c)).join('.');
    }
    return selector;
  }

  function maybeTriggerAutoAppend() {
    if (!state.enabled || !state.settings.autoPageEnabled || state.isAppendingNextChapter) return;

    const scrollTop = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll <= 0) return;

    const ratio = scrollTop / maxScroll;
    if (ratio >= state.settings.autoPageScrollThreshold && !state.autoPagingTriggered) {
      state.autoPagingTriggered = true;
      clearTimeout(state.autoPageTimer);
      state.autoPageTimer = setTimeout(() => {
        appendNextChapter();
      }, 700);
    } else if (ratio < 0.9) {
      state.autoPagingTriggered = false;
    }
  }

  function goPrevPage() {
    const href = state.currentPrevUrl || state.navLinks.prev?.href;
    if (href) {
      location.href = href;
      return true;
    }
    return false;
  }

  function goNextPage() {
    const href = state.currentNextUrl || state.navLinks.next?.href;
    if (href) {
      location.href = href;
      return true;
    }
    return false;
  }

  async function fetchPageDocument(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  }

  function extractChapterContentFromDocument(doc, url) {
    const info = extractPageInfo(doc, null, url);
    if (!info || !info.contentHtml) {
      throw new Error('未识别到章节正文');
    }

    const title = info.title || doc.title || url;
    const temp = document.createElement('div');
    temp.innerHTML = info.contentHtml;
    const text = normalizeExportText(temp.innerText || temp.textContent || '');

    let nextHref = info.next?.href || '';

    if (!nextHref) {
      const anchors = Array.from(doc.querySelectorAll('a[href]'));
      let best = null;
      let bestScore = -999;

      for (const a of anchors) {
        const label = normalizeText(a.textContent);
        if (!label) continue;

        let href = '';
        try {
          href = new URL(a.getAttribute('href'), url).href;
        } catch {
          continue;
        }

        if (!href) continue;

        let score = 0;

        if (/下一章|下一页|下一节|后一章|后一页/.test(label)) score += 120;
        if (/next/i.test(label)) score += 60;
        if (/next|nxt|chapter|read|html/i.test((a.className || '') + ' ' + href)) score += 25;

        if (/首页|目录|返回|上一章|上页|投票|打赏|推荐|报错/.test(label)) score -= 200;

        if (score > bestScore) {
          bestScore = score;
          best = href;
        }
      }

      if (bestScore > 50) {
        nextHref = best;
      }
    }

    return {
      title: normalizeText(title),
      contentHtml: info.contentHtml,
      contentText: text,
      next: nextHref
    };
  }

  function createChapterAppendBlock(title, contentHtml, sourceUrl) {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-appended-chapter', '1');
    wrap.setAttribute('data-source-url', sourceUrl);
    wrap.style.cssText = `
      margin-top: 2.6em;
      padding-top: 2em;
      border-top: 1px dashed rgba(127,127,127,.35);
    `;

    let sep = '';
    if (state.settings.appendSeparator) {
      sep = `<div style="text-align:center;font-size:13px;opacity:.62;margin-bottom:1.4em;">—— 已连续加载下一章 ——</div>`;
    }

    wrap.innerHTML = `
      ${sep}
      <h2 style="margin:0 0 1em 0;text-indent:0;">
        ${escapeHtml(title || '下一章')}
      </h2>
      <div class="${APP_ID}-chapter-body">
        ${contentHtml}
      </div>
    `;

    return wrap;
  }

  async function appendNextChapter() {
    if (!state.enabled || !state.readerContent) return false;
    if (state.isAppendingNextChapter) return false;

    const nextUrl = state.currentNextUrl || state.navLinks.next?.href;
    if (!nextUrl) {
      setAppendStatus('没有识别到下一章链接。');
      return false;
    }

    const absNextUrl = absoluteUrl(nextUrl);
    if (!absNextUrl) {
      setAppendStatus('下一章链接无效。');
      return false;
    }

    if (state.loadedChapterUrls.has(absNextUrl)) {
      setAppendStatus('下一章已加载，避免重复拼接。');
      return false;
    }

    if (state.appendedChapterCount >= state.settings.maxAutoAppendChapters) {
      setAppendStatus(`已达到连续拼接上限（${state.settings.maxAutoAppendChapters} 章）。`);
      return false;
    }

    state.isAppendingNextChapter = true;
    setAppendStatus('正在加载下一章……');

    try {
      const doc = await fetchPageDocument(absNextUrl);
      const info = extractPageInfo(doc, null, absNextUrl);

      if (!info || !info.contentHtml || info.contentHtml.replace(/\s+/g, '').length < 60) {
        throw new Error('未识别到下一章正文');
      }

      const block = createChapterAppendBlock(info.title, info.contentHtml, absNextUrl);
      state.readerContent.appendChild(block);
      applyReaderTypography();

      state.loadedChapterUrls.add(absNextUrl);
      try {
        const u = new URL(absNextUrl);
        state.loadedChapterUrls.add(u.pathname + u.search);
      } catch {}

      state.appendedChapterCount += 1;
      state.currentNextUrl = info.next?.href || '';
      state.currentPrevUrl = info.prev?.href || state.currentPrevUrl;
      state.currentIndexUrl = info.index?.href || state.currentIndexUrl;
      state.navLinks.next = info.next || state.navLinks.next;
      state.navLinks.prev = info.prev || state.navLinks.prev;
      state.navLinks.index = info.index || state.navLinks.index;

      updateMeta();
      setAppendStatus(`已加载：${info.title || '下一章'}`);
      state.autoPagingTriggered = false;
      return true;
    } catch (err) {
      console.error('[Universal Reader Lite Ultimate Sequential] append next failed:', err);
      setAppendStatus(`加载下一章失败：${err.message || err}`);
      return false;
    } finally {
      state.isAppendingNextChapter = false;
    }
  }

  async function cacheEntireNovel() {
    if (state.novelCacheJob?.running) {
      setAppendStatus('已有缓存任务在运行。');
      return;
    }

    const novelTitle = extractNovelNameFromPage();
    const bookId = makeBookId(novelTitle);

    state.novelCacheJob = {
      running: true,
      bookId,
      total: 0,
      done: 0
    };

    await NOVEL_DB.putBook({
      bookId,
      title: novelTitle,
      host: location.hostname,
      sourceUrl: location.href,
      chapterCount: 0,
      updatedAt: Date.now()
    });

    setAppendStatus(`开始从当前页沿“下一章”缓存：《${novelTitle}》`);

    const visited = new Set();
    let currentUrl = location.href;
    let count = 0;
    const maxCount = 5000;

    try {
      while (currentUrl && count < maxCount) {
        const normalizedUrl = (() => {
          try {
            const u = new URL(currentUrl);
            return u.origin + u.pathname + u.search;
          } catch {
            return currentUrl;
          }
        })();

        if (visited.has(normalizedUrl)) {
          setAppendStatus(`检测到重复章节链接，停止。共缓存 ${count} 章`);
          break;
        }
        visited.add(normalizedUrl);

        try {
          const doc = count === 0 ? document : await fetchPageDocument(currentUrl);
          const data = extractChapterContentFromDocument(doc, currentUrl);

          await NOVEL_DB.putChapter({
            chapterKey: `${bookId}::${count}`,
            bookId,
            order: count,
            title: data.title || `第 ${count + 1} 章`,
            url: currentUrl,
            contentText: data.contentText,
            contentHtml: data.contentHtml,
            updatedAt: Date.now()
          });

          count += 1;
          state.novelCacheJob.done = count;
          state.novelCacheJob.total = count;

          setAppendStatus(`缓存中：第 ${count} 章 - ${data.title || '未命名章节'}`);

          const nextUrl = data.next ? absoluteUrl(data.next, currentUrl) : '';
          if (!nextUrl) {
            setAppendStatus(`已到末章，共缓存 ${count} 章`);
            break;
          }

          const normalizedNext = (() => {
            try {
              const u = new URL(nextUrl);
              return u.origin + u.pathname + u.search;
            } catch {
              return nextUrl;
            }
          })();

          if (visited.has(normalizedNext)) {
            setAppendStatus(`下一章已访问过，停止。共缓存 ${count} 章`);
            break;
          }

          currentUrl = nextUrl;
        } catch (err) {
          console.error('[NovelCache] chapter cache failed:', currentUrl, err);
          setAppendStatus(`缓存失败，停止于第 ${count + 1} 章：${err.message || err}`);
          break;
        }
      }

      await NOVEL_DB.putBook({
        bookId,
        title: novelTitle,
        host: location.hostname,
        sourceUrl: location.href,
        chapterCount: count,
        updatedAt: Date.now()
      });

      setAppendStatus(`缓存完成：《${novelTitle}》 共 ${count} 章`);
    } finally {
      state.novelCacheJob.running = false;
    }
  }

  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportCurrentNovelAsTxt() {
    const title = extractNovelNameFromPage();
    const bookId = makeBookId(title);
    const chapters = await NOVEL_DB.getChaptersByBook(bookId);

    if (!chapters.length) {
      alert('没有找到已缓存章节，请先执行“顺序缓存”。');
      return;
    }

    const parts = [];
    parts.push(title);
    parts.push('');
    parts.push(`来源：${location.hostname}`);
    parts.push('');

    for (const ch of chapters) {
      if (!ch.contentText) continue;
      parts.push(ch.title || '');
      parts.push('');
      parts.push(ch.contentText);
      parts.push('');
      parts.push('');
    }

    const blob = new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' });
    downloadBlob(`${safeFilename(title)}.txt`, blob);
  }

  async function exportCurrentNovelAsMarkdown() {
    const title = extractNovelNameFromPage();
    const bookId = makeBookId(title);
    const chapters = await NOVEL_DB.getChaptersByBook(bookId);

    if (!chapters.length) {
      alert('没有找到已缓存章节，请先执行“顺序缓存”。');
      return;
    }

    const lines = [];

    if (state.settings.exportMarkdownWithFrontMatter) {
      lines.push('---');
      lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
      lines.push(`source: "${location.hostname}"`);
      lines.push(`chapter_count: ${chapters.length}`);
      lines.push('---');
      lines.push('');
    }

    lines.push(`# ${title}`);
    lines.push('');

    for (const ch of chapters) {
      if (!ch.contentText) continue;
      lines.push(`## ${ch.title || '未命名章节'}`);
      lines.push('');
      lines.push(ch.contentText);
      lines.push('');
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(`${safeFilename(title)}.md`, blob);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function onWindowScroll() {
    if (!state.enabled) return;
    maybeTriggerAutoAppend();
  }

  function onKeydown(e) {
    if (e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      toggleReader();
      return;
    }

    if (e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (state.enabled) disableReader(false);
      startManualPickMode();
      return;
    }

    if (e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (state.enabled) appendNextChapter();
      return;
    }

    if (e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      if (state.enabled) cacheEntireNovel();
      return;
    }

    if (e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      if (state.enabled) exportCurrentNovelAsMarkdown();
      return;
    }

    if (e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      if (state.enabled) exportCurrentNovelAsTxt();
      return;
    }

    if (state.picking && e.key === 'Escape') return;

    if (state.enabled && e.key === 'Escape') {
      e.preventDefault();
      disableReader();
      return;
    }

    if (!state.enabled) return;

    if (e.altKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      adjustFontSize(1);
      return;
    }

    if (e.altKey && e.key === '-') {
      e.preventDefault();
      adjustFontSize(-1);
      return;
    }

    if (e.altKey && e.key === ']') {
      e.preventDefault();
      adjustReaderWidth(1);
      return;
    }

    if (e.altKey && e.key === '[') {
      e.preventDefault();
      adjustReaderWidth(-1);
      return;
    }

    if (e.key === '[') {
      e.preventDefault();
      goPrevPage();
      return;
    }

    if (e.key === ']') {
      e.preventDefault();
      if (e.shiftKey) {
        state.settings.autoPageEnabled = !state.settings.autoPageEnabled;
        saveSettings();
        updateMeta();
        setAppendStatus(state.settings.autoPageEnabled ? '已开启连续阅读，到底自动加载下一章。' : '已关闭连续阅读。');
      } else {
        goNextPage();
      }
    }
  }

  function autoEnableIfNeeded() {
    const host = getHostKey();
    if (state.settings.autoEnableByHost[host]) {
      enableReader();
    }
  }

  function init() {
    createFloatButton();
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    document.addEventListener('keydown', onKeydown, true);
    autoEnableIfNeeded();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();