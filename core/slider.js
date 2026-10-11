/**
 * 滑块验证自动化引擎
 * - 阿里系滑块（punish page 的 nc_1 滑块 / 淘宝登录滑块）真实事件模拟
 * - 1688 刮刮卡滑块（scratch-captcha / baxia captchacapslidev2）：CDP 输入 + canvas 图案边界探测
 * - 输入通道：优先 CDP Input.dispatchMouseEvent（隐藏窗口下 sendInputEvent 不生效，
 *   Chromium 隐藏窗口合成器不处理输入；CDP 直接派发渲染器，可靠）
 * - 贝塞尔轨迹：先快后慢 + 随机抖动，过阿里行为检测
 * - 多次尝试，全部失败才返回 false（由上层弹人工）
 */
const DOM = require('./dom');
// Electron 主进程无全局 WebSocket（诊断实测 hasWs:false），用 ws 包
let WsLib = null;
try { WsLib = require('ws'); } catch (_) {}
const Ws = WsLib && (WsLib.WebSocket || WsLib);

// 常见滑块按钮选择器（阿里系多种模板）
const SLIDER_SEL = [
  '#nc_1_n1z',                          // 阿里 nc 滑块按钮（经典）
  '#scratch-captcha-btn-icon',          // 1688 刮刮卡滑块（baxia captchacapslidev2）
  '.scratch-captcha-slider [class*="icon"]',
  '[id^="nc_1_n1z"]',
  '.nc-lang-cnt .btn_slide',
  '.btn_slide',
  '#nc_1__scale__btn',
  '[id*="__scale__btn"]',
  '[class*="slider"] [class*="btn"]',
  '[class*="slide-btn"]',
  '[class*="handler"]',
  '.J_Slider .btn',
];

class Slider {
  /** 检测当前页面是否是滑块验证页，返回滑块信息 */
  static async detect(webContents) {
    return DOM.evalInPage(webContents, `
      const sels = ${JSON.stringify(SLIDER_SEL)};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          const track = el.closest('[class*="scale"], [class*="track"], [class*="slider"]') || el.parentElement;
          const tr = track ? track.getBoundingClientRect() : r;
          if (r.width > 0 && r.height > 0) {
            // 刮刮卡滑块（scratch-captcha）：拖动同步刮开涂层；经典 nc 滑块留余量
            const isScratch = /scratch-captcha/.test(String(track ? track.className : '') + ' ' + sel);
            return { found: true, sel, full: isScratch,
              btn: { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height },
              trackW: Math.max(tr.width, 260) };
          }
        }
      }
      // 文本兜底判断是否在验证页（按钮没渲染出位置）
      const t = (document.body && document.body.innerText) || '';
      const isVerifyPage = /请拖动滑块|拖动滑块完成|按照说明拖动滑块|安全验证|滑动验证/.test(t) || (document.title || '').includes('验证');
      return { found: false, isVerifyPage };
    `).catch(() => ({ found: false }));
  }

  /* ==================== CDP 输入层（隐藏窗口可靠） ==================== */

  /**
   * 找到 webContents 对应的 9224 远程调试 target（标记注入匹配法，URL 无关可靠）
   * 应用以 --remote-debugging-port=9224 启动（main.js 固有配置），
   * 该模式下页面 target 已被远程调试服务占用，wc.debugger.attach 必失败；
   * 而远程端口通道对隐藏窗口的 Input.dispatchMouseEvent 完全有效（实测）
   */
  static async _remoteTarget(wc) {
    try {
      const mark = '__qn_slider_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      await wc.executeJavaScript(`window[${JSON.stringify(mark)}] = 1`, false).catch(() => {});
      const res = await fetch('http://127.0.0.1:9224/json');
      const list = await res.json();
      for (const t of (list || []).filter(x => x.type === 'page' && x.webSocketDebuggerUrl)) {
        const hit = await this._wsEval(t.webSocketDebuggerUrl, `!!window[${JSON.stringify(mark)}]`).catch(() => false);
        if (hit) return t;
      }
    } catch (_) {}
    return null;
  }

