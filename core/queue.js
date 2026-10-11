/**
 * 上架任务队列（串行 + 风控节奏）
 * - 每日限量 (dailyLimit)
 * - 随机间隔 (minGap~maxGap 秒)
 * - 单品失败记录原因，下个继续
 */
const { EventEmitter } = require('events');
const DOM = require('./dom');
const { TaoApi } = require('./taobao-api');

class Queue extends EventEmitter {
  constructor({ store, logger, collector, transform, publisher, media, accounts }) {
    super();
    this.store = store;
    this.logger = logger;
    this.collector = collector;
    this.transform = transform;
    this.publisher = publisher;
    this.media = media;
    this.accounts = accounts;
    this.running = false;
    this.pauseRequested = false;
    this.current = null;
    this.statsCache = { today: 0, ok: 0, fail: 0, remaining: 0 };
    this.onSaleCache = null; // 代发查重：在售列表缓存 { items, ts }
  }

  /** 把商品加入队列 */
  add(goodsIds) {
    let n = 0;
    for (const id of goodsIds) {
      const g = this.store.goodsById(id);
      if (g && (g.status === 'pending' || g.status === 'failed' || g.status === 'skipped')) {
        g.status = 'queued';
        g.error = null;
        n++;
      }
    }
    this.store._debounceSave();
    this._emitStats();
    return { added: n };
  }

  remove(goodsId) {
    const g = this.store.goodsById(goodsId);
    if (g && g.status === 'queued') { g.status = 'pending'; this.store._debounceSave(); }
    this._emitStats();
    return true;
  }

  status() {
    return {
      running: this.running,
      current: this.current ? { id: this.current.id, offerId: this.current.offerId, title: this.current.title } : null,
      queueCount: this.store.goods.filter(g => g.status === 'queued').length,
      todayCount: this.store.todayCount(),
    };
  }

  stats() {
    const up = this.store.settings.upset || {};
    const today = this.store.todayCount();
    const pending = this.store.goods.filter(g => g.status === 'pending').length;
    const queued = this.store.goods.filter(g => g.status === 'queued').length;
    const published = this.store.goods.filter(g => g.status === 'published').length;
    const failed = this.store.goods.filter(g => g.status === 'failed').length;
    const skipped = this.store.goods.filter(g => g.status === 'skipped').length;
    return { today, pending, queued, published, failed, skipped, running: this.running, dailyLimit: Number(up.todayLimit) || 0 };
  }

  _emitStats() {
    this.emit('stats', this.stats());
  }

  /** 代发分销查重：拉取淘宝店铺在售商品列表（带 10 分钟缓存） */
  async _refreshOnSaleCache(force) {
    const TTL = 10 * 60 * 1000;
    if (!force && this.onSaleCache && (Date.now() - this.onSaleCache.ts < TTL)) return;
    try {
      const items = await this._getOnSaleItems();
      this.onSaleCache = { items, ts: Date.now() };
      this.logger.info('queue', `代发查重：拉取在售列表 ${items.length} 件`);
    } catch (e) {
      this.logger.warn('queue', '代发查重：拉取在售列表失败 - ' + e.message);
      if (!this.onSaleCache) this.onSaleCache = { items: [], ts: Date.now() };
    }
  }

  async _getOnSaleItems() {
    if (!this.accounts) return [];
    const shop = this.store.accounts.find(a => a.type === 'shop');
    if (!shop) return [];
    const win = await this.accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    const items = [];
    // ① 在售商品列表（商家编码=offerId 匹配，黑鲸鱼代发查重同款）
    try {
      const onsale = await api.getOnSaleItems();
      for (const it of onsale) {
        items.push({ itemId: it.itemId, title: it.title, code: it.code || '', price: it.price, upDate: it.upDate, from: '在售' });
      }
    } catch (e) {
      this.logger.warn('queue', '查重：在售列表拉取失败 - ' + e.message);
    }
    // ② 卖家中心「1688铺货商品」列表（offerId 直接匹配，查重主通道）
    try {
      const listed = await api.getCommodity1688Products();
      for (const it of listed) {
        items.push({ itemId: it.itemId, title: it.srcTitle, code: it.offerId || '', price: it.srcPrice, upDate: '', from: '1688铺货' });
      }
      if (listed.length) this.logger.info('queue', `代发查重：1688铺货列表 ${listed.length} 件`);
    } catch (e) {
      this.logger.warn('queue', '查重：1688铺货列表拉取失败 - ' + e.message);
    }
    return items;
  }

