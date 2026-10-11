/**
 * 浏览器自动化通用库
 * - 在 Electron BrowserWindow 的 webContents 上做安全的 DOM 自动化
 * - React/Vue 受控组件填充（原生 setter + 事件触发）
 * - CDP DOM.setFileInputFiles 文件上传（绕过 input.files 只读限制）
 * - 反自动化特征注入
 */
const { Debugger } = require('electron');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min, max) => Math.random() * (max - min) + min;

/** 随机延时（人类节奏） */
async function humanPause(minMs = 600, maxMs = 1800) {
  await sleep(rand(minMs, maxMs));
}

/** 注入反检测脚本（每次页面加载后执行一次） */
const STEALTH_JS = `
(() => {
  try {
    // webdriver 标记
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // plugins 伪装
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin' },
        { name: 'Chrome PDF Viewer' },
        { name: 'Native Client' },
      ]
    });
    // languages
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
    // chrome 对象
    window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false } };
    // permissions
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (p) => p.name === 'notifications'
        ? Promise.resolve({ state: 'prompt', onchange: null })
        : origQuery.call(navigator.permissions, p);
    }
    // WebGL vendor 伪装
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (NVIDIA)';
      if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060, OpenGL 4.5)';
      return getParameter.call(this, p);
    };
  } catch(e) {}
})();
`;

/**
 * 在指定 webContents 中执行 JS 并返回结果
 */
async function evalInPage(webContents, code) {
  try {
    const r = await webContents.executeJavaScript(`(async () => { ${wrap(code)} })()`, true);
    return r;
  } catch (e) {
    throw new Error('页面脚本执行失败: ' + (e && e.message ? e.message : String(e)).slice(0, 300));
  }
}
function wrap(code) {
  // code 内可使用 return 直接返回值
  return code;
}

/**
 * 等待选择器出现
 * @param webContents
 * @param selector css选择器
 * @param timeoutMs 超时
 * @param visible 是否要求可见
 */
async function waitForSelector(webContents, selector, timeoutMs = 15000, visible = false) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evalInPage(webContents, `
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      ${visible ? `
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      ` : ''}
      return true;
    `);
    if (found) return true;
    await sleep(400);
  }
  throw new Error(`等待元素超时(${timeoutMs}ms): ${selector}`);
}

/**
 * 等待任意一个选择器命中，返回命中下标（-1超时）
 */
async function waitForAnySelector(webContents, selectors, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const idx = await evalInPage(webContents, `
      const sels = ${JSON.stringify(selectors)};
      for (let i = 0; i < sels.length; i++) {
        if (document.querySelector(sels[i])) return i;
      }
      return -1;
    `);
    if (idx >= 0) return idx;
    await sleep(400);
  }
  return -1;
}

/**
 * 等待页面网络空闲（无 pending 请求持续800ms）
 */
async function waitForNetworkIdle(webContents, idleMs = 800, timeoutMs = 20000) {
  const start = Date.now();
  let lastBusy = Date.now();
  let pending = 0;
  const onReq = () => { pending++; };
  const onDone = () => { pending--; if (pending <= 0) { pending = 0; lastBusy = Date.now(); } else lastBusy = Date.now(); };
  webContents.on('did-start-loading', onReq);
  webContents.session; // noop
  const requestHandler = (details, cb) => { pending++; lastBusy = Date.now(); cb({}); };
  // 用 webRequest 统计
  const wr = webContents.session.webRequest;
  const filter = { urls: ['*://*/*'] };
  const before = (details, cb) => { pending++; lastBusy = Date.now(); cb({}); };
  const after = (details) => { pending = Math.max(0, pending - 1); lastBusy = Date.now(); };
  try {
    wr.onBeforeRequest(filter, before);
    wr.onCompleted(filter, after);
    wr.onErrorOccurred(filter, after);
    while (Date.now() - start < timeoutMs) {
      if (pending === 0 && Date.now() - lastBusy > idleMs) break;
      await sleep(200);
    }
  } finally {
    try {
      wr.onBeforeRequest(null);
      wr.onCompleted(null);
      wr.onErrorOccurred(null);
    } catch (_) {}
  }
  await sleep(300);
}

/**
 * React 受控组件安全填值：原生 setter + input/change 事件
 */
const FILL_TEXT_FN = `
window.__qnFillText = (selectorOrEl, value, index = 0) => {
  let el;
  if (typeof selectorOrEl === 'string') {
    const els = document.querySelectorAll(selectorOrEl);
    el = els[index];
  } else el = selectorOrEl;
  if (!el) return { ok: false, error: '元素不存在: ' + selectorOrEl };
  el.focus();
  // 清空
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const currentValue = el.value || '';
  if (currentValue) {
    nativeSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // 模拟逐段输入
  nativeSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return { ok: true };
};
`;

/**
 * 填充文本输入框
 */
async function fillText(webContents, selector, value, index = 0) {
  await ensureHelpers(webContents);
  return evalInPage(webContents, `
    return window.__qnFillText(${JSON.stringify(selector)}, ${JSON.stringify(value)}, ${index});
  `);
}

/**
 * 按【标签文本/按钮文字】点击（淘宝/千牛的按钮无稳定id，按文字最稳）
 * @param options 可见性过滤等
 */
