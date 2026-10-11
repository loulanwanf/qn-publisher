/**
 * AI 全店托管运营引擎
 * 「把店铺交给它打理」——自动闭环：
 *   盘点 → 诊断（AI/规则）→ 自动执行（下架问题商品）→ 定价建议 → 日报
 *
 * 执行通道（已实测确认 2026-09-25）：
 *   - 下架：  mtop.taobao.sell.pc.manage.async
 *            url=/taobao/manager/fastEdit.htm?optType=downShelf&action=submit
 *            jsonBody={"itemId":"..."}          → {"success":true,"msg":{"text":"商品下架成功！"}}
 *   - 上架：  同上 optType=upShelf              → {"success":true,..."商品上架成功！"}
 *   - 改价/改标题：走「一键应用」（本地建议价/优化标题 → 用户确认 → 编辑页通道），周期内不自动改线上（风控）
 *
 * 托管开关（settings.ai.hosted）：
 *   enabled:bool         托管总开关
 *   autoShelf:bool       自动上下架（诊断含 违规/违禁/失败 的在售商品自动下架）
 *   autoPricing:bool     自动定价建议（按售价策略计算建议价，写 goods.suggested，不自动改线上）
 *   dailyTime:"02:00"    每日自动巡检时间（空=仅手动）
 *   maxActionsPerDay:50  每日自动执行动作上限（风控）
 *   mode:"auto"          诊断模式（auto=有Key用AI，无Key演示规则）
 */

class HostedManager {
  constructor({ store, logger, accounts, aiEngine }) {
    this.store = store;
    this.logger = logger;
    this.accounts = accounts;
    this.aiEngine = aiEngine;
    this._timer = null;
    this.running = false;
    this.lastRun = null;
    this._todayActions = 0;
    this._todayKey = '';
  }

  getConfig() {
    return (this.store.settings.ai && this.store.settings.ai.hosted) || {};
  }

  saveConfig(patch) {
    if (!this.store.settings.ai) this.store.settings.ai = {};
    this.store.settings.ai.hosted = { ...this.getConfig(), ...(patch || {}) };
    this.store._debounceSave();
    this._applyTimer();
    return { ok: true, cfg: this.store.settings.ai.hosted };
  }

