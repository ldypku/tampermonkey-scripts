// ==UserScript==
// @name         AutoScroll Ultimate
// @namespace    https://greasyfork.org/
// @version      2026.04.21.1
// @updateURL    https://raw.githubusercontent.com/ldypku/tampermonkey-scripts/main/dist/auto-scroll.user.js
// @description  双击切换自动滚屏，支持控制面板/调速/方向/容器识别/站点配置记忆/切标签暂停恢复
// @author       OpenAI
// @match        http*://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /**************************************************************************
   * 配置
   **************************************************************************/
  const APP_ID = 'tm-autoscroll-ultimate';
  const STORAGE_KEY = `${APP_ID}:site-config:v1`;
  const PANEL_WIDTH = 320;
  const MIN_SPEED = 0.1;
  const MAX_SPEED = 20;

  const DEFAULT_CONFIG = {
    speed: 1.2,
    direction: 'down',       // down | up | right | left
    boostMultiplier: 2.5,
    showIndicator: true,
    useSmartContainer: true,
    showFloatingButton: false,
    panelCollapsed: false,
    fineTuneStep: 0.2,
    wheelTuneStep: 0.2,
    opacity: 0.92
  };

  const state = {
    running: false,
    boost: false,
    rafId: 0,
    lastTs: 0,
    scrollEl: null,
    uiReady: false,
    hideToastTimer: 0,
    siteKey: getSiteKey(),
    config: null,
    pausedByVisibility: false
  };

  /**************************************************************************
   * 工具函数
   **************************************************************************/
  function getSiteKey() {
    return location.hostname.replace(/^www\./, '');
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function round(n, digits = 1) {
    const p = Math.pow(10, digits);
    return Math.round(n * p) / p;
  }

  function loadAllConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      console.warn('[AutoScroll] load config failed:', err);
      return {};
    }
  }

  function saveAllConfig(allConfig) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(allConfig));
    } catch (err) {
      console.warn('[AutoScroll] save config failed:', err);
    }
  }

  function loadSiteConfig() {
    const all = loadAllConfig();
    const cfg = {
      ...DEFAULT_CONFIG,
      ...(all[state.siteKey] || {})
    };

    // 兼容旧字段
    if (typeof cfg.showFloatingButton !== 'boolean') {
      cfg.showFloatingButton = false;
    }

    return cfg;
  }

  function persistSiteConfig() {
    const all = loadAllConfig();
    all[state.siteKey] = { ...state.config };
    saveAllConfig(all);
  }

  function formatDirection(direction) {
    switch (direction) {
      case 'up': return '向上';
      case 'down': return '向下';
      case 'left': return '向左';
      case 'right': return '向右';
      default: return direction;
    }
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      target.isContentEditable
    );
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getScrollableScore(el) {
    if (!el || el === document.body || el === document.documentElement) return -1;
    if (!isVisible(el)) return -1;

    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const canScrollY = /(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 20;
    const canScrollX = /(auto|scroll|overlay)/.test(overflowX) && el.scrollWidth > el.clientWidth + 20;

    if (!canScrollY && !canScrollX) return -1;

    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    const scrollRange = Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth);
    const inViewportBonus = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth ? 5000 : 0;

    return area + scrollRange + inViewportBonus;
  }

  function detectMainScrollableElement() {
    const candidates = [];
    const all = document.querySelectorAll('body *');

    for (const el of all) {
      const score = getScrollableScore(el);
      if (score > 0) {
        candidates.push({ el, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const docEl = document.scrollingElement || document.documentElement;
    const docScore = Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      document.documentElement.scrollWidth - window.innerWidth
    );

    if (candidates.length) {
      const best = candidates[0];
      if (best.score > docScore * 0.6) {
        return best.el;
      }
    }

    return docEl;
  }

  function getScrollElement(forceRefresh = false) {
    if (!state.config.useSmartContainer) {
      state.scrollEl = document.scrollingElement || document.documentElement;
      return state.scrollEl;
    }

    if (!state.scrollEl || forceRefresh) {
      state.scrollEl = detectMainScrollableElement();
    }

    return state.scrollEl;
  }

  function canScrollFurther(el, direction) {
    if (!el) return false;

    if (el === document.documentElement || el === document.body || el === document.scrollingElement) {
      const doc = document.scrollingElement || document.documentElement;
      switch (direction) {
        case 'down':
          return doc.scrollTop + window.innerHeight < doc.scrollHeight - 1;
        case 'up':
          return doc.scrollTop > 0;
        case 'right':
          return doc.scrollLeft + window.innerWidth < doc.scrollWidth - 1;
        case 'left':
          return doc.scrollLeft > 0;
        default:
          return false;
      }
    }

    switch (direction) {
      case 'down':
        return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      case 'up':
        return el.scrollTop > 0;
      case 'right':
        return el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      case 'left':
        return el.scrollLeft > 0;
      default:
        return false;
    }
  }

  function scrollByDirection(el, delta, direction) {
    if (!el) return;

    let dx = 0;
    let dy = 0;

    switch (direction) {
      case 'down': dy = delta; break;
      case 'up': dy = -delta; break;
      case 'right': dx = delta; break;
      case 'left': dx = -delta; break;
    }

    if (el === document.documentElement || el === document.body || el === document.scrollingElement) {
      window.scrollBy(dx, dy);
    } else {
      el.scrollLeft += dx;
      el.scrollTop += dy;
    }
  }

  function getCurrentSpeed() {
    const base = Number(state.config.speed) || DEFAULT_CONFIG.speed;
    return clamp(base * (state.boost ? state.config.boostMultiplier : 1), MIN_SPEED, MAX_SPEED * 3);
  }

  function getContainerLabel(el) {
    if (!el) return '未识别';

    if (el === document.documentElement || el === document.body || el === document.scrollingElement) {
      return '页面';
    }

    const tag = (el.tagName || 'div').toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';

    return `${tag}${id}${cls}`.slice(0, 60);
  }

  /**************************************************************************
   * UI
   **************************************************************************/
  let root, button, panel, toast;
  const els = {};

  function btnStyle(type = 'normal') {
    let bg = 'rgba(255,255,255,.08)';
    let border = '1px solid rgba(255,255,255,.12)';
    let color = '#fff';
    let padding = '8px 10px';
    let font = '600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif';

    if (type === 'primary') {
      bg = 'linear-gradient(180deg, rgba(74,144,226,.95), rgba(52,120,204,.95))';
      border = '1px solid rgba(255,255,255,.08)';
    } else if (type === 'small') {
      padding = '6px 8px';
      font = '600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif';
    }

    return `
      all: initial;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      border-radius: 8px;
      padding: ${padding};
      background: ${bg};
      border: ${border};
      color: ${color};
      cursor: pointer;
      user-select: none;
      font: ${font};
    `;
  }

  function sectionStyle() {
    return 'margin-bottom:12px;padding:10px;border-radius:10px;background:rgba(255,255,255,.04);';
  }

  function labelStyle() {
    return 'font-size:12px;font-weight:700;margin-bottom:6px;opacity:.95;';
  }

  function valueStyle() {
    return 'font-size:12px;opacity:.88;word-break:break-all;';
  }

  function checkRowStyle() {
    return 'display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer;';
  }

  function createRoot() {
    root = document.createElement('div');
    root.id = APP_ID;
    root.style.all = 'initial';
    root.style.position = 'fixed';
    root.style.top = '16px';
    root.style.right = '16px';
    root.style.zIndex = '2147483647';
    root.style.fontFamily = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif`;
    document.documentElement.appendChild(root);
  }

  function createButton() {
    button = document.createElement('div');
    button.style.cssText = `
      all: initial;
      box-sizing: border-box;
      position: fixed;
      top: 16px;
      right: 16px;
      width: 44px;
      height: 44px;
      border-radius: 22px;
      background: rgba(20,20,20,0.88);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 18px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 6px 18px rgba(0,0,0,.25);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.12);
    `;
    button.title = 'AutoScroll 控制入口';
    button.textContent = '⇵';

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleRunning();
    });

    root.appendChild(button);
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.style.cssText = `
      all: initial;
      box-sizing: border-box;
      position: fixed;
      top: 68px;
      right: 16px;
      width: ${PANEL_WIDTH}px;
      background: rgba(22,22,22,${state.config.opacity});
      color: #fff;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 12px 36px rgba(0,0,0,.28);
      backdrop-filter: blur(10px);
      padding: 12px;
      display: none;
      font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    `;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div style="font-size:15px;font-weight:700;">AutoScroll Ultimate</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button data-act="collapse" style="${btnStyle('small')}">收起</button>
          <button data-act="close" style="${btnStyle('small')}">×</button>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <button data-act="toggle" style="${btnStyle('primary')}">启动</button>
        <button data-act="detect" style="${btnStyle()}">重识别容器</button>
        <button data-act="reset" style="${btnStyle()}">恢复默认</button>
      </div>

      <div style="${sectionStyle()}">
        <div style="${labelStyle()}">状态</div>
        <div id="${APP_ID}-status" style="${valueStyle()}">-</div>
      </div>

      <div style="${sectionStyle()}">
        <div style="${labelStyle()}">滚动容器</div>
        <div id="${APP_ID}-container" style="${valueStyle()}">-</div>
      </div>

      <div style="${sectionStyle()}">
        <div style="${labelStyle()}">方向</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
          <button data-dir="up" style="${btnStyle()}">上</button>
          <button data-dir="down" style="${btnStyle()}">下</button>
          <button data-dir="left" style="${btnStyle()}">左</button>
          <button data-dir="right" style="${btnStyle()}">右</button>
        </div>
      </div>

      <div style="${sectionStyle()}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="${labelStyle()}">速度</div>
          <div id="${APP_ID}-speed-value" style="${valueStyle()}">1.2</div>
        </div>
        <input id="${APP_ID}-speed" type="range" min="${MIN_SPEED}" max="${MAX_SPEED}" step="0.1" value="${state.config.speed}" style="width:100%;" />
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button data-act="speed-dec" style="${btnStyle()}">-</button>
          <button data-act="speed-inc" style="${btnStyle()}">+</button>
          <button data-act="boost" style="${btnStyle()}">加速</button>
        </div>
      </div>

      <div style="${sectionStyle()}">
        <div style="${labelStyle()}">选项</div>
        <label style="${checkRowStyle()}">
          <input id="${APP_ID}-show-button" type="checkbox" />
          <span>显示右上角按钮</span>
        </label>
        <label style="${checkRowStyle()}">
          <input id="${APP_ID}-smart" type="checkbox" />
          <span>自动识别滚动容器</span>
        </label>
        <label style="${checkRowStyle()}">
          <input id="${APP_ID}-indicator" type="checkbox" />
          <span>显示状态提示</span>
        </label>
      </div>

      <div style="${sectionStyle()}">
        <div style="${labelStyle()}">快捷键</div>
        <div style="opacity:.9;">
          双击：开关滚动<br>
          右键悬浮按钮：开关滚动<br>
          Alt + A：开关滚动<br>
          Alt + P：打开/关闭面板<br>
          ↑ / ↓：调速<br>
          ← / →：切方向<br>
          Shift：按住加速<br>
          Space：暂停
        </div>
      </div>
    `;

    root.appendChild(panel);

    els.status = panel.querySelector(`#${APP_ID}-status`);
    els.container = panel.querySelector(`#${APP_ID}-container`);
    els.speed = panel.querySelector(`#${APP_ID}-speed`);
    els.speedValue = panel.querySelector(`#${APP_ID}-speed-value`);
    els.showButton = panel.querySelector(`#${APP_ID}-show-button`);
    els.smart = panel.querySelector(`#${APP_ID}-smart`);
    els.indicator = panel.querySelector(`#${APP_ID}-indicator`);

    panel.addEventListener('click', onPanelClick);
    els.speed.addEventListener('input', onSpeedInput);
    els.showButton.addEventListener('change', onCheckboxChange);
    els.smart.addEventListener('change', onCheckboxChange);
    els.indicator.addEventListener('change', onCheckboxChange);
  }

  function createToast() {
    toast = document.createElement('div');
    toast.style.cssText = `
      all: initial;
      box-sizing: border-box;
      position: fixed;
      right: 16px;
      bottom: 16px;
      max-width: 360px;
      min-width: 120px;
      background: rgba(20,20,20,0.86);
      color: #fff;
      border-radius: 10px;
      padding: 10px 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.25);
      font: 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
      border: 1px solid rgba(255,255,255,.1);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .18s ease, transform .18s ease;
      pointer-events: none;
    `;
    root.appendChild(toast);
  }

  function showToast(text, timeout = 1400) {
    if (!state.config.showIndicator || !toast) return;
    toast.textContent = text;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(state.hideToastTimer);
    state.hideToastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
    }, timeout);
  }

  function togglePanel(force) {
    const shouldShow = typeof force === 'boolean' ? force : panel.style.display === 'none';
    panel.style.display = shouldShow ? 'block' : 'none';
  }

  function setPanelCollapsed(collapsed) {
    state.config.panelCollapsed = !!collapsed;
    persistSiteConfig();

    if (collapsed) {
      panel.style.width = '160px';
      Array.from(panel.children).forEach((child, idx) => {
        child.style.display = idx === 0 ? '' : 'none';
      });
    } else {
      panel.style.width = `${PANEL_WIDTH}px`;
      Array.from(panel.children).forEach((child) => {
        child.style.display = '';
      });
    }
  }

  function render() {
    if (!state.uiReady) return;

    const effectiveSpeed = round(getCurrentSpeed(), 1);
    const container = getScrollElement(false);

    button.textContent = state.running ? '▶' : '⇵';
    button.style.background = state.running
      ? 'rgba(32,136,74,0.92)'
      : 'rgba(20,20,20,0.88)';
    button.style.display = state.config.showFloatingButton ? 'flex' : 'none';

    els.status.textContent = `${state.running ? '运行中' : '已停止'} ｜ ${formatDirection(state.config.direction)} ｜ ${effectiveSpeed}`;
    els.container.textContent = getContainerLabel(container);
    els.speed.value = String(state.config.speed);
    els.speedValue.textContent = `${round(state.config.speed, 1)}${state.boost ? `（加速 x${state.config.boostMultiplier}）` : ''}`;
    els.showButton.checked = !!state.config.showFloatingButton;
    els.smart.checked = !!state.config.useSmartContainer;
    els.indicator.checked = !!state.config.showIndicator;

    panel.querySelectorAll('[data-dir]').forEach((btn) => {
      btn.style.background = btn.getAttribute('data-dir') === state.config.direction
        ? 'rgba(74,144,226,.85)'
        : 'rgba(255,255,255,.08)';
    });

    const toggleBtn = panel.querySelector('[data-act="toggle"]');
    if (toggleBtn) {
      toggleBtn.textContent = state.running ? '停止' : '启动';
    }
  }

  function onPanelClick(e) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const act = target.getAttribute('data-act');
    const dir = target.getAttribute('data-dir');

    if (dir) {
      state.config.direction = dir;
      persistSiteConfig();
      render();
      showToast(`方向：${formatDirection(dir)}`);
      return;
    }

    switch (act) {
      case 'toggle':
        toggleRunning();
        break;
      case 'detect':
        getScrollElement(true);
        render();
        showToast(`已重识别：${getContainerLabel(state.scrollEl)}`);
        break;
      case 'reset':
        stopRunning(false);
        state.config = { ...DEFAULT_CONFIG };
        state.pausedByVisibility = false;
        persistSiteConfig();
        state.scrollEl = null;
        getScrollElement(true);
        setPanelCollapsed(false);
        render();
        showToast('已恢复默认配置');
        break;
      case 'speed-dec':
        adjustSpeed(-state.config.fineTuneStep);
        break;
      case 'speed-inc':
        adjustSpeed(state.config.fineTuneStep);
        break;
      case 'boost':
        state.boost = !state.boost;
        render();
        showToast(state.boost ? '加速已开启' : '加速已关闭');
        break;
      case 'collapse':
        setPanelCollapsed(!state.config.panelCollapsed);
        break;
      case 'close':
        togglePanel(false);
        break;
    }
  }

  function onSpeedInput() {
    state.config.speed = clamp(Number(els.speed.value), MIN_SPEED, MAX_SPEED);
    persistSiteConfig();
    render();
  }

  function onCheckboxChange() {
    state.config.showFloatingButton = !!els.showButton.checked;
    state.config.useSmartContainer = !!els.smart.checked;
    state.config.showIndicator = !!els.indicator.checked;

    if (button) {
      button.style.display = state.config.showFloatingButton ? 'flex' : 'none';
    }

    state.scrollEl = null;
    persistSiteConfig();
    getScrollElement(true);
    render();
  }

  /**************************************************************************
   * 滚动逻辑
   **************************************************************************/
  function tick(ts) {
    if (!state.running) return;

    if (!state.lastTs) state.lastTs = ts;
    const elapsed = ts - state.lastTs;
    state.lastTs = ts;

    const el = getScrollElement(false);
    if (!el) {
      state.rafId = requestAnimationFrame(tick);
      return;
    }

    const speed = getCurrentSpeed();
    const delta = speed * (elapsed / (1000 / 60));

    if (!canScrollFurther(el, state.config.direction)) {
      stopRunning(false);
      showToast('已滚动到边界，自动停止');
      render();
      return;
    }

    scrollByDirection(el, delta, state.config.direction);
    state.rafId = requestAnimationFrame(tick);
  }

  function startRunning() {
    if (state.running) return;
    state.running = true;
    state.lastTs = 0;
    getScrollElement(true);
    state.rafId = requestAnimationFrame(tick);
    render();
    showToast(`已启动：${formatDirection(state.config.direction)} ｜ 速度 ${round(state.config.speed, 1)}`);
  }

  function stopRunning(show = true) {
    if (!state.running) return;
    state.running = false;
    state.lastTs = 0;
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    render();
    if (show) {
      showToast('已停止');
    }
  }

  function toggleRunning() {
    state.pausedByVisibility = false;
    if (state.running) {
      stopRunning(true);
    } else {
      startRunning();
    }
  }

  function adjustSpeed(diff) {
    state.config.speed = clamp(round(state.config.speed + diff, 1), MIN_SPEED, MAX_SPEED);
    persistSiteConfig();
    render();
    showToast(`速度：${round(state.config.speed, 1)}`);
  }

  /**************************************************************************
   * 事件
   **************************************************************************/
  function onDblClick(e) {
    if (root && root.contains(e.target)) return;
    if (isEditableTarget(e.target)) return;
    toggleRunning();
  }

  function onWheel(e) {
    if (!state.running) return;
    if (root && root.contains(e.target)) return;

    const step = state.config.wheelTuneStep || 0.2;
    if (e.altKey) {
      adjustSpeed(e.deltaY > 0 ? step : -step);
    }
  }

  function onKeyDown(e) {
    if (isEditableTarget(e.target)) return;

    if (e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      toggleRunning();
      return;
    }

    if (e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      togglePanel();
      return;
    }

    if (e.key === 'Shift') {
      state.boost = true;
      render();
      return;
    }

    if (e.key === ' ') {
      if (state.running) {
        e.preventDefault();
        state.pausedByVisibility = false;
        stopRunning(true);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      if (state.running || panel.style.display !== 'none') {
        e.preventDefault();
        adjustSpeed(state.config.fineTuneStep);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      if (state.running || panel.style.display !== 'none') {
        e.preventDefault();
        adjustSpeed(-state.config.fineTuneStep);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (state.running || panel.style.display !== 'none') {
        e.preventDefault();
        state.config.direction = 'left';
        persistSiteConfig();
        render();
        showToast('方向：向左');
      }
      return;
    }

    if (e.key === 'ArrowRight') {
      if (state.running || panel.style.display !== 'none') {
        e.preventDefault();
        state.config.direction = 'right';
        persistSiteConfig();
        render();
        showToast('方向：向右');
      }
    }
  }

  function onKeyUp(e) {
    if (e.key === 'Shift') {
      state.boost = false;
      render();
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (state.running) {
        state.pausedByVisibility = true;
        stopRunning(false);
        showToast('标签页切换：已暂停');
      }
      return;
    }

    if (state.pausedByVisibility) {
      state.pausedByVisibility = false;
      startRunning();
      showToast('标签页恢复：继续滚动');
    }
  }

  function onResize() {
    state.scrollEl = null;
    getScrollElement(true);
    render();
  }

  function onPageClick(e) {
    if (!panel || panel.style.display === 'none') return;
    if (root && !root.contains(e.target)) {
      togglePanel(false);
    }
  }

  /**************************************************************************
   * 初始化
   **************************************************************************/
  function initUI() {
    if (state.uiReady) return;
    createRoot();
    createButton();
    createPanel();
    createToast();
    state.uiReady = true;

    if (state.config.panelCollapsed) {
      setPanelCollapsed(true);
    }

    if (button) {
      button.style.display = state.config.showFloatingButton ? 'flex' : 'none';
    }

    render();
  }

  function bindEvents() {
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('wheel', onWheel, { passive: true, capture: true });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('visibilitychange', onVisibilityChange, true);
    document.addEventListener('click', onPageClick, true);
    window.addEventListener('resize', onResize, true);
  }

  function init() {
    state.config = loadSiteConfig();
    initUI();
    bindEvents();
    getScrollElement(true);
    render();
    showToast('AutoScroll Ultimate 已加载');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();