async function clickByText(webContents, selectors, text, { timeoutMs = 10000, exact = false, index = 0 } = {}) {
  await ensureHelpers(webContents);
  const start = Date.now();
  const selArr = Array.isArray(selectors) ? selectors : [selectors];
  while (Date.now() - start < timeoutMs) {
    const ok = await evalInPage(webContents, `
      const sels = ${JSON.stringify(selArr)};
      const texts = ${JSON.stringify(text)};
      const exact = ${exact};
      const idx = ${index};
      let hits = [];
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          const t = (el.innerText || el.textContent || '').trim();
          const matched = exact ? t === texts : t.includes(texts);
          if (matched && t.length < 30) hits.push(el);
        }
      }
      if (hits.length > idx) {
        const el = hits[idx];
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
      return false;
    `);
    if (ok) { await humanPause(300, 800); return true; }
    await sleep(400);
  }
  throw new Error(`点击超时: 找不到文字为「${text}」的元素`);
}

/**
 * 普通点击（css选择器）
 */
async function clickSelector(webContents, selector, index = 0) {
  return evalInPage(webContents, `
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    const el = els[${index}];
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true };
  `);
}

/**
 * 选择下拉框选项（原生 select + 自定义下拉都支持：先试原生，再模拟点击匹配文本）
 */
async function selectOption(webContents, triggerSelector, optionText, { timeoutMs = 10000 } = {}) {
  await ensureHelpers(webContents);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalInPage(webContents, `
      const trig = document.querySelector(${JSON.stringify(triggerSelector)});
      if (!trig) return false;
      // 1. 原生 select
      if (trig.tagName === 'SELECT') {
        for (const opt of trig.options) {
          if (opt.text.includes(${JSON.stringify(optionText)})) {
            const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            proto.call(trig, opt.value);
            trig.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }
      // 2. 自定义下拉：点开再找
      trig.scrollIntoView({ block: 'center' });
      trig.click();
      await new Promise(r => setTimeout(r, 300));
      // 常见下拉面板容器
      const panels = document.querySelectorAll('[class*="dropdown"],[class*="popup"],[class*="menu"],[class*="option"],[class*="list"] li,[class*="select"] li, [role="option"], [role="listbox"] [role="option"]');
      for (const p of panels) {
        const t = (p.innerText || p.textContent || '').trim();
        if (t.includes(${JSON.stringify(optionText)}) && t.length < 50) {
          p.click();
          return true;
        }
      }
      return false;
    `);
    if (ok) return true;
    await sleep(500);
  }
  throw new Error(`下拉选择超时: ${triggerSelector} → ${optionText}`);
}

/**
 * CDP 文件上传：把本地文件设置到 input[type=file]
 * 关键点：Electron webContents 无法直接改 input.files，必须走 CDP DOM.setFileInputFiles
 */
async function setFileInputFiles(webContents, selector, filePaths, { timeoutMs = 15000, index = 0 } = {}) {
  const dbg = webContents.debugger;
  if (!dbg.isAttached()) await dbg.attach('1.3');

  const waitStart = Date.now();
  let nodeId = 0;
  while (Date.now() - waitStart < timeoutMs) {
    try {
      const doc = await dbg.sendCommand('DOM.getDocument');
      const remote = await dbg.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (remote && remote.nodeId) { nodeId = remote.nodeId; break; }
    } catch (_) {}
    await sleep(400);
  }
  if (!nodeId) throw new Error(`文件上传失败：找不到 ${selector}`);

  await dbg.sendCommand('DOM.setFileInputFiles', { files: filePaths, nodeId });
  await humanPause(500, 1200);
  return true;
}

/**
 * 页面截图存证（失败排查用）
 */
async function captureSnapshot(webContents, tag = 'debug') {
  try {
    const dir = this && this.dir ? this.dir : process.env.QN_LOG_DIR || '.';
    const file = path.join(dir, `snap-${tag}-${Date.now()}.png`);
    const img = await webContents.capturePage();
    require('fs').writeFileSync(file, img.toPNG());
    const html = await evalInPage(webContents, `return document.documentElement.outerHTML.slice(0, 5000000)`).catch(() => '');
    const htmlFile = file.replace('.png', '.html');
    require('fs').writeFileSync(htmlFile, html || '');
    return { png: file, html: htmlFile };
  } catch (e) {
    return null;
  }
}
const path = require('path');

/** 确保 helper 已注入 */
let _helperInjected = new WeakSet();
async function ensureHelpers(webContents) {
  if (_helperInjected.has(webContents)) return;
  await webContents.executeJavaScript(STEALTH_JS + FILL_TEXT_FN, false).catch(() => {});
  _helperInjected.add(webContents);
  webContents.once('did-navigate', () => _helperInjected.delete(webContents));
}

/** 页面加载完成等待 */
async function waitLoadStop(webContents, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!webContents.isLoading()) return true;
    await sleep(300);
  }
  return false;
}

module.exports = {
  sleep, rand, randFloat, humanPause,
  evalInPage, waitForSelector, waitForAnySelector, waitForNetworkIdle,
  fillText, clickByText, clickSelector, selectOption,
  setFileInputFiles, captureSnapshot,
  waitLoadStop, ensureHelpers, STEALTH_JS,
};
