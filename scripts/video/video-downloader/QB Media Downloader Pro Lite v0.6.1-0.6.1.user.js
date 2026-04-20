// ==UserScript==
// @name         QB Media Downloader Pro Lite v0.6.1
// @namespace    http://tampermonkey.net/
// @version      0.6.1
// @description  公开媒体资源检测与下载：默认折叠、独立入口按钮、当前播放媒体、勾选批处理、下载队列、单任务取消、队列排序、自动重试、搜索、导出 txt/json、非加密 m3u8 自动最高画质
// @author       OpenAI
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "qb_media_config_v061";

  const QB = {
    defaults: {
      panelWidth: 620,
      scanInterval: 1500,
      probeTimeout: 15000,
      maxTsConcurrency: 8,
      autoProbeOnAdd: true,
      detectFromDom: true,
      detectFromPerformance: true,
      detectFromNetworkHook: true,
      detectCurrentlyPlaying: true,
      autoOpenOnNewItem: false,
      autoIndexFileName: true,
      queueConcurrency: 2,
      defaultCollapsed: true,
      autoRetryCount: 2,
      autoRetryDelayMs: 1200,
      hlsSegmentRetryCount: 2,
      showPageEntryLink: true,
    },

    config: null,

    state: {
      seq: 0,
      urlSet: new Set(),
      resources: new Map(),
      activeTab: "video",
      playerVisible: false,
      filterMode: "all",
      searchText: "",
      queuePanelOnly: false,

      queue: [],
      queuePaused: true,
      queueRunningCount: 0,
      queueSeq: 0,

      cancelledResourceIds: new Set(),
    }
  };

  QB.config = loadConfig();

  function loadConfig() {
    try {
      const saved = GM_getValue(STORE_KEY, null);
      if (!saved) return { ...QB.defaults };
      const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
      return { ...QB.defaults, ...(parsed || {}) };
    } catch {
      return { ...QB.defaults };
    }
  }

  function saveConfig() {
    try {
      GM_setValue(STORE_KEY, JSON.stringify(QB.config));
    } catch {}
  }

  function log(...args) {
    console.log("[QBMedia]", ...args);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizeUrl(url, base = location.href) {
    if (!url) return "";
    try {
      return new URL(String(url).trim(), base).href;
    } catch {
      return String(url).trim();
    }
  }

  function sanitizeFileName(name, fallback = "media") {
    const s = String(name || fallback)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    return s || fallback;
  }

  function parseHeaders(raw = "") {
    const headers = {};
    String(raw).split(/\r?\n/).forEach(line => {
      const i = line.indexOf(":");
      if (i > 0) {
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        headers[k] = v;
      }
    });
    return headers;
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let x = n;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return `${x.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function guessExt(url = "", contentType = "") {
    const ct = String(contentType).toLowerCase();

    if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return "m3u8";
    if (ct.includes("video/mp4")) return "mp4";
    if (ct.includes("video/webm")) return "webm";
    if (ct.includes("video/quicktime")) return "mov";
    if (ct.includes("audio/mpeg")) return "mp3";
    if (ct.includes("audio/mp4")) return "m4a";
    if (ct.includes("audio/aac")) return "aac";
    if (ct.includes("audio/ogg")) return "ogg";
    if (ct.includes("audio/wav")) return "wav";

    try {
      const p = new URL(url).pathname;
      const m = p.match(/\.([a-z0-9]{2,6})$/i);
      return m ? m[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function classifyMedia({ url = "", contentType = "", text = "" }) {
    const ct = String(contentType).toLowerCase();

    if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) {
      return { kind: "video", type: "hls" };
    }
    if (ct.startsWith("video/")) {
      return { kind: "video", type: "normal" };
    }
    if (ct.startsWith("audio/")) {
      return { kind: "audio", type: "normal" };
    }
    if (/^#EXTM3U/m.test(text)) {
      return { kind: "video", type: "hls" };
    }
    if (/\.(m3u8)(\?|$)/i.test(url)) {
      return { kind: "video", type: "hls" };
    }
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
      return { kind: "video", type: "normal" };
    }
    if (/\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(url)) {
      return { kind: "audio", type: "normal" };
    }
    return null;
  }

  function extractBestTitle(kind = "video") {
    const candidates = [];

    const og = document.querySelector('meta[property="og:title"]')?.content;
    const twitter = document.querySelector('meta[name="twitter:title"]')?.content;
    const h1 = document.querySelector("h1")?.textContent;
    const titleEl = document.querySelector("[data-title], .title, .video-title, .player-title")?.textContent;
    const docTitle = document.title;

    [og, twitter, h1, titleEl, docTitle].forEach(v => {
      if (v && String(v).trim()) candidates.push(String(v).trim());
    });

    const best = candidates
      .map(x => x.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];

    return sanitizeFileName(best || (kind === "audio" ? "audio" : "video"));
  }

  function createResource(partial = {}) {
    return {
      id: `qb_${Date.now()}_${++QB.state.seq}`,
      url: "",
      finalUrl: "",
      pageUrl: location.href,
      pageTitle: document.title || "",
      name: "",
      ext: "",
      kind: "video",
      type: "normal",
      quality: "",
      size: 0,
      contentType: "",
      source: "unknown",
      status: "idle",
      progress: 0,
      progressText: "",
      error: "",
      headers: {},
      addedAt: Date.now(),
      selected: false,
      queueState: "none",
      retryCount: 0,
      maxRetry: QB.config.autoRetryCount,
      ...partial,
    };
  }

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: QB.config.probeTimeout,
        ...details,
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error("timeout")),
        onabort: () => reject(new Error("aborted")),
      });
    });
  }

  function matchesSearch(resource) {
    const q = QB.state.searchText.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      resource.name,
      resource.kind,
      resource.type,
      resource.quality,
      resource.status,
      resource.source,
      resource.finalUrl || resource.url,
      resource.pageTitle,
    ].join(" ").toLowerCase();
    return hay.includes(q);
  }

  function getResourcesByKind(kind) {
    let items = [...QB.state.resources.values()]
      .filter(r => r.kind === kind)
      .sort((a, b) => b.addedAt - a.addedAt);

    if (QB.state.filterMode !== "all") {
      items = items.filter(r => r.status === QB.state.filterMode);
    }

    items = items.filter(matchesSearch);

    if (QB.state.queuePanelOnly) {
      items = items.filter(r => r.queueState === "queued" || r.queueState === "running");
    }

    return items;
  }

  function getAllTabResourcesUnfiltered(kind) {
    return [...QB.state.resources.values()]
      .filter(r => r.kind === kind)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  function getSelectedInCurrentTab() {
    return getAllTabResourcesUnfiltered(QB.state.activeTab).filter(r => r.selected);
  }

  function openPanel() {
    const panel = document.getElementById("qb-media-panel");
    const mini = document.getElementById("qb-mini-ball");
    if (panel) panel.style.display = "block";
    if (mini) mini.style.display = "none";
  }

  function closePanel() {
    const panel = document.getElementById("qb-media-panel");
    const mini = document.getElementById("qb-mini-ball");
    if (panel) panel.style.display = "none";
    if (mini) mini.style.display = "block";
  }

  function ensurePanel() {
    if (document.getElementById("qb-media-panel")) return;

    const panel = document.createElement("div");
    panel.id = "qb-media-panel";
    panel.innerHTML = `
      <div id="qb-media-header">
        <div class="qb-title"><strong>媒体资源</strong></div>
        <div class="qb-toolbar">
          <button id="qb-save-config-btn" title="保存设置">保存设置</button>
          <button id="qb-min-btn" title="最小化">—</button>
        </div>
      </div>

      <div id="qb-media-tip">
        支持公开媒体地址、页面已播放媒体、普通音视频、非加密 m3u8 自动最高画质。<br>
        不支持 DRM、加密 HLS、仅 blob 且无法还原真实地址。
      </div>

      <div id="qb-entry-note">
        当前可通过右上角按钮或页面左下角“打开下载面板”入口打开。
      </div>

      <div id="qb-input-row">
        <input id="qb-manual-url" placeholder="手动添加资源 URL（mp4/mp3/m3u8 等）">
        <input id="qb-manual-name" placeholder="文件名（可选）">
        <button id="qb-add-btn">添加</button>
      </div>

      <div id="qb-tab-row">
        <button class="qb-tab active" data-tab="video">🎬 视频</button>
        <button class="qb-tab" data-tab="audio">🎧 音频</button>
      </div>

      <div id="qb-search-row">
        <input id="qb-search-input" placeholder="搜索：名称 / URL / 来源 / 状态 / 画质">
        <button id="qb-search-clear-btn">清空搜索</button>
      </div>

      <div id="qb-filter-row">
        <select id="qb-filter-select">
          <option value="all">全部状态</option>
          <option value="ready">ready</option>
          <option value="downloading">downloading</option>
          <option value="done">done</option>
          <option value="error">error</option>
          <option value="unsupported">unsupported</option>
          <option value="cancelled">cancelled</option>
        </select>
        <input id="qb-queue-concurrency" type="number" min="1" max="8" value="${QB.config.queueConcurrency}" title="最大同时下载数">
        <button id="qb-scan-btn">扫描</button>
        <button id="qb-remove-failed-btn">删失败项</button>
      </div>

      <div id="qb-config-row">
        <label><input type="checkbox" id="qb-opt-collapsed"> 默认折叠</label>
        <label><input type="checkbox" id="qb-opt-indexname"> 自动编号命名</label>
        <label><input type="checkbox" id="qb-opt-entrylink"> 显示页面入口</label>
        <label><input type="checkbox" id="qb-opt-queueonly"> 只看队列</label>
      </div>

      <div id="qb-action-row">
        <button id="qb-select-all-btn">全选当前 tab</button>
        <button id="qb-invert-select-btn">反选当前 tab</button>
        <button id="qb-copy-selected-btn">复制选中</button>
        <button id="qb-remove-selected-btn">删除选中</button>
      </div>

      <div id="qb-action-row-2">
        <button id="qb-queue-selected-btn">选中加入队列</button>
        <button id="qb-queue-tab-btn">当前 tab 加入队列</button>
        <button id="qb-start-queue-btn">开始队列</button>
        <button id="qb-pause-queue-btn">暂停队列</button>
        <button id="qb-resume-queue-btn">恢复队列</button>
        <button id="qb-clear-queue-btn">清空等待队列</button>
      </div>

      <div id="qb-action-row-3">
        <button id="qb-copy-tab-btn">复制当前 tab</button>
        <button id="qb-download-tab-btn">全部直接下载</button>
        <button id="qb-clear-tab-btn">清空当前 tab</button>
        <button id="qb-export-txt-btn">导出 txt</button>
        <button id="qb-export-json-btn">导出 json</button>
      </div>

      <div id="qb-summary-row"></div>
      <div id="qb-queue-summary-row"></div>

      <div id="qb-player-wrap" style="display:none;">
        <div id="qb-player-header">
          <span>预览播放器</span>
          <button id="qb-player-close">关闭</button>
        </div>
        <div id="qb-player-body"></div>
      </div>

      <div id="qb-list-wrap">
        <div id="qb-list-video" class="qb-list"></div>
        <div id="qb-list-audio" class="qb-list" style="display:none;"></div>
      </div>
    `;

    document.body.appendChild(panel);

    if (!document.getElementById("qb-mini-ball")) {
      const miniBall = document.createElement("div");
      miniBall.id = "qb-mini-ball";
      miniBall.textContent = "⤵️";
      miniBall.style.display = "none";
      document.body.appendChild(miniBall);
    }

    if (!document.getElementById("qb-page-entry-link")) {
      const entryLink = document.createElement("div");
      entryLink.id = "qb-page-entry-link";
      entryLink.textContent = "打开下载面板";
      entryLink.style.display = "none";
      document.body.appendChild(entryLink);
    }

    GM_addStyle(`
      #qb-media-panel{
        position:fixed; top:10px; right:10px; width:${QB.config.panelWidth}px;
        max-height:82vh; overflow:auto; z-index:2147483647; background:#fff; color:#111;
        border:1px solid #dcdfe6; border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,.18);
        font-size:12px; padding:10px; line-height:1.4;
      }
      #qb-media-header{
        display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;
      }
      .qb-title{ font-size:14px; }
      #qb-media-tip, #qb-entry-note{
        line-height:1.5; color:#555; background:#f7f7f8; border-radius:8px; padding:8px; margin-bottom:8px;
      }
      #qb-input-row{
        display:grid; grid-template-columns:1fr 130px 58px; gap:6px; margin-bottom:8px;
      }
      #qb-search-row{
        display:grid; grid-template-columns:1fr 90px; gap:6px; margin-bottom:8px;
      }
      #qb-input-row input, #qb-search-input, #qb-filter-select, #qb-queue-concurrency{
        width:100%; box-sizing:border-box; border:1px solid #d1d5db; border-radius:8px; padding:7px 8px;
      }
      #qb-tab-row, #qb-filter-row, #qb-config-row, #qb-action-row, #qb-action-row-2, #qb-action-row-3{
        display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;
      }
      #qb-config-row label{
        display:flex; align-items:center; gap:4px; padding:4px 6px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px;
      }
      .qb-tab{
        flex:1; border:1px solid #d1d5db; background:#f3f4f6; border-radius:8px; padding:7px 0; cursor:pointer;
      }
      .qb-tab.active{
        background:#2563eb; color:#fff; border-color:#2563eb;
      }
      #qb-filter-select{ flex:1; min-width:120px; }
      #qb-queue-concurrency{ width:80px; }
      #qb-summary-row, #qb-queue-summary-row{
        background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:6px 8px; margin-bottom:8px; color:#444;
      }
      #qb-player-wrap{
        border:1px solid #e5e7eb; border-radius:10px; overflow:hidden; margin-bottom:8px;
      }
      #qb-player-header{
        display:flex; justify-content:space-between; align-items:center; background:#f9fafb; padding:8px 10px; border-bottom:1px solid #e5e7eb;
      }
      #qb-player-body{
        background:#000; padding:8px;
      }
      #qb-player-body video,#qb-player-body audio{
        width:100%; max-height:320px; background:#000;
      }
      .qb-list{ min-height:50px; }
      .qb-empty{ color:#888; padding:10px 4px; }
      .qb-item{
        border:1px solid #e5e7eb; border-radius:10px; padding:8px; margin-bottom:8px; background:#fff;
      }
      .qb-item-head{
        display:flex; gap:8px; align-items:flex-start;
      }
      .qb-check{ margin-top:2px; }
      .qb-main{ flex:1; min-width:0; }
      .qb-name{ font-weight:600; margin-bottom:4px; }
      .qb-meta{ color:#444; margin:2px 0; }
      .qb-url{
        word-break:break-all; color:#444; background:#fafafa; border-radius:6px; padding:6px; margin-top:6px;
      }
      .qb-actions, .qb-queue-actions{
        display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;
      }
      .qb-actions button,
      .qb-queue-actions button,
      #qb-action-row button,
      #qb-action-row-2 button,
      #qb-action-row-3 button,
      #qb-filter-row button,
      #qb-search-row button,
      #qb-input-row button,
      #qb-player-header button,
      #qb-save-config-btn,
      #qb-min-btn{
        border:1px solid #d1d5db; background:#fff; border-radius:8px; padding:5px 8px; cursor:pointer;
      }
      .qb-actions button:hover,
      .qb-queue-actions button:hover,
      #qb-action-row button:hover,
      #qb-action-row-2 button:hover,
      #qb-action-row-3 button:hover,
      #qb-filter-row button:hover,
      #qb-search-row button:hover,
      #qb-input-row button:hover,
      #qb-player-header button:hover,
      #qb-save-config-btn:hover,
      #qb-min-btn:hover{
        background:#f3f4f6;
      }
      .qb-status-ready{ color:#16a34a; }
      .qb-status-error,.qb-status-unsupported,.qb-status-cancelled{ color:#dc2626; }
      .qb-status-downloading,.qb-status-probing{ color:#2563eb; }
      .qb-badge{
        display:inline-block; margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#eff6ff; color:#1d4ed8;
      }
      .qb-qstate{
        display:inline-block; margin-left:6px; padding:1px 6px; border-radius:999px; font-size:11px; background:#f3f4f6; color:#374151;
      }
      #qb-mini-ball{
        position:fixed; top:10px; right:10px; z-index:2147483647; background:#fff;
        border:1px solid #dcdfe6; border-radius:999px; padding:8px 10px;
        box-shadow:0 8px 28px rgba(0,0,0,.18); cursor:pointer;
      }
      #qb-page-entry-link{
        position:fixed; left:12px; bottom:12px; z-index:2147483646;
        background:#ffffff; color:#2563eb; border:1px solid #cbd5e1; border-radius:999px;
        padding:8px 12px; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,.12);
        font-size:13px; line-height:1;
      }
      #qb-page-entry-link:hover{
        background:#eff6ff;
      }
    `);

    bindPanelEvents();
    syncConfigToUI();

    const pageEntry = document.getElementById("qb-page-entry-link");
    if (QB.config.showPageEntryLink && pageEntry) {
      pageEntry.style.display = "block";
    }

    if (QB.config.defaultCollapsed) {
      closePanel();
    } else {
      openPanel();
    }

    refreshAllLists();
  }

  function syncConfigToUI() {
    const elCollapsed = document.getElementById("qb-opt-collapsed");
    const elIndex = document.getElementById("qb-opt-indexname");
    const elEntry = document.getElementById("qb-opt-entrylink");
    const elQueueOnly = document.getElementById("qb-opt-queueonly");
    const elConcurrency = document.getElementById("qb-queue-concurrency");

    if (elCollapsed) elCollapsed.checked = !!QB.config.defaultCollapsed;
    if (elIndex) elIndex.checked = !!QB.config.autoIndexFileName;
    if (elEntry) elEntry.checked = !!QB.config.showPageEntryLink;
    if (elQueueOnly) elQueueOnly.checked = !!QB.state.queuePanelOnly;
    if (elConcurrency) elConcurrency.value = String(QB.config.queueConcurrency);
  }

  function applyConfigUI() {
    const entry = document.getElementById("qb-page-entry-link");
    if (entry) entry.style.display = QB.config.showPageEntryLink ? "block" : "none";
    refreshAllLists();
  }

  function bindPanelEvents() {
    document.getElementById("qb-min-btn").addEventListener("click", closePanel);

    const miniBall = document.getElementById("qb-mini-ball");
    if (miniBall) miniBall.addEventListener("click", openPanel);

    const pageEntry = document.getElementById("qb-page-entry-link");
    if (pageEntry) pageEntry.addEventListener("click", openPanel);

    document.getElementById("qb-save-config-btn").addEventListener("click", () => {
      saveConfig();
    });

    document.getElementById("qb-opt-collapsed").addEventListener("change", (e) => {
      QB.config.defaultCollapsed = !!e.target.checked;
    });

    document.getElementById("qb-opt-indexname").addEventListener("change", (e) => {
      QB.config.autoIndexFileName = !!e.target.checked;
      refreshAllLists();
    });

    document.getElementById("qb-opt-entrylink").addEventListener("change", (e) => {
      QB.config.showPageEntryLink = !!e.target.checked;
      applyConfigUI();
    });

    document.getElementById("qb-opt-queueonly").addEventListener("change", (e) => {
      QB.state.queuePanelOnly = !!e.target.checked;
      refreshAllLists();
    });

    document.getElementById("qb-add-btn").addEventListener("click", () => {
      const url = document.getElementById("qb-manual-url").value.trim();
      const name = document.getElementById("qb-manual-name").value.trim();
      if (!url) return;
      addCandidate({ url, name, source: "manual" });
      document.getElementById("qb-manual-url").value = "";
    });

    document.querySelectorAll(".qb-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        setActiveTab(btn.dataset.tab);
      });
    });

    document.getElementById("qb-search-input").addEventListener("input", (e) => {
      QB.state.searchText = e.target.value || "";
      refreshAllLists();
    });

    document.getElementById("qb-search-clear-btn").addEventListener("click", () => {
      QB.state.searchText = "";
      document.getElementById("qb-search-input").value = "";
      refreshAllLists();
    });

    document.getElementById("qb-filter-select").addEventListener("change", (e) => {
      QB.state.filterMode = e.target.value;
      refreshAllLists();
    });

    document.getElementById("qb-queue-concurrency").addEventListener("change", (e) => {
      let v = Number(e.target.value || 1);
      if (!Number.isFinite(v) || v < 1) v = 1;
      if (v > 8) v = 8;
      QB.config.queueConcurrency = v;
      e.target.value = String(v);
      processQueue();
      refreshQueueSummary();
    });

    document.getElementById("qb-scan-btn").addEventListener("click", scanAll);

    document.getElementById("qb-remove-failed-btn").addEventListener("click", () => {
      const all = getAllTabResourcesUnfiltered(QB.state.activeTab);
      for (const item of all) {
        if (item.status === "error" || item.status === "unsupported" || item.status === "cancelled") {
          removeFromQueueByResourceId(item.id);
          QB.state.resources.delete(item.id);
          QB.state.urlSet.delete(item.url);
        }
      }
      refreshAllLists();
    });

    document.getElementById("qb-select-all-btn").addEventListener("click", () => {
      const all = getAllTabResourcesUnfiltered(QB.state.activeTab);
      all.forEach(x => x.selected = true);
      refreshAllLists();
    });

    document.getElementById("qb-invert-select-btn").addEventListener("click", () => {
      const all = getAllTabResourcesUnfiltered(QB.state.activeTab);
      all.forEach(x => x.selected = !x.selected);
      refreshAllLists();
    });

    document.getElementById("qb-copy-selected-btn").addEventListener("click", () => {
      const items = getSelectedInCurrentTab();
      const text = items.map(x => x.finalUrl || x.url).join("\n\n");
      if (text.trim()) GM_setClipboard(text);
    });

    document.getElementById("qb-remove-selected-btn").addEventListener("click", () => {
      const items = getSelectedInCurrentTab();
      for (const item of items) {
        cancelResource(item.id, false);
        removeFromQueueByResourceId(item.id);
        QB.state.resources.delete(item.id);
        QB.state.urlSet.delete(item.url);
      }
      refreshAllLists();
    });

    document.getElementById("qb-queue-selected-btn").addEventListener("click", () => {
      enqueueResources(getSelectedInCurrentTab());
    });

    document.getElementById("qb-queue-tab-btn").addEventListener("click", () => {
      enqueueResources(getAllTabResourcesUnfiltered(QB.state.activeTab));
    });

    document.getElementById("qb-start-queue-btn").addEventListener("click", () => {
      QB.state.queuePaused = false;
      processQueue();
      refreshQueueSummary();
    });

    document.getElementById("qb-pause-queue-btn").addEventListener("click", () => {
      QB.state.queuePaused = true;
      refreshQueueSummary();
    });

    document.getElementById("qb-resume-queue-btn").addEventListener("click", () => {
      QB.state.queuePaused = false;
      processQueue();
      refreshQueueSummary();
    });

    document.getElementById("qb-clear-queue-btn").addEventListener("click", () => {
      clearWaitingQueue();
      refreshAllLists();
    });

    document.getElementById("qb-copy-tab-btn").addEventListener("click", () => {
      const items = getAllTabResourcesUnfiltered(QB.state.activeTab);
      const text = items.map(x => x.finalUrl || x.url).join("\n\n");
      if (text.trim()) GM_setClipboard(text);
    });

    document.getElementById("qb-download-tab-btn").addEventListener("click", async () => {
      const items = getAllTabResourcesUnfiltered(QB.state.activeTab);
      for (const item of items) {
        startDownload(item.id);
      }
    });

    document.getElementById("qb-clear-tab-btn").addEventListener("click", () => {
      const items = getAllTabResourcesUnfiltered(QB.state.activeTab);
      for (const item of items) {
        cancelResource(item.id, false);
        removeFromQueueByResourceId(item.id);
        QB.state.resources.delete(item.id);
        QB.state.urlSet.delete(item.url);
      }
      refreshAllLists();
    });

    document.getElementById("qb-export-txt-btn").addEventListener("click", exportCurrentTabAsTxt);
    document.getElementById("qb-export-json-btn").addEventListener("click", exportCurrentTabAsJson);
    document.getElementById("qb-player-close").addEventListener("click", hidePlayer);
  }

  function setActiveTab(tab) {
    QB.state.activeTab = tab;
    document.querySelectorAll(".qb-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.getElementById("qb-list-video").style.display = tab === "video" ? "block" : "none";
    document.getElementById("qb-list-audio").style.display = tab === "audio" ? "block" : "none";
    refreshSummary();
  }

  function refreshSummary() {
    const current = getAllTabResourcesUnfiltered(QB.state.activeTab);
    const selected = current.filter(x => x.selected).length;
    const ready = current.filter(x => x.status === "ready").length;
    const downloading = current.filter(x => x.status === "downloading").length;
    const done = current.filter(x => x.status === "done").length;
    const failed = current.filter(x => ["error", "unsupported", "cancelled"].includes(x.status)).length;

    const el = document.getElementById("qb-summary-row");
    if (!el) return;
    el.textContent = `当前 tab：${QB.state.activeTab} ｜ 总数 ${current.length} ｜ 已选 ${selected} ｜ ready ${ready} ｜ downloading ${downloading} ｜ done ${done} ｜ failed ${failed} ｜ search ${QB.state.searchText ? "on" : "off"} ｜ queueOnly ${QB.state.queuePanelOnly ? "on" : "off"}`;
  }

  function refreshQueueSummary() {
    const queued = QB.state.queue.filter(x => x.state === "queued").length;
    const running = QB.state.queue.filter(x => x.state === "running").length;
    const finished = QB.state.queue.filter(x => x.state === "done").length;
    const failed = QB.state.queue.filter(x => x.state === "failed").length;
    const paused = QB.state.queuePaused ? "paused" : "running";

    const el = document.getElementById("qb-queue-summary-row");
    if (!el) return;
    el.textContent = `队列：${paused} ｜ 并发上限 ${QB.config.queueConcurrency} ｜ waiting ${queued} ｜ running ${running} ｜ done ${finished} ｜ failed ${failed}`;
  }

  function showPlayer(res) {
    const wrap = document.getElementById("qb-player-wrap");
    const body = document.getElementById("qb-player-body");
    wrap.style.display = "block";

    const url = res.finalUrl || res.url;
    if (res.kind === "audio") {
      body.innerHTML = `<audio controls src="${escapeHtml(url)}"></audio>`;
    } else {
      body.innerHTML = `<video controls src="${escapeHtml(url)}"></video>`;
    }
    QB.state.playerVisible = true;
  }

  function hidePlayer() {
    const wrap = document.getElementById("qb-player-wrap");
    const body = document.getElementById("qb-player-body");
    body.innerHTML = "";
    wrap.style.display = "none";
    QB.state.playerVisible = false;
  }

  function refreshAllLists() {
    renderList("video");
    renderList("audio");
    refreshSummary();
    refreshQueueSummary();
  }

  function renderList(kind) {
    const list = document.getElementById(kind === "video" ? "qb-list-video" : "qb-list-audio");
    if (!list) return;

    const items = getResourcesByKind(kind);
    if (!items.length) {
      list.innerHTML = `<div class="qb-empty">暂时没有${kind === "video" ? "视频" : "音频"}资源</div>`;
      return;
    }

    list.innerHTML = items.map((res, idx) => renderItemHtml(res, idx + 1)).join("");

    items.forEach(res => {
      const root = document.getElementById(res.id);
      if (!root) return;

      const checkbox = root.querySelector('[data-act="select"]');
      checkbox.checked = !!res.selected;
      checkbox.onchange = () => {
        res.selected = checkbox.checked;
        refreshSummary();
      };

      root.querySelector('[data-act="copy"]').onclick = () => GM_setClipboard(res.finalUrl || res.url);
      root.querySelector('[data-act="open"]').onclick = () => window.open(res.finalUrl || res.url, "_blank");
      root.querySelector('[data-act="probe"]').onclick = () => probeResource(res.id);
      root.querySelector('[data-act="play"]').onclick = () => showPlayer(res);
      root.querySelector('[data-act="enqueue"]').onclick = () => enqueueResources([res]);
      root.querySelector('[data-act="download"]').onclick = () => startDownload(res.id);
      root.querySelector('[data-act="cancel"]').onclick = () => cancelResource(res.id, true);
      root.querySelector('[data-act="remove"]').onclick = () => {
        cancelResource(res.id, false);
        removeFromQueueByResourceId(res.id);
        QB.state.resources.delete(res.id);
        QB.state.urlSet.delete(res.url);
        refreshAllLists();
      };

      const topBtn = root.querySelector('[data-act="qtop"]');
      const upBtn = root.querySelector('[data-act="qup"]');
      const downBtn = root.querySelector('[data-act="qdown"]');
      const outBtn = root.querySelector('[data-act="qremove"]');

      if (topBtn) topBtn.onclick = () => queueMoveTop(res.id);
      if (upBtn) upBtn.onclick = () => queueMoveUp(res.id);
      if (downBtn) downBtn.onclick = () => queueMoveDown(res.id);
      if (outBtn) outBtn.onclick = () => queueRemoveWaiting(res.id);
    });
  }

  function renderItemHtml(res, indexInView) {
    const statusClass = `qb-status-${res.status}`;
    const badge = QB.config.autoIndexFileName ? `<span class="qb-badge">#${indexInView}</span>` : "";
    const progressTail = res.progressText ? ` - ${escapeHtml(res.progressText)}` : "";
    const qstate = `<span class="qb-qstate">${escapeHtml(res.queueState || "none")}</span>`;
    const queueControls = (res.queueState === "queued" || res.queueState === "running")
      ? `
        <div class="qb-queue-actions">
          <button data-act="qtop">队首</button>
          <button data-act="qup">上移</button>
          <button data-act="qdown">下移</button>
          <button data-act="qremove">移出队列</button>
        </div>
      `
      : "";

    return `
      <div class="qb-item" id="${escapeHtml(res.id)}">
        <div class="qb-item-head">
          <input class="qb-check" type="checkbox" data-act="select">
          <div class="qb-main">
            <div class="qb-name">${escapeHtml(res.name || "media")}${badge}${qstate}</div>
            <div class="qb-meta">类型：${escapeHtml(res.kind)} / ${escapeHtml(res.type)}</div>
            <div class="qb-meta">来源：${escapeHtml(res.source)}</div>
            <div class="qb-meta">画质：${escapeHtml(res.quality || "-")}</div>
            <div class="qb-meta">大小：${res.size ? formatBytes(res.size) : "-"}</div>
            <div class="qb-meta">重试：${res.retryCount}/${res.maxRetry}</div>
            <div class="qb-meta ${statusClass}">状态：${escapeHtml(res.status)}${res.progress ? ` (${res.progress}%)` : ""}${progressTail}${res.error ? ` - ${escapeHtml(res.error)}` : ""}</div>
            <div class="qb-url">${escapeHtml(res.finalUrl || res.url)}</div>
            <div class="qb-actions">
              <button data-act="copy">复制</button>
              <button data-act="open">打开</button>
              <button data-act="probe">刷新</button>
              <button data-act="play">播放</button>
              <button data-act="enqueue">入队</button>
              <button data-act="download">直下</button>
              <button data-act="cancel">取消</button>
              <button data-act="remove">删除</button>
            </div>
            ${queueControls}
          </div>
        </div>
      </div>
    `;
  }

  function addCandidate({ url, name = "", source = "unknown", baseUrl = location.href }) {
    const final = normalizeUrl(url, baseUrl);
    if (!final || /^blob:/i.test(final)) return null;

    if (QB.state.urlSet.has(final)) return null;
    QB.state.urlSet.add(final);

    const mediaType = classifyMedia({ url: final }) || { kind: "video", type: "normal" };

    const res = createResource({
      url: final,
      finalUrl: final,
      name: sanitizeFileName(name || extractBestTitle(mediaType.kind)),
      source,
      kind: mediaType.kind,
      type: mediaType.type,
      status: "probing",
    });

    QB.state.resources.set(res.id, res);
    refreshAllLists();

    if (QB.config.autoProbeOnAdd) {
      probeResource(res.id);
    }

    if (QB.config.autoOpenOnNewItem && !QB.config.defaultCollapsed) {
      openPanel();
    }

    return res.id;
  }

  async function probeResource(resourceId) {
    const res = QB.state.resources.get(resourceId);
    if (!res) return;

    try {
      res.status = "probing";
      res.error = "";
      res.progressText = "";
      refreshAllLists();

      const response = await gmRequest({
        method: "GET",
        url: res.url,
        headers: {
          Range: "bytes=0-2048",
          "Cache-Control": "no-store",
        }
      });

      const headers = parseHeaders(response.responseHeaders || "");
      const contentType = headers["content-type"] || "";
      const contentLength = Number(headers["content-length"] || 0);
      const text = typeof response.responseText === "string" ? response.responseText.slice(0, 4096) : "";

      const media = classifyMedia({
        url: res.url,
        contentType,
        text
      });

      if (!media) {
        res.status = "error";
        res.error = "not_media";
        refreshAllLists();
        return;
      }

      res.kind = media.kind;
      res.type = media.type;
      res.contentType = contentType;
      res.size = contentLength;
      res.ext = guessExt(res.url, contentType);
      res.headers = headers;
      res.status = "ready";
      res.name = sanitizeFileName(res.name || extractBestTitle(res.kind));
      res.progressText = "";

      refreshAllLists();
    } catch (err) {
      res.status = "error";
      res.error = String(err?.message || err || "probe_failed");
      refreshAllLists();
    }
  }

  function resolveUrl(base, relative) {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  function parseAttrLine(line) {
    const map = {};
    const parts = String(line).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    for (const part of parts) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      let v = part.slice(i + 1).trim();
      v = v.replace(/^"(.*)"$/, "$1");
      map[k] = v;
    }
    return map;
  }

  function parseResolution(value = "") {
    const m = String(value).match(/(\d+)\s*x\s*(\d+)/i);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 };
  }

  function parseMasterPlaylist(text, baseUrl) {
    const lines = String(text).split(/\r?\n/);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

      const attrs = parseAttrLine(line.replace("#EXT-X-STREAM-INF:", ""));
      const next = (lines[i + 1] || "").trim();
      if (!next || next.startsWith("#")) continue;

      variants.push({
        url: resolveUrl(baseUrl, next),
        bandwidth: Number(attrs.BANDWIDTH || 0),
        averageBandwidth: Number(attrs["AVERAGE-BANDWIDTH"] || 0),
        resolution: attrs.RESOLUTION || "",
        frameRate: Number(attrs["FRAME-RATE"] || 0),
        codecs: attrs.CODECS || "",
      });
    }
    return variants;
  }

  function scoreVariant(v) {
    const bw = Number(v.averageBandwidth || v.bandwidth || 0);
    const { w, h } = parseResolution(v.resolution);
    const fr = Number(v.frameRate || 0);
    return bw * 1000000 + (w * h) * 100 + fr * 1000;
  }

  function pickBestVariant(variants) {
    if (!variants.length) return null;
    return [...variants].sort((a, b) => scoreVariant(b) - scoreVariant(a))[0];
  }

  async function loadText(url, headers = {}) {
    const res = await gmRequest({
      method: "GET",
      url,
      headers,
    });
    return String(res.responseText || "");
  }

  async function resolveBestHlsUrl(m3u8Url) {
    const text = await loadText(m3u8Url, { "Cache-Control": "no-store" });

    if (!/^#EXTM3U/m.test(text)) {
      return { finalUrl: m3u8Url, quality: "", mediaText: text };
    }

    const variants = parseMasterPlaylist(text, m3u8Url);
    if (!variants.length) {
      return { finalUrl: m3u8Url, quality: "", mediaText: text };
    }

    const best = pickBestVariant(variants);
    const mediaText = await loadText(best.url, { "Cache-Control": "no-store" });

    return {
      finalUrl: best.url,
      quality: best.resolution || `${Math.round((best.bandwidth || 0) / 1000)}kbps`,
      mediaText,
    };
  }

  function parseMediaPlaylist(text, baseUrl) {
    const lines = String(text).split(/\r?\n/);
    const segments = [];
    let encrypted = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-KEY")) encrypted = true;
      if (line.startsWith("#")) continue;
      segments.push(resolveUrl(baseUrl, line));
    }

    return { encrypted, segments };
  }

  async function fetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 30000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.response);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: reject,
        ontimeout: () => reject(new Error("timeout")),
        onabort: () => reject(new Error("aborted")),
      });
    });
  }

  function buildOutputFileName(res, viewIndex, ext) {
    const indexPrefix = QB.config.autoIndexFileName ? `${String(viewIndex).padStart(2, "0")}_` : "";
    const q = res.quality ? "_" + res.quality.replace(/[^\w-]+/g, "_") : "";
    return `${indexPrefix}${sanitizeFileName(res.name || "media")}${q}.${ext}`;
  }

  function getIndexInKind(res) {
    const items = getAllTabResourcesUnfiltered(res.kind);
    const idx = items.findIndex(x => x.id === res.id);
    return idx >= 0 ? idx + 1 : 1;
  }

  function isCancelled(resourceId) {
    return QB.state.cancelledResourceIds.has(resourceId);
  }

  function clearCancelled(resourceId) {
    QB.state.cancelledResourceIds.delete(resourceId);
  }

  function cancelResource(resourceId, markStatus = true) {
    QB.state.cancelledResourceIds.add(resourceId);

    const res = QB.state.resources.get(resourceId);
    if (res) {
      if (res.queueState === "queued") res.queueState = "none";
      if (markStatus) {
        res.status = "cancelled";
        res.progressText = "已取消";
        res.error = "";
      }
    }

    QB.state.queue = QB.state.queue.filter(item => {
      if (item.resourceId !== resourceId) return true;
      return item.state === "running";
    });

    refreshAllLists();
  }

  async function startDownload(resourceId) {
    const res = QB.state.resources.get(resourceId);
    if (!res) return;

    clearCancelled(resourceId);

    try {
      res.status = "downloading";
      res.progress = 0;
      res.error = "";
      res.progressText = "";
      refreshAllLists();

      if (res.type === "hls") {
        await downloadHls(res);
      } else {
        await downloadNormal(res);
      }

      if (isCancelled(resourceId)) {
        res.status = "cancelled";
        res.progressText = "已取消";
        refreshAllLists();
        throw new Error("cancelled");
      }

      res.status = "done";
      res.progress = 100;
      if (!res.progressText) res.progressText = "完成";
      refreshAllLists();
    } catch (err) {
      if (String(err?.message || err) === "cancelled") {
        res.status = "cancelled";
        res.error = "";
      } else if (res.status !== "unsupported") {
        res.status = "error";
        res.error = String(err?.message || err || "download_failed");
      }
      refreshAllLists();
      throw err;
    }
  }

  async function downloadNormal(res) {
    const ext = res.ext || (res.kind === "audio" ? "mp3" : "mp4");
    const viewIndex = getIndexInKind(res);
    const name = buildOutputFileName(res, viewIndex, ext);

    await new Promise((resolve, reject) => {
      GM_download({
        url: res.finalUrl || res.url,
        name,
        headers: { "Cache-Control": "no-store" },
        onprogress: (e) => {
          if (isCancelled(res.id)) {
            reject(new Error("cancelled"));
            return;
          }
          if (e && e.total > 0) {
            res.progress = +(e.loaded / e.total * 100).toFixed(2);
            res.progressText = `${formatBytes(e.loaded)} / ${formatBytes(e.total)}`;
            refreshAllLists();
          }
        },
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  async function fetchHlsSegmentWithRetry(url, resourceId) {
    let attempt = 0;
    while (true) {
      if (isCancelled(resourceId)) throw new Error("cancelled");
      try {
        return await fetchArrayBuffer(url);
      } catch (err) {
        if (attempt >= QB.config.hlsSegmentRetryCount) throw err;
        attempt++;
        await sleep(500);
      }
    }
  }

  async function downloadHls(res) {
    if (isCancelled(res.id)) throw new Error("cancelled");

    const best = await resolveBestHlsUrl(res.finalUrl || res.url);
    if (isCancelled(res.id)) throw new Error("cancelled");

    res.finalUrl = best.finalUrl;
    res.quality = best.quality || res.quality || "";
    res.progressText = "解析播放列表";
    refreshAllLists();

    const media = parseMediaPlaylist(best.mediaText, best.finalUrl);

    if (media.encrypted) {
      res.status = "unsupported";
      res.error = "encrypted_hls_not_supported";
      refreshAllLists();
      throw new Error("encrypted_hls_not_supported");
    }

    if (!media.segments.length) {
      throw new Error("no_hls_segments");
    }

    const total = media.segments.length;
    const buffers = new Array(total);
    let finished = 0;
    let index = 0;

    const worker = async () => {
      while (true) {
        if (isCancelled(res.id)) throw new Error("cancelled");

        const current = index++;
        if (current >= total) break;

        const segUrl = media.segments[current];
        const buf = await fetchHlsSegmentWithRetry(segUrl, res.id);

        if (isCancelled(res.id)) throw new Error("cancelled");

        buffers[current] = buf;
        finished++;
        res.progress = +((finished / total) * 100).toFixed(2);
        res.progressText = `分片 ${finished}/${total}`;
        refreshAllLists();
      }
    };

    const concurrency = Math.min(QB.config.maxTsConcurrency, total);
    const jobs = [];
    for (let i = 0; i < concurrency; i++) jobs.push(worker());
    await Promise.all(jobs);

    if (isCancelled(res.id)) throw new Error("cancelled");

    const blob = new Blob(buffers, { type: "video/mp2t" });
    const a = document.createElement("a");
    const viewIndex = getIndexInKind(res);
    a.href = URL.createObjectURL(blob);
    a.download = buildOutputFileName(res, viewIndex, "ts");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function enqueueResources(resources) {
    const existingQueuedOrRunning = new Set(
      QB.state.queue
        .filter(x => x.state === "queued" || x.state === "running")
        .map(x => x.resourceId)
    );

    for (const res of resources) {
      if (!res || !QB.state.resources.has(res.id)) continue;
      if (existingQueuedOrRunning.has(res.id)) continue;

      QB.state.queue.push({
        id: `q_${Date.now()}_${++QB.state.queueSeq}`,
        resourceId: res.id,
        state: "queued",
      });
      res.queueState = "queued";
      existingQueuedOrRunning.add(res.id);
    }

    refreshAllLists();
    processQueue();
  }

  function removeFromQueueByResourceId(resourceId) {
    QB.state.queue = QB.state.queue.filter(item => {
      if (item.resourceId !== resourceId) return true;
      return item.state === "running";
    });
    const res = QB.state.resources.get(resourceId);
    if (res && res.queueState !== "running") {
      res.queueState = "none";
    }
    refreshQueueSummary();
  }

  function clearWaitingQueue() {
    const waitingIds = [];
    QB.state.queue = QB.state.queue.filter(item => {
      if (item.state === "queued") {
        waitingIds.push(item.resourceId);
        return false;
      }
      return true;
    });
    waitingIds.forEach(id => {
      const res = QB.state.resources.get(id);
      if (res && res.queueState === "queued") res.queueState = "none";
    });
    refreshAllLists();
  }

  function queueMoveTop(resourceId) {
    const idx = QB.state.queue.findIndex(x => x.resourceId === resourceId && x.state === "queued");
    if (idx <= 0) return;
    const [item] = QB.state.queue.splice(idx, 1);
    const firstQueued = QB.state.queue.findIndex(x => x.state === "queued");
    QB.state.queue.splice(firstQueued >= 0 ? firstQueued : 0, 0, item);
    refreshQueueSummary();
    refreshAllLists();
  }

  function queueMoveUp(resourceId) {
    const idx = QB.state.queue.findIndex(x => x.resourceId === resourceId && x.state === "queued");
    if (idx <= 0) return;
    for (let i = idx - 1; i >= 0; i--) {
      if (QB.state.queue[i].state === "queued") {
        [QB.state.queue[i], QB.state.queue[idx]] = [QB.state.queue[idx], QB.state.queue[i]];
        break;
      }
    }
    refreshQueueSummary();
    refreshAllLists();
  }

  function queueMoveDown(resourceId) {
    const idx = QB.state.queue.findIndex(x => x.resourceId === resourceId && x.state === "queued");
    if (idx < 0) return;
    for (let i = idx + 1; i < QB.state.queue.length; i++) {
      if (QB.state.queue[i].state === "queued") {
        [QB.state.queue[i], QB.state.queue[idx]] = [QB.state.queue[idx], QB.state.queue[i]];
        break;
      }
    }
    refreshQueueSummary();
    refreshAllLists();
  }

  function queueRemoveWaiting(resourceId) {
    const idx = QB.state.queue.findIndex(x => x.resourceId === resourceId && x.state === "queued");
    if (idx < 0) return;
    QB.state.queue.splice(idx, 1);
    const res = QB.state.resources.get(resourceId);
    if (res && res.queueState === "queued") res.queueState = "none";
    refreshQueueSummary();
    refreshAllLists();
  }

  async function runQueuedDownloadWithRetry(res) {
    let attempt = 0;
    while (true) {
      if (isCancelled(res.id)) throw new Error("cancelled");

      try {
        await startDownload(res.id);
        return;
      } catch (err) {
        const msg = String(err?.message || err || "");
        if (msg === "cancelled") throw err;
        if (res.status === "unsupported") throw err;

        if (attempt >= res.maxRetry) {
          throw err;
        }

        attempt++;
        res.retryCount = attempt;
        res.progressText = `重试中 ${attempt}/${res.maxRetry}`;
        refreshAllLists();
        await sleep(QB.config.autoRetryDelayMs);
      }
    }
  }

  async function processQueue() {
    if (QB.state.queuePaused) {
      refreshQueueSummary();
      return;
    }

    while (!QB.state.queuePaused && QB.state.queueRunningCount < QB.config.queueConcurrency) {
      const next = QB.state.queue.find(x => x.state === "queued");
      if (!next) break;

      const res = QB.state.resources.get(next.resourceId);
      if (!res) {
        next.state = "failed";
        continue;
      }

      next.state = "running";
      res.queueState = "running";
      res.retryCount = 0;
      QB.state.queueRunningCount++;
      refreshAllLists();

      (async () => {
        try {
          await runQueuedDownloadWithRetry(res);
          next.state = "done";
          res.queueState = "done";
        } catch (err) {
          next.state = "failed";
          if (String(err?.message || err) === "cancelled") {
            res.status = "cancelled";
          }
          res.queueState = "none";
        } finally {
          QB.state.queueRunningCount--;
          refreshAllLists();
          processQueue();
        }
      })();
    }

    refreshQueueSummary();
  }

  function downloadBlobFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function exportCurrentTabAsTxt() {
    const items = getAllTabResourcesUnfiltered(QB.state.activeTab).filter(matchesSearch);
    const lines = items.map((item, idx) => {
      return [
        `# ${idx + 1}`,
        `name: ${item.name || ""}`,
        `kind: ${item.kind}`,
        `type: ${item.type}`,
        `quality: ${item.quality || ""}`,
        `status: ${item.status}`,
        `source: ${item.source}`,
        `url: ${item.finalUrl || item.url}`,
        ""
      ].join("\n");
    });
    const filename = `${QB.state.activeTab}_resources.txt`;
    downloadBlobFile(lines.join("\n"), filename, "text/plain;charset=utf-8");
  }

  function exportCurrentTabAsJson() {
    const items = getAllTabResourcesUnfiltered(QB.state.activeTab)
      .filter(matchesSearch)
      .map((item, idx) => ({
        index: idx + 1,
        name: item.name || "",
        kind: item.kind,
        type: item.type,
        quality: item.quality || "",
        status: item.status,
        source: item.source,
        size: item.size || 0,
        queueState: item.queueState,
        retryCount: item.retryCount,
        url: item.finalUrl || item.url,
        pageUrl: item.pageUrl || "",
        pageTitle: item.pageTitle || "",
      }));
    const filename = `${QB.state.activeTab}_resources.json`;
    downloadBlobFile(JSON.stringify(items, null, 2), filename, "application/json;charset=utf-8");
  }

  function discoverFromDom() {
    if (!QB.config.detectFromDom) return;

    document.querySelectorAll("video, audio").forEach(el => {
      const url = el.currentSrc || el.src || el.getAttribute("src");
      if (url && !/^blob:/i.test(url)) {
        addCandidate({
          url,
          source: "dom_media",
          name: extractBestTitle(el.tagName.toLowerCase() === "audio" ? "audio" : "video"),
        });
      }

      el.querySelectorAll("source").forEach(source => {
        const src = source.src || source.getAttribute("src");
        if (src && !/^blob:/i.test(src)) {
          addCandidate({
            url: src,
            source: "dom_source",
            name: extractBestTitle(el.tagName.toLowerCase() === "audio" ? "audio" : "video"),
            baseUrl: location.href,
          });
        }
      });
    });
  }

  function discoverCurrentlyPlaying() {
    if (!QB.config.detectCurrentlyPlaying) return;

    document.querySelectorAll("video, audio").forEach(el => {
      const isPlaying = !el.paused && !el.ended && el.readyState >= 2;
      const url = el.currentSrc || el.src || el.getAttribute("src");
      if (isPlaying && url && !/^blob:/i.test(url)) {
        addCandidate({
          url,
          source: "currently_playing",
          name: extractBestTitle(el.tagName.toLowerCase() === "audio" ? "audio" : "video"),
          baseUrl: location.href,
        });
      }
    });
  }

  function bindMediaEvents() {
    const handler = (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLMediaElement)) return;
      const url = el.currentSrc || el.src || el.getAttribute("src");
      if (url && !/^blob:/i.test(url)) {
        addCandidate({
          url,
          source: `media_event:${ev.type}`,
          name: extractBestTitle(el.tagName.toLowerCase() === "audio" ? "audio" : "video"),
        });
      }
    };

    document.addEventListener("play", handler, true);
    document.addEventListener("playing", handler, true);
    document.addEventListener("loadedmetadata", handler, true);
  }

  function installPerformanceObserver() {
    if (!QB.config.detectFromPerformance || !("PerformanceObserver" in window)) return;

    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries() || [];
      for (const entry of entries) {
        const url = entry.name;
        if (!url) continue;

        if (
          entry.initiatorType === "video" ||
          entry.initiatorType === "audio" ||
          entry.initiatorType === "fetch" ||
          entry.initiatorType === "xmlhttprequest"
        ) {
          addCandidate({
            url,
            source: `performance:${entry.initiatorType}`,
            name: extractBestTitle("video"),
          });
        }
      }
    });

    observer.observe({ entryTypes: ["resource"] });
  }

  function installNetworkHook() {
    if (!QB.config.detectFromNetworkHook) return;

    const script = document.createElement("script");
    script.textContent = `
      (() => {
        const post = (url) => {
          try {
            window.postMessage({ __qb_media_probe__: true, url: String(url) }, "*");
          } catch (e) {}
        };

        const rawFetch = window.fetch;
        if (typeof rawFetch === "function") {
          window.fetch = function (...args) {
            const input = args[0];
            const url = typeof input === "string" ? input : input && input.url;
            if (url) post(url);
            return rawFetch.apply(this, args);
          };
        }

        const XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype) {
          const open = XHR.prototype.open;
          XHR.prototype.open = function(method, url, ...rest) {
            if (url) post(url);
            return open.call(this, method, url, ...rest);
          };
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || !data.__qb_media_probe__ || !data.url) return;

      addCandidate({
        url: data.url,
        source: "network_hook",
        name: extractBestTitle("video"),
      });
    }, true);
  }

  function scanAll() {
    discoverFromDom();
    discoverCurrentlyPlaying();
  }

  function init() {
    ensurePanel();
    installPerformanceObserver();
    installNetworkHook();
    bindMediaEvents();
    scanAll();

    setInterval(() => {
      discoverCurrentlyPlaying();
    }, QB.config.scanInterval);

    const mo = new MutationObserver(() => {
      discoverFromDom();
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    setActiveTab("video");
    refreshQueueSummary();
    log("initialized");
  }

  init();
})();