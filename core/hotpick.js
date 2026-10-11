/**
 * 热点选品引擎
 * 用户输入分类关键词 → 1688一键代发搜索（按销量排序）→ 月销解析 → 评分 → 取Top N展示
 * 评分维度：月销量(50%) + 利润空间(30%) + 代发可行性(20%)
 *
 * 设计决策（与用户确认）：
 *   - 只做"热点模式"（1688月销排序选Top N），不做"蓝海模式"（1688单边数据信号弱）
 *   - 必须有审核步骤：先出评分列表让用户勾选，不要无脑全自动上传
 *   - 数据源复用 alibaba-collector.daixiaoList（已有关键词搜索+月销数据+按销量排序）
 *   - 价格估算复用 transform.calcPrice 同款逻辑（按 store.settings.price 配置）
 */
const { EventEmitter } = require('events');

class HotPick extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./alibaba-collector')} opts.aliCollector
   * @param {import('./store')} opts.store
   * @param {object} opts.logger
   */
  constructor({ aliCollector, store, logger }) {
    super();
    this.ali = aliCollector;
    this.store = store;
    this.logger = logger;
  }

  _prog(p) { try { this.emit('progress', p); } catch (_) {} }

  /**
   * 解析1688月销字符串为数字
   * "3w+" → 30000, "3000+" → 3000, "123" → 123, null → 0
   */
  static parseMonthSales(s) {
    if (s == null) return 0;
    const str = String(s).trim();
    if (!str) return 0;
    let n = parseFloat(str);
    if (!isFinite(n)) return 0;
    if (/w|万/i.test(str)) n *= 10000;
    return Math.round(n);
  }

  /**
   * 价格估算（复用 transform.calcPrice 同款逻辑）
   * 返回 { sellPrice, profit }
   */
  _estimatePrice(cost) {
    const p = this.store.settings.price || {};
    let c = Number(cost) || 0;
    if (!c) return { sellPrice: null, profit: null };
    let sell = 0;
    if (p.mode === 'fixed') {
      sell = c + (Number(p.fixed) || 0);
    } else if (p.mode === 'stepped') {
      const rule = (p.stepped || []).find(r => c <= r.max) || (p.stepped || [])[0];
      const pct = rule ? Number(rule.percent) : 30;
      sell = c * (1 + pct / 100);
    } else {
      sell = c * (1 + (Number(p.percent) || 30) / 100);
    }
    if (sell < c + (Number(p.minProfit) || 0)) sell = c + (Number(p.minProfit) || 0);
    const rule = p.roundRule || 'yuan9';
    if (rule === 'yuan') sell = Math.ceil(sell);
    else if (rule === 'yuan9') sell = Math.floor(sell) + 0.9;
    else if (rule === 'mao9') sell = Math.floor(sell * 10) / 10 + 0.09;
    const floor = Number(p.floorPrice) || 2;
    if (sell < floor) sell = floor;
    return { sellPrice: +sell.toFixed(2), profit: +(sell - c).toFixed(2) };
  }

  /**
   * 评分（0~100）：月销量50% + 利润空间30% + 代发可行性20%
   * 代发可行性：一件代发100 / 1件起批(起订量1)90 / 常规60
   */
  _score(item) {
    const sales = HotPick.parseMonthSales(item.monthSales);
    // 月销维度：10000以上满分，线性缩放
    const salesScore = Math.min(sales / 10000, 1) * 100;
    // 利润维度：利润≥10元满分，线性缩放（profit可能为null）
    const { sellPrice, profit } = this._estimatePrice(item.price);
    const profitScore = profit == null ? 30 : Math.min(profit / 10, 1) * 100;
    // 代发维度：一件代发100，1件起批90，常规货源60
    const fenxiaoScore = item.isFenxiao ? 100 : ((item.minOrderQty != null && item.minOrderQty <= 1) ? 90 : 60);
    const score = salesScore * 0.5 + profitScore * 0.3 + fenxiaoScore * 0.2;
    return { score: +score.toFixed(1), sales, sellPrice, profit };
  }

  /**
   * 搜索+评分+排序+取Top N
   * 双货源合并：一件代发频道 + 常规销量搜索（1件起批/常规货源也收，不强制代发）
   * @param {object} params { keyword, pages=3, topN=30 }
   * @returns { ok, items, message }
   */
  async search({ keyword, pages = 3, topN = 30 }) {
    if (!keyword || !String(keyword).trim()) return { ok: false, message: '请输入关键词' };
    const ccfg = this.store.settings.collect || {};
    if (ccfg.maxPages) pages = Math.min(pages, ccfg.maxPages);
    topN = Math.max(1, Math.min(topN || 30, 200));

    // 源1：一键代发频道（代发可行性确定）
    this._prog({ key: 'hotpick', title: `热点选品「${String(keyword).slice(0, 8)}」`, detail: '源1/2：搜索1688一件代发货源…', percent: 5 });
    this.logger.info('hotpick', `热点选品[代发源]: ${keyword} (${pages}页)`);
    const dx = await this.ali.daixiaoList({ keyword, pages, sortType: 'sale' });
    let items = (dx && dx.items) || [];
    this.logger.info('hotpick', `一件代发源: ${items.length} 个`);

    // 源2：常规销量搜索（不限代发，1件起批/起订量1的货源也算）
    this._prog({ key: 'hotpick', title: `热点选品「${String(keyword).slice(0, 8)}」`, detail: '源2/2：搜索1688常规货源（按销量排序）…', percent: 45 });
    this.logger.info('hotpick', `热点选品[常规源]: ${keyword} (${pages}页, 销量排序)`);
    try {
      const nm = await this.ali.collector.collectByKeyword({ keyword, pages, sortType: 'booked' });
      const nItems = (nm && nm.items) || [];
      this.logger.info('hotpick', `常规源: ${nItems.length} 个`);
      // 合并去重：offerId 为主键，一件代发频道优先（isFenxiao 标记更可靠）
      const merged = new Map();
      for (const it of items) merged.set(String(it.offerId), it);
      for (const it of nItems) {
        const k = String(it.offerId);
        if (!merged.has(k)) merged.set(k, it);
        else if (it.isFenxiao && !merged.get(k).isFenxiao) merged.set(k, { ...merged.get(k), isFenxiao: true });
      }
      items = [...merged.values()];
    } catch (e) {
      this.logger.warn('hotpick', `常规源失败（仅用代发源结果）: ${e.message}`);
    }

    if (!items.length) {
      this._prog({ key: 'hotpick', title: '热点选品', detail: '未搜索到商品', percent: 100, done: true });
      return { ok: true, items: [], message: `关键词「${keyword}」未搜索到商品` };
    }

    this._prog({ key: 'hotpick', title: `热点选品「${String(keyword).slice(0, 8)}」`, detail: `共 ${items.length} 个货源，正在评分排序…`, percent: 75 });

    // 评分 + 货源标签
    const scored = items.map(it => {
      const { score, sales, sellPrice, profit } = this._score(it);
      const shipMode = it.isFenxiao ? '一件代发' : (it.minOrderQty != null && it.minOrderQty <= 1 ? '1件起批' : '常规货源');
      return {
        offerId: it.offerId,
        title: it.title,
        image: it.image,
        price: it.price,
        monthSales: it.monthSales,
        monthSalesNum: sales,
        sellPrice,
        profit,
        score,
        isFenxiao: !!it.isFenxiao,
        minOrderQty: it.minOrderQty != null ? it.minOrderQty : null,
        shipMode,
        company: it.company || '',
        url: it.url,
        source: it.source || 'daixiao',
      };
    });

    // 按评分降序排序（服务端排序不生效时本地评分兜底）
    scored.sort((a, b) => b.score - a.score);

    // 取Top N
    const top = scored.slice(0, topN);

    this._prog({ key: 'hotpick', title: `热点选品「${String(keyword).slice(0, 8)}」`, detail: `评分完成，Top ${top.length} 个商品已就绪`, percent: 100, done: true });
    this.logger.success('hotpick', `热点选品完成: 合并${items.length}个货源 → 评分排序 → Top ${top.length}`);
    return { ok: true, items: top, total: items.length, message: `共 ${items.length} 个货源（一件代发+常规），已按评分排序取 Top ${top.length}` };
  }
}

module.exports = HotPick;