  pause() {
    this.pauseRequested = true;
    this.logger.warn('queue', '已请求暂停：当前商品完成后停止');
    return { ok: true };
  }

  async start() {
    if (this.running) return { ok: false, message: '队列已在运行' };
    this.pauseRequested = false;
    this.running = true;
    this._loop().catch(e => this.logger.error('queue', '队列异常退出', e.message));
    return { ok: true, message: '队列已启动' };
  }

  shutdown() {
    this.pauseRequested = true;
    this.running = false;
  }

  async _loop() {
    this.logger.info('queue', '=== 上架队列启动 ===');
    try {
      while (!this.pauseRequested) {
        // 1. 每日限量（黑鲸鱼 txtTodayLimit：0=不限）
        const up = this.store.settings.upset || {};
        const dailyLimit = Number(up.todayLimit) || 0;
        const today = this.store.todayCount();
        if (dailyLimit > 0 && today >= dailyLimit) {
          this.logger.warn('queue', `已达每日限量 ${dailyLimit}，队列挂起`);
          this.emit('progress', { type: 'daily-limit', limit: dailyLimit });
          break;
        }

        // 2. 取一个待上架商品
        let goods = this.store.goods.find(g => g.status === 'queued');
        if (!goods) {
          this.logger.info('queue', '队列已空，退出');
          this.emit('progress', { type: 'idle' });
          break;
        }

        // 3. 跳过已上传的（黑鲸鱼 chkSkipItem/ExistsUploadItemByOldid：同源商品发布成功过则跳过）
        if (up.skipItem !== false) {
          const dup = this.store.goods.find(g => g.status === 'published' && g.offerId === goods.offerId && g.id !== goods.id)
            || this.store.records && this.store.records.find(r => r.ok && r.offerId === goods.offerId);
          if (goods.uploaded || dup) {
            goods.status = 'skipped';
            goods.error = '已上传过，跳过';
            this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: goods.title, ok: false, error: goods.error });
            this.store._debounceSave();
            this.logger.warn('queue', `跳过 [${goods.offerId}]: ${goods.error}`);
            this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, ok: false, error: goods.error });
            this._emitStats();
            continue;
          }
        }

        // 3.5 代发分销查重：店铺在售列表已有同源商品（offerId 匹配商家编码）则跳过
        if (up.skipDaixiao !== false) {
          // 3.5.1 本地查重打标命中（界面点过「查重」后 goods.dupItemId 已写入）→ 直接跳过
          if (goods.dupItemId) {
            goods.status = 'skipped';
            goods.error = `查重命中：店铺已有同款(商品ID=${goods.dupItemId}, ${goods.dupSource || '1688铺货'})，跳过`;
            this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: goods.title, ok: false, error: goods.error });
            this.store._debounceSave();
            this.logger.warn('queue', `跳过 [${goods.offerId}]: ${goods.error}`);
            this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, ok: false, error: goods.error });
            this._emitStats();
            continue;
          }
          await this._refreshOnSaleCache();
          const onSale = (this.onSaleCache && this.onSaleCache.items) || [];
          const hit = onSale.find(it => it.code && it.code === String(goods.offerId));
          if (hit) {
            goods.status = 'skipped';
            goods.error = `店铺已有同款(编码=${hit.code}, itemId=${hit.itemId}${hit.from ? ', ' + hit.from : ''})，跳过`;
            this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: goods.title, ok: false, error: goods.error });
            this.store._debounceSave();
            this.logger.warn('queue', `跳过 [${goods.offerId}]: ${goods.error}`);
            this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, ok: false, error: goods.error });
            this._emitStats();
            continue;
          }
        }

        // 4. 转换 + 发布
        this.current = goods;
        this.emit('progress', { type: 'start-item', goodsId: goods.id, offerId: goods.offerId, title: goods.title });

        // 4.1 轻量导入/快速添加的商品（仅有offerId无详情）→ 上传前自动补采详情
        const needDetail = !goods.raw
          || (!goods.raw.mainImages && goods.raw.price == null)
          || /^待采集\s/.test(goods.title || '');
        if (needDetail) {
          this.logger.info('queue', `补采详情 [${goods.offerId}]（轻量导入，上传前自动采集）`);
          this.emit('progress', { type: 'collect-detail', goodsId: goods.id, offerId: goods.offerId, title: '补采详情中…' });
          try {
            const data = await this.collector.collectOne(goods.offerId, { downloadImages: true });
            // 补采后校验：价格必须有效，否则报明确错误（而非模糊的"未取到成本价"）
            if ((data.price == null || !(Number(data.price) > 0)) && !data.priceRange) {
              throw new Error('详情页未提取到价格（1688可能需登录采集账号才显示价格，或页面已被风控拦截）');
            }
            goods.raw = data;
            goods.title = data.title || goods.title;
            // 补采拿到真实成本价后，重算此前按0成本误存的售价（用户手动改过价的不动）
            if (!goods.sellPriceManual) goods.sellPrice = null;
            goods.updatedAt = Date.now();
            this.store._debounceSave();
          } catch (e) {
            goods.status = 'failed';
            goods.error = '详情采集失败: ' + e.message;
            this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: goods.title, ok: false, error: goods.error });
            this.store._debounceSave();
            this.logger.error('queue', `补采详情失败 [${goods.offerId}]: ${e.message}`);
            this.current = null;
            this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, ok: false, error: goods.error });
            this._emitStats();
            continue;
          }
        }

        const built = this.transform.build(goods);

        // 售价无法确定（无成本价/低于最低限价且配置跳过）：标记 skipped，快速继续下一个
        if (built.price == null) {
          goods.status = 'skipped';
          goods.error = (built.warnings || []).find(w => /定价|限价/.test(w)) || '无法确定售价，已跳过';
          this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: goods.title, ok: false, error: goods.error });
          this.store._debounceSave();
          this.logger.warn('queue', `跳过 [${goods.offerId}]: ${goods.error}`);
          this.current = null;
          this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, ok: false, error: goods.error });
          this._emitStats();
          continue;
        }

        goods.publishTitle = built.title;
        if (goods.sellPrice == null) goods.sellPrice = built.price;
        goods.status = 'publishing';
        this.store._debounceSave();

        const t0 = Date.now();
        let result;
        try {
          result = await this.publisher.publish(goods, {});
        } catch (e) {
          // 过滤类跳过（店铺名/品牌词/图片地址/不包邮/已下架/违禁词/属性过滤）：标记 skipped 不计失败
          if (e.skip) {
            goods.status = 'skipped';
            goods.error = e.message;
            this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: goods.title, ok: false, error: e.message });
            this.store._debounceSave();
            this.logger.warn('queue', `过滤跳过 [${goods.offerId}]: ${e.message}`);
            this.current = null;
            this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, ok: false, error: e.message });
            this._emitStats();
            continue;
          }
          // 登录态失效类：终止队列（继续跑必全军覆没，等用户重新扫码）
          if (/登录态|扫码登录|请先在「店铺管理」/.test(e.message || '')) {
            goods.status = 'pending';   // 回队待重试
            goods.error = e.message;
            this.store._debounceSave();
            this.current = null;
            this.logger.error('queue', `队列终止：${e.message}（商品已回队）`);
            this.emit('progress', { type: 'login-expired', message: e.message });
            break;
          }
          // 配置缺失类（类目关键词等）：整批每个都会失败，立即停止让用户补配置
          if (/未配置|类目关键词|请先配置/.test(e.message || '')) {
            goods.status = 'pending';   // 回队，配置补全后直接重跑
            goods.error = e.message;
            this.store._debounceSave();
            this.current = null;
            this.logger.error('queue', `队列终止：上传配置缺失 - ${e.message}（商品已回队）`);
            this.emit('progress', { type: 'config-error', message: e.message });
            this.pauseRequested = true;
            break;
          }
          // 风控/验证类错误（黑鲸鱼 chkAutoVerify 自动过验证码：显示工作窗口等用户完成后重试一次）
          if (/验证|滑块|风控|punish|USER_VALIDATE/i.test(e.message || '') && up.autoVerify !== false) {
            this.logger.warn('queue', `遇验证/风控 [${goods.offerId}]，显示工作窗口等待人工验证…`);
            this.emit('progress', { type: 'verify-needed', offerId: goods.offerId });
            try { await this.publisher._shopWindow({ show: true }); } catch (_) {}
            await DOM.sleep(45 * 1000);
            try {
              result = await this.publisher.publish(goods, {});
            } catch (e2) {
              // 重试一次仍失败：按单品失败处理，继续下一个（不中断整批）
              this._failItem(goods, built, e2.message, t0);
              continue;
            }
          } else {
            // 其他错误：单品失败继续下一个（黑鲸鱼"单品失败记录原因，下个继续"）
            this._failItem(goods, built, e.message, t0);
            // 连续失败熔断：防无人值守刷废（登录失效/风控升级/系统故障时全军覆没）
            this._consecFails = (this._consecFails || 0) + 1;
            if (this._consecFails >= 5) {
              this.logger.error('queue', `连续失败 ${this._consecFails} 次，自动熔断暂停队列（请查看失败原因，处理后重新开始）`);
              this.emit('progress', { type: 'consec-fail', count: this._consecFails });
              this.pauseRequested = true;
            }
            continue;
          }
        }
        const dur = Math.round((Date.now() - t0) / 1000);

        if (result.ok) {
          goods.status = 'published';
          goods.uploaded = true;
          goods.publishedAt = Date.now();
          goods.itemUrl = result.itemUrl || '';
          goods.publishLog.push({ at: Date.now(), ok: true, durationSec: dur, steps: result.steps, extraItemId: result.extraItemId || '' });
          this.store.incTodayCount();
          this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: built.title || goods.title, ok: true, itemUrl: goods.itemUrl, error: '' });
          this.logger.success('queue', `上架成功 [${goods.offerId}] ${built.title.slice(0, 20)} (${dur}s)` + (result.extraItemId ? ` +裂变${result.extraItemId}` : ''));
          this._consecFails = 0;   // 成功即重置连续失败计数
        } else {
          goods.status = 'failed';
          goods.error = result.error || '未知错误';
          goods.publishLog.push({ at: Date.now(), ok: false, error: result.error, steps: result.steps });
          this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: built.title || goods.title, ok: false, error: goods.error });
          this.logger.error('queue', `上架失败 [${goods.offerId}]: ${goods.error}`);
          // 连续失败熔断（publish 返回 ok:false 不抛错的场景同样计入）
          this._consecFails = (this._consecFails || 0) + 1;
          if (this._consecFails >= 5) {
            this.logger.error('queue', `连续失败 ${this._consecFails} 次，自动熔断暂停队列（请查看失败原因，处理后重新开始）`);
            this.emit('progress', { type: 'consec-fail', count: this._consecFails });
            this.pauseRequested = true;
          }
        }
        this.store._debounceSave();
        this.current = null;
        this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, title: goods.publishTitle || goods.title, ok: result.ok, error: result.error });
        this._emitStats();

        // 5. 随机间隔
        if (!this.pauseRequested) {
          const gap = this._randGap();
          this.logger.info('queue', `等待 ${gap}s 后继续下一个`);
          this.emit('progress', { type: 'gap', seconds: gap });
          const start = Date.now();
          while (Date.now() - start < gap * 1000 && !this.pauseRequested) {
            await DOM.sleep(1000);
          }
        }
      }
    } finally {
      this.running = false;
      this.current = null;
      this.logger.info('queue', '=== 队列停止 ===');
      this.emit('progress', { type: 'stopped' });
      this._emitStats();
    }
  }

  /** 单品失败统一处理：标记 failed + 记录 + 日志 + 进度事件（不中断队列） */
  _failItem(goods, built, errMsg, t0) {
    const dur = Math.round((Date.now() - t0) / 1000);
    goods.status = 'failed';
    goods.error = errMsg || '未知错误';
    goods.publishLog.push({ at: Date.now(), ok: false, error: errMsg, durationSec: dur });
    this.store.addRecord({ goodsId: goods.id, offerId: goods.offerId, title: (built && built.title) || goods.title, ok: false, error: goods.error });
    this.store._debounceSave();
    this.logger.error('queue', `上架失败 [${goods.offerId}]: ${goods.error}`);
    this.current = null;
    this.emit('progress', { type: 'item-done', goodsId: goods.id, offerId: goods.offerId, title: goods.publishTitle || goods.title, ok: false, error: errMsg });
    this._emitStats();
  }

  _randGap() {
    // 黑鲸鱼节奏：固定间隔秒（txtIntervalSec）+ 分钟（txtJgMinute），加±20%随机抖动防风控
    const up = this.store.settings.upset || {};
    const base = (Number(up.intervalSec) || 0) + (Number(up.jgMinute) || 0) * 60;
    if (base > 0) return Math.max(3, Math.round(base * (0.8 + Math.random() * 0.4)));
    const p = this.store.settings.pace || {};
    const min = Number(p.minGap) || 45;
    const max = Number(p.maxGap) || 180;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

}

module.exports = Queue;
