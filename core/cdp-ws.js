/**
 * CDP WebSocket 辅助模块
 * 
 * Electron 内置 webContents.debugger 对跨域 iframe（OOPIF）支持不完整，
 * Page.getFrameTree 看不到跨域子帧。改用 WebSocket 连接 CDP 端口，可完整
 * 枚举所有 frame（含 OOPIF），与测试脚本一致。
 */
const WebSocket = require('ws');
const http = require('http');

class CDPWS {
  constructor(port = 9224) {
    this.port = port;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  /** 获取 CDP 目标列表 */
  _getTargets() {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${this.port}/json`, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }

  /** 连接到匹配 filter 的页面目标 */
  async connect(filter) {
    const targets = await this._getTargets();
    const target = targets.find(t => t.type === 'page' && filter(t));
    if (!target) throw new Error('CDP target not found');
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, r2) => { this.ws.on('open', r); this.ws.on('error', r2); });
    this.ws.on('message', (data) => {
      const m = JSON.parse(data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.events.push(m);
    });
    return this;
  }

  /** 发送 CDP 命令 */
  send(method, params = {}) {
    return new Promise((r, r2) => {
      const id = ++this.id;
      this.pending.set(id, r);
      this.ws.send(JSON.stringify({ id, method, params }));
      // 超时兜底
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); r2(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }

  /** 在主 frame 执行 JS */
  async eval(expression, returnByValue = true) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'EXC';
    return r.result && r.result.result ? r.result.result.value : null;
  }

  /** 查找 frame tree 中匹配的 frame */
  async findFrame(urlPattern) {
    const ft = await this.send('Page.getFrameTree');
    const frames = [];
    const walk = (node) => {
      if (node.frame && urlPattern.test(node.frame.url || '')) frames.push(node.frame);
      (node.childFrames || []).forEach(walk);
    };
    walk(ft.result.frameTree);
    return frames[0] || null;
  }

  /** 在指定 frame 内执行 JS（自动管理 isolated world） */
  async evalInFrame(frameId, expression) {
    let w = await this.send('Page.createIsolatedWorld', { frameId });
    let ctx = w.result.executionContextId;
    let r = await this.send('Runtime.evaluate', { expression, contextId: ctx, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      // world 可能已失效，重建
      w = await this.send('Page.createIsolatedWorld', { frameId });
      ctx = w.result.executionContextId;
      r = await this.send('Runtime.evaluate', { expression, contextId: ctx, returnByValue: true, awaitPromise: true });
    }
    if (r.result && r.result.exceptionDetails) return 'EXC';
    return r.result && r.result.result ? r.result.result.value : null;
  }

  /** 创建 frame eval 帮助函数（自动重连失效 frame） */
  createFrameEval(frameId) {
    let _fid = frameId;
    let _ctx = null;
    const ensureCtx = async () => {
      const w = await this.send('Page.createIsolatedWorld', { frameId: _fid });
      _ctx = w.result.executionContextId;
    };
    return async (expr) => {
      if (!_ctx) await ensureCtx();
      let r = await this.send('Runtime.evaluate', { expression: expr, contextId: _ctx, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) {
        await ensureCtx();
        r = await this.send('Runtime.evaluate', { expression: expr, contextId: _ctx, returnByValue: true, awaitPromise: true });
      }
      if (r.result && r.result.exceptionDetails) return 'EXC';
      return r.result && r.result.result ? r.result.result.value : null;
    };
  }

  /** 等待事件 */
  waitForEvent(method, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const found = this.events.find(e => e.method === method);
        if (found) { resolve(found); return; }
        if (Date.now() - start > timeoutMs) { resolve(null); return; }
        setTimeout(check, 200);
      };
      check();
    });
  }

  close() { if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; } }
}

module.exports = { CDPWS };
