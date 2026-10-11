/**
 * 商品转换引擎
 * 1688 raw 数据 → 千牛上架数据：
 *   - 标题清洗（去1688批发词汇 + 极限词替换 + 30字截断）
 *   - 违禁词检测（上架前最后一道闸）
 *   - 价格策略（百分比/固定/阶梯加价 + 保底利润 + 尾数规则）
 *   - 模板默认值套用（运费模板/退货地址/发货地/库存/7天无理由）
 */
class Transform {
  constructor(store) {
    this.store = store;
  }

  /** 转换一条商品：输入 store goods 记录，输出发布所需完整数据 */
  build(goods) {
    const s = this.store.settings;
    const raw = goods.raw || {};
    const priceCfg = s.price || {};
    const imgCfg = s.image || {};
    const cost = pickCost(raw, priceCfg.source);

    const title = this.cleanTitle(raw.title || goods.title || '');
    const riskWords = this.findRiskWords(title);
    const price = goods.sellPrice != null ? goods.sellPrice : this.calcPrice(cost);

    // 图片数量按配置裁剪（主图1~5，详情0~60）
    const mainCount = clampInt(imgCfg.mainCount, 1, 5, 5);
    const detailCount = clampInt(imgCfg.detailCount, 0, 60, 20);

    return {
      id: goods.id,
      offerId: goods.offerId,
      title,
      cost,
      price,
      riskWords,
      images: goods.raw ? {
        mainRemote: (raw.mainImages || []).slice(0, mainCount),
        detailRemote: (raw.detailImages || []).slice(0, detailCount),
      } : null,
      skuGroups: (raw.skuGroups || []).map(g => ({ name: g.name, values: g.values })),
      categoryText: raw.categoryText || '',
      location: s.template.location || raw.location || '',
      template: {
        shipTemplate: s.template.shipTemplate,
        returnAddress: s.template.returnAddress,
        sevenDayReturn: s.template.sevenDayReturn !== false,
        stock: s.template.stock || 99,
        delayHours: s.template.delayHours || 0,
      },
      warnings: [
        ...(riskWords.length ? [`标题含违禁词: ${riskWords.join('/')}`] : []),
        ...(cost == null ? ['未取到成本价，无法自动定价'] : []),
        ...(price == null && cost != null ? ['售价低于淘宝最低限价，已按配置跳过'] : []),
        ...(!title ? ['标题为空'] : []),
      ],
    };
  }

  /** 标题清洗：去1688语境词 + 极限词替换 + 截断 */
  cleanTitle(rawTitle) {
    const s = this.store.settings;
    let t = String(rawTitle || '');
    // 去1688典型词汇
    for (const w of s.title.removeWords || []) {
      t = t.split(w).join(' ');
    }
    // 极限词替换（广告法风险）
    for (const [from, to] of Object.entries(s.risk.replaceMap || {})) {
      t = t.split(from).join(to);
    }
    // 去违禁词（不替换直接删）
    for (const w of s.risk.blockWords || []) {
      t = t.split(w).join(' ');
    }
    // 清理多余空白和符号
    t = t.replace(/\s+/g, ' ').replace(/\s*([【\[（(])\s*/g, '$1').trim();
    t = t.replace(/^[^\u4e00-\u9fa5a-zA-Z0-9]+|[^\u4e00-\u9fa5a-zA-Z0-9!%）)】\]]+$/g, '');
    // 模板前后缀
    const tpl = s.title.template || '{title}';
    t = tpl.replace('{title}', t);
    const pre = (s.title.addPrefix || '').trim();
    const suf = (s.title.addSuffix || '').trim();
    if (pre) t = pre + ' ' + t;
    if (suf) t = t + ' ' + suf;
    // 淘宝标题 60字符（30汉字）限制，从尾部截断保留品牌词优先头部
    t = cutTitle(t, s.title.limit || 30);
    return t.trim();
  }

  /** 检测标题/详情违禁词 */
  findRiskWords(text) {
    const s = this.store.settings;
    const words = [...(s.risk.blockWords || [])];
    return words.filter(w => text && text.includes(w));
  }

  /** 计算售价。低于淘宝最低限价时按 floorAction 处理：raise=抬价 / skip=返回 null；无有效成本价返回 null（不瞎定价） */
  calcPrice(cost) {
    const p = this.store.settings.price || {};
    const c = Number(cost);
    if (!isFinite(c) || c <= 0) return null;   // 未采集到成本价时无法定价（避免算出0成本+保底利润的垃圾价）
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

    // 保底利润
    if (sell < c + (Number(p.minProfit) || 0)) sell = c + (Number(p.minProfit) || 0);

    // 尾数规则
    const rule = p.roundRule || 'yuan9';
    if (rule === 'yuan') sell = Math.ceil(sell);
    else if (rule === 'yuan9') sell = Math.floor(sell) + 0.9;
    else if (rule === 'mao9') sell = Math.floor(sell * 10) / 10 + 0.09;

    // 淘宝最低限价处理
    const floor = Number(p.floorPrice) || 2;
    if (sell < floor) {
      if (p.floorAction === 'skip') return null;   // 跳过该宝贝，由队列标记 skipped
      sell = floor;                                 // 抬到最低限价（不再做尾数处理）
    }

    return Math.max(0.01, Math.round(sell * 100) / 100);
  }

  /** 为整库商品批量刷新售价（价格策略调整后用） */
  recalcAll() {
    const goods = this.store.goods.filter(g => g.status === 'pending');
    const src = (this.store.settings.price || {}).source;
    let n = 0;
    for (const g of goods) {
      const cost = pickCost(g.raw || {}, src);
      if (cost != null) { g.sellPrice = this.calcPrice(cost); n++; }
    }
    this.store._debounceSave();
    return n;
  }
}

/** 取成本价。source: original=起批价（区间最低） | max=区间最高价 */
function pickCost(raw, source) {
  if (raw.price != null && isFinite(raw.price)) return Number(raw.price);
  if (raw.priceRange) {
    // 形如 "18.00~25.00" / "¥18.00 - ¥25.00"，提取全部数字
    const nums = String(raw.priceRange).match(/[0-9]+(?:\.[0-9]+)?/g) || [];
    if (!nums.length) return null;
    const vals = nums.map(Number).filter(v => isFinite(v) && v > 0);
    if (!vals.length) return null;
    if (source === 'max') return Math.max(...vals);
    return Math.min(...vals);
  }
  return null;
}

/** 数值截断到 [min,max]，非法（NaN/越界）用 fallback */
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** 标题截断到 limit 个"字"（汉字算1字，英文单词算1字） */
function cutTitle(t, limit) {
  if (!t) return t;
  let len = 0, out = '';
  for (const ch of t) {
    const isCJK = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch);
    len += isCJK ? 1 : 0.5;
    if (len > limit) return out.trim();
    out += ch;
  }
  return out.trim();
}

module.exports = Transform;