  /** 在远程调试 ws 上执行表达式（一次性连接） */
  static _wsEval(wsUrl, expr) {
    return new Promise((resolve, reject) => {
      if (!Ws) { reject(new Error('no ws lib')); return; }
      try {
        const ws = new Ws(wsUrl);
        const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('ws timeout')); }, 4000);
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
        };
        ws.onmessage = ev => {
          try {
            const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
            if (m.id === 1) {
              clearTimeout(timer);
              const v = m.result && m.result.result && m.result.result.value;
              try { ws.close(); } catch (_) {}
              resolve(v);
            }
          } catch (_) {}
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      } catch (e) { reject(e); }
    });
  }

  /** 建立持续可用的远程输入会话（拖动序列复用一条连接） */
  static async _openRemoteInput(wc, log) {
    if (!Ws) { log && log('远程CDP诊断: ws库不可用'); return null; }
    let target = null;
    try {
      target = await this._remoteTarget(wc);
      if (!target) { log && log('远程CDP诊断: target未找到'); return null; }
    } catch (e) {
      log && log(`远程CDP诊断: targetErr ${e.message}`);
      return null;
    }
    const t = target;
    return await new Promise((resolve) => {
      try {
        const ws = new Ws(t.webSocketDebuggerUrl);
        let seq = 0;
        const pending = new Map();
        ws.on('message', data => {
          try {
            const m = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (m.id && pending.has(m.id)) {
              pending.get(m.id)(m);
              pending.delete(m.id);
            }
          } catch (_) {}
        });
        ws.on('open', () => resolve({
          ws,
          mouse: ({ type, x, y, button = 'left', clickCount = 0 }) => new Promise(res => {
            const cdpType = { mouseDown: 'mousePressed', mouseUp: 'mouseReleased', mouseMove: 'mouseMoved' }[type] || type;
            const i = ++seq;
            pending.set(i, res);
            try {
              ws.send(JSON.stringify({ id: i, method: 'Input.dispatchMouseEvent', params: { type: cdpType, x: Math.round(x), y: Math.round(y), button, clickCount } }));
            } catch (e) {
              pending.delete(i);
              res({ err: e.message });
              return;
            }
            setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ err: 'timeout' }); } }, 5000);
          }),
          close: () => { try { ws.close(); } catch (_) {} },
        }));
        ws.on('error', () => { log && log('远程CDP诊断: ws连接失败'); resolve(null); });
        setTimeout(() => resolve(null), 5000);
      } catch (e) {
        log && log(`远程CDP诊断: ws异常 ${e.message}`);
        resolve(null);
      }
    });
  }

  /** 确保 webContents 已 attach debugger（CDP 输入需要）
   *  Electron: attach(protocolVersion)，isAttached() 无参数 */
  static async _attach(wc) {
    try {
      if (!wc.debugger.isAttached()) await wc.debugger.attach('1.3');
      return true;
    } catch (_) {
      // 已被其他调试器 attach 或不支持：降级 sendInputEvent
      return false;
    }
  }

  /** 降级输入：wc.debugger CDP，再降级 sendInputEvent（隐藏窗口可能无效） */
  static async _mouseWc(wc, { type, x, y, button = 'left', clickCount = 0 }) {
    const cdpType = { mouseDown: 'mousePressed', mouseUp: 'mouseReleased', mouseMove: 'mouseMoved' }[type] || type;
    try {
      if (wc.debugger.isAttached()) {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: cdpType, x: Math.round(x), y: Math.round(y), button, clickCount,
        });
        return true;
      }
    } catch (_) {}
    try {
      await wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount });
      return true;
    } catch (_) { return false; }
  }

  /* ==================== 经典滑块（nc_1 等） ==================== */

  /**
   * 尝试自动滑一次滑块（真实事件 + 三段贝塞尔速度）
   * @param input 输入会话 { mouse(evt) }（远程 CDP 通道；为 null 时降级 wc）
   */
  static async trySlide(webContents, info, input = null) {
    const wc = webContents;
    const mouse = input ? input.mouse : (evt) => this._mouseWc(wc, evt);
    const startX = Math.round(info.btn.x);
    const startY = Math.round(info.btn.y);
    // 目标距离：经典滑块留 46px 余量（滑过头失败）
    const dist = Math.round(info.trackW - 46);

    await mouse({ type: 'mouseMove', x: startX, y: startY, button: 'none' });
    await DOM.sleep(120 + Math.random() * 180);
    await mouse({ type: 'mouseDown', x: startX, y: startY, clickCount: 1 });
    await DOM.sleep(60 + Math.random() * 100);

    // 三段速度：快(62%) → 慢(到92%) → 贴到头，带 y 抖动
    const segs = [
      { n: 8, to: dist * 0.62, dur: [40, 80] },
      { n: 10, to: dist * 0.92, dur: [70, 130] },
      { n: 6, to: dist, dur: [90, 170] },
    ];
    let cur = 0;
    for (const seg of segs) {
      for (let i = 1; i <= seg.n; i++) {
        const target = cur + (seg.to - cur) * (i / seg.n);
        const jitterY = (Math.random() - 0.5) * 3.5;
        await mouse({ type: 'mouseMove', x: startX + Math.round(target), y: startY + Math.round(jitterY), clickCount: 1 });
        await DOM.sleep(seg.dur[0] + Math.random() * (seg.dur[1] - seg.dur[0]));
      }
      cur = seg.to;
    }
    await DOM.sleep(80 + Math.random() * 120);
    await mouse({ type: 'mouseUp', x: startX + dist, y: startY, clickCount: 1 });
    await DOM.sleep(600);
    return { ok: true };
  }

  /* ==================== 刮刮卡滑块（scratch-captcha） ==================== */

  /** 读 answer canvas 图案内容右边界（px，无内容返回 0）
   *  机制：拖动进度解锁刮开区域；涂层=白色磨砂（饱和度≈0），图案=彩色（饱和度高）
   *  实测：图案列 sat 125-621，涂层列 sat 0 —— 完美可分
   *  图案右缘 = 最右"高饱和列"；刮开进度超过它即"图案完整" */
  static async _scratchEdge(webContents) {
    return DOM.evalInPage(webContents, `
      return (() => {
        const c = document.querySelector('#captcha-answer');
        if (!c) return -1;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const W = c.width, H = c.height;
        let edge = 0;
        for (let x = W - 1; x >= 0; x--) {
          let sat = 0;
          for (let y = 0; y < H; y += 2) {
            const i = (y * W + x) * 4;
            if (d[i + 3] < 50) continue;
            const mx = Math.max(d[i], d[i+1], d[i+2]), mn = Math.min(d[i], d[i+1], d[i+2]);
            if (mx - mn > 40) sat++;
          }
          if (sat >= 5) { edge = x; break; }
        }
        return edge;
      })();
    `).catch(() => -1);
  }

  /**
   * 刮刮卡拖动（确定式两段策略）：
   *   第一段：按住拖到尽头，全程记录图案右缘最大值 edgeMax（canvas 完整呈现，无提交风险）
   *   第二段：按住回拖到 edgeMax + 6（图案右缘略过 6px = 图案完整位置），松手提交
   * 安全性：不松手不提交；图案间空白段不会误判（第一段全程扫描）
   */
  static async trySlideScratch(webContents, info, log, input = null) {
    const wc = webContents;
    const mouse = input ? input.mouse : (evt) => this._mouseWc(wc, evt);
    const startX = Math.round(info.btn.x);
    const startY = Math.round(info.btn.y);
    const maxDist = Math.round(info.trackW - (info.btn.w || 20) - 4);

    await mouse({ type: 'mouseMove', x: startX, y: startY, button: 'none' });
    await DOM.sleep(200);
    await mouse({ type: 'mouseDown', x: startX, y: startY, clickCount: 1 });
    await DOM.sleep(150);

    // ---- 第一段：拖到尽头，记录图案右缘最大值 ----
    let cur = 0;
    let edgeMax = 0;
    let probes = 0;
    const stepPx = 12;
    while (cur < maxDist) {
      cur = Math.min(cur + stepPx, maxDist);
      const jy = startY + (Math.random() - 0.5) * 3;
      const mr = await mouse({ type: 'mouseMove', x: startX + cur, y: Math.round(jy), clickCount: 1 });
      if (mr && mr.err) { log && log(`刮刮卡：输入通道错误 ${mr.err}`); break; }
      await DOM.sleep(80 + Math.random() * 50);
      const e2 = await this._scratchEdge(wc);
      probes++;
      if (typeof e2 === 'number' && e2 > edgeMax) edgeMax = e2;
    }
    log && log(`刮刮卡：全程扫描完成（图案右缘${edgeMax}px，探测${probes}次，尽头${maxDist}px）`);

    // ---- 第二段：回拖到答案位置（图案右缘+6），松手 ----
    const answerDist = Math.min(edgeMax + 6, maxDist);
    if (edgeMax > 30 && cur > answerDist + 4) {
      // 回拖（慢速，行为检测友好）
      while (cur > answerDist) {
        cur = Math.max(cur - 14, answerDist);
        const jy = startY + (Math.random() - 0.5) * 3;
        await mouse({ type: 'mouseMove', x: startX + cur, y: Math.round(jy), clickCount: 1 });
        await DOM.sleep(90 + Math.random() * 60);
      }
      log && log(`刮刮卡：回拖至答案位${answerDist}px（右缘${edgeMax}+6），松手`);
    } else {
      log && log(`刮刮卡：在${answerDist}px松手（右缘${edgeMax}px）`);
    }
    await DOM.sleep(300 + Math.random() * 200);
    await mouse({ type: 'mouseUp', x: startX + answerDist, y: startY, clickCount: 1 });
    await DOM.sleep(600);
    return { ok: true };
  }

  /**
   * 完整流程（策略：单纯拉动型自动过；刮刮卡等复杂验证弹小窗人工过）
   * - 经典 nc 滑块（纯拖到底）：CDP 输入自动拖（隐藏窗口可靠）
   * - 刮刮卡（scratch-captcha，需图案判断）：弹验证小窗置顶等待用户手动完成（黑鲸鱼 Frm_Login 同模式）
   * @returns {passed: true} 通过（自动或人工） | {passed: false} 未通过
   */
  static async solve(win, logger, tag = 'slider', maxTries = 3) {
    const log = (m) => logger && logger.info(tag, m);

    // ---------- 刮刮卡类（复杂验证）：直接弹人工小窗 ----------
    {
      const isScratch = await DOM.evalInPage(win.webContents, `
        return !!document.querySelector('#captcha-answer, .scratch-captcha-slider, .baxia-punish.captchacapslidev2');
      `).catch(() => false);
      if (isScratch) {
        return await this._manualVerify(win, log, '刮刮卡验证（需图案判断）');
      }
    }

    // ---------- 纯拖动型滑块：自动 ----------
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const info = await this.detect(win.webContents);
      if (!info || !info.found) {
        if (!info || !info.isVerifyPage) return { passed: true, note: '页面无滑块' };
        // 按钮没渲染出来：可能是刮刮卡题目刷新中，弹人工更稳
        const scratchNow = await DOM.evalInPage(win.webContents, `
          return !!document.querySelector('#captcha-answer, .scratch-captcha-slider');
        `).catch(() => false);
        if (scratchNow) return await this._manualVerify(win, log, '刮刮卡验证（需图案判断）');
        log(`第${attempt}次：验证页但未定位到滑块按钮，等待重试…`);
        await DOM.sleep(1500);
        continue;
      }
      const input = await this._openRemoteInput(win.webContents, log).catch(() => null);
      const attached = input ? true : await this._attach(win.webContents).catch(() => false);
      log(`第${attempt}次：自动拖动滑块 (按钮@${Math.round(info.btn.x)},${Math.round(info.btn.y)}, 距离${Math.round(info.trackW - 46)}px, ${input ? '远程CDP通道' : 'wc通道(' + attached + ')'})`);
      try {
        await this.trySlide(win.webContents, info, input);
      } catch (e) {
        log(`拖动异常: ${e.message}`);
      } finally {
        try { input && input.close(); } catch (_) {}
      }
      await DOM.sleep(1800);
      const after = await DOM.evalInPage(win.webContents, `
        const t = (document.body && document.body.innerText) || '';
        const passed = /验证通过|验证成功|通过验证/.test(t);
        const btnGone = !document.querySelector(${JSON.stringify(SLIDER_SEL.join(','))});
        const stillAsk = /请拖动滑块|拖动滑块完成|按照说明拖动滑块/.test(t);
        return { passed, btnGone, stillAsk };
      `).catch(() => ({ passed: false }));
      if (after && (after.passed || after.btnGone)) {
        log(`第${attempt}次自动滑块成功`);
        await DOM.sleep(1200);
        return { passed: true, attempt };
      }
      log(`第${attempt}次未通过${after && after.stillAsk ? '（滑块要求重新拖动）' : ''}，重试…`);
      await DOM.sleep(1500);
    }
    // 自动 3 次未过：弹人工兜底（不再自动重试浪费风控次数）
    return await this._manualVerify(win, log, '自动滑块多次未通过');
  }

  /**
   * 人工验证：弹出验证小窗（置顶+聚焦），等待用户完成（页面离开验证态），恢复隐藏
   * 黑鲸鱼 Frm_Login(url, isVer: true) 同模式
   * @returns {passed} 用户完成验证 true；超时 false
   */
  static async _manualVerify(win, log, reason) {
    log(`需人工验证（${reason}）：弹出验证窗口…`);
    try { win.show(); } catch (_) {}
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
    try {
      win.setTitle('【需要人工】滑块验证 - 请在窗口中完成验证（完成后自动继续）');
      win.focus();
      win.webContents.focus();
    } catch (_) {}

    const start = Date.now();
    const TIMEOUT = 5 * 60 * 1000;
    while (Date.now() - start < TIMEOUT) {
      await DOM.sleep(2000);
      const still = await DOM.evalInPage(win.webContents, `
        const t = (document.body && document.body.innerText) || '';
        return (document.title || '').includes('验证') || (document.title || '').includes('拦截') ||
          /请拖动滑块|按照说明拖动滑块|请按照说明进行验证/.test(t) ||
          !!document.querySelector('#captcha-answer, .scratch-captcha-slider');
      `).catch(() => true);
      if (!still) {
        try { win.setAlwaysOnTop(false); } catch (_) {}
        try { win.hide(); } catch (_) {}
        log('人工验证完成，继续流程');
        await DOM.sleep(800);
        return { passed: true, via: 'manual' };
      }
    }
    try { win.setAlwaysOnTop(false); } catch (_) {}
    try { win.hide(); } catch (_) {}
    log('等待人工验证超时(5分钟)');
    return { passed: false, via: 'manual-timeout' };
  }
}

module.exports = { Slider, SLIDER_SEL };