  /** 每日定时器（主进程 setInterval，30s 检查一次，命中时间触发一轮托管） */
  _applyTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.dailyTime) return;
    this._timer = setInterval(() => {
      const now = new Date();
      const t = cfg.dailyTime;
      if (now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') === t) {
        this.runCycle({ reason: 'scheduled' }).catch(e => this.logger.error('hosted', '定时托管失败: ' + e.message));
      }
    }, 30000);
    if (this._timer.unref) this._timer.unref();
  }

  _dayKey() { return new Date().toISOString().slice(0, 10); }
  getTodayActions() {
    if (this._todayKey !== this._dayKey()) { this._todayKey = this._dayKey(); this._todayActions = 0; }
    return this._todayActions;
  }
  _incAction() {
    if (this._todayKey !== this._dayKey()) { this._todayKey = this._dayKey(); this._todayActions = 0; }
    return ++this._todayActions;
  }

  /** 执行一轮托管巡检（自动闭环） */
  async runCycle(opts = {}) {
    if (this.running) return { ok: false, message: '托管已在运行中' };
    this.running = true;
    const onProgress = opts.onProgress || (() => {});
    const log = (m) => this.logger.info('host', m);
    try {
      const cfg = this.getConfig();
      const reason = opts.reason || 'manual';
      const at = Date.now();
      onProgress('① 盘点店铺商品…');

      // 1. 盘点：本地商品库 + 店铺在售
      const items = [];
      const titles = new Set();
      for (const g of this.store.goods) {
        if (!g.title) continue;
        items.push({ id: g.id, offerId: g.offerId, title: g.title, price: (g.raw && g.raw.price) || g.sellPrice || 0, status: g.status, source: '本地' });
        titles.add(g.title);
      }
      const shop = this.store.accounts.find(a => a.type === 'shop');
      let win = null;
      let onsale = [];
      if (shop && this.accounts) {
        win = await this.accounts.getWorkWindow(shop, { show: false });
const { TaoApi } = require('./taobao-api');
        const api = new TaoApi(win.webContents.session, win);
        try {
          onsale = await api.getOnSaleItems();
          for (const it of onsale) {
            if (!it.title || titles.has(it.title)) continue;
            items.push({ id: null, itemId: it.itemId, offerId: it.code || it.itemId, title: it.title, price: parseFloat(it.price) || 0, status: 'published', source: '在售' });
          }
          log('盘点：本地 ' + this.store.goods.length + ' + 在售 ' + onsale.length);
        } catch (e) {
          log('在售列表拉取失败（仅本地）: ' + e.message);
        }
      }

      // 2. 诊断
      onProgress('② AI 诊断商品问题…');
      const diag = await this.aiEngine.operate(items, { mode: cfg.mode || 'auto', batch: 20, onProgress });
      const report = diag.ok ? diag : { ok: false, mode: 'demo', provider: '', model: '', stats: { total: items.length }, items: [] };

      // 3. 自动执行：下架问题商品（autoShelf + 有在售列表）
      const actions = [];
      let shelfOk = 0, shelfFail = 0;
      if (cfg.autoShelf !== false && win && onsale.length) {
        onProgress('③ 执行托管动作（下架问题商品）…');
        const { TaoApi } = require('./taobao-api');
        const api = new TaoApi(win.webContents.session, win);
        const toDown = report.items.filter(it => {
          if (!it.itemId) return false;
          const iss = (it.issues || []).join(' ');
          return /违禁|违规|下架|失败/.test(iss);
        });
        for (const it of toDown.slice(0, 20)) {
          if (this.getTodayActions() >= (cfg.maxActionsPerDay || 50)) { log('达当日动作上限，停止'); break; }
          try {
            const r = await api.manageFast('downShelf', { itemId: it.itemId });
            const ok = !!(r && r.success === true);
            if (ok) { this._incAction(); shelfOk++; actions.push({ type: 'downShelf', itemId: it.itemId, title: it.title, ok: true }); }
            else { shelfFail++; actions.push({ type: 'downShelf', itemId: it.itemId, title: it.title, ok: false, error: (r && r.msg && r.msg.text) || '未知失败' }); }
            log(`托管动作：${ok ? '下架成功' : '下架失败'} ${it.itemId} ${it.title.slice(0, 18)}`);
          } catch (e) {
            shelfFail++;
            actions.push({ type: 'downShelf', itemId: it.itemId, title: it.title, ok: false, error: e.message });
            log('下架异常 ' + it.itemId + ': ' + e.message);
          }
          await new Promise(r => setTimeout(r, 1200));
        }
      }

      // 4. 定价建议（写本地，不动线上）
      let pricing = 0;
      if (cfg.autoPricing !== false) {
        const pc = this.store.settings.price || {};
        const percent = pc.percent != null ? pc.percent : 35;
        for (const g of this.store.goods) {
          const cost = g.raw && g.raw.price;
          if (cost == null) continue;
          const suggested = Math.round(cost * (1 + percent / 100) * 100) / 100;
          if (g.sellPrice == null || Math.abs(g.sellPrice - suggested) > 0.01) { g.suggested = suggested; pricing++; }
        }
        this.store._debounceSave();
      }

      // 5. 汇总 + 记录
      const stats = {
        total: report.items.length,
        forbidden: (report.stats || {}).forbidden || 0,
        longTitle: (report.stats || {}).longTitle || 0,
        priceIssue: (report.stats || {}).priceIssue || 0,
        failed: (report.stats || {}).failed || 0,
        downShelfOk: shelfOk, downShelfFail: shelfFail, pricing,
      };
      this.lastRun = { at, reason, stats, actions };
      this._appendHostRecord({ at, reason, stats, actions });
      log(`托管完成：下架成功 ${shelfOk} / 失败 ${shelfFail}，定价建议 ${pricing}，诊断 ${report.items}`);
      return { ok: true, stats, actions, report, at };
    } catch (e) {
      this.logger.error('host', '托管异常: ' + e.message);
      return { ok: false, message: e.message };
    } finally {
      this.running = false;
    }
  }

  /** 托管记录（写入 store.records，上传记录页可查） */
  _appendHostRecord({ at, reason, stats, actions }) {
    try {
      this.store.records.unshift({
        type: 'host',
        at,
        reason,
        ok: true,
        stats,
        actions: (actions || []).slice(0, 50),
      });
      if (this.store.records.length > 2000) this.store.records.length = 2000;
      this.store._debounceSave();
    } catch (_) {}
  }

  status() {
    const cfg = this.getConfig();
    return {
      enabled: !!cfg.enabled,
      running: this.running,
      dailyTime: cfg.dailyTime || '',
      todayActions: this.getTodayActions(),
      lastRun: this.lastRun ? { at: this.lastRun.at, reason: this.lastRun.reason, stats: this.lastRun.stats } : null,
    };
  }
}

module.exports = { HostedManager };