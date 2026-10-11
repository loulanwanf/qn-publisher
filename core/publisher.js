/**
 * 千牛(淘宝卖家中心)发布自动化引擎
 * 入口: itemupload.taobao.com/sell/v2/publish.htm（卖家PC发布页）
 *
 * 流程步骤:
 *  1. 类目选择（关键词搜索 → 失败则用"最近使用类目"）
 *  2. 标题（React 受控填充）
 *  3. 主图上传（CDP DOM.setFileInputFiles，上传本地下载好的1688图）
 *  4. 价格 + 数量（一口价模式；SKU 模式为实验功能）
 *  5. 详情图上传（旺铺编辑器，逐张传，失败不阻断）
 *  6. 物流：运费模板选择
 *  7. 售后：7天无理由 + 退货地址
 *  8. 提交 / 调试模式暂停
 *
 * 全程多选择器 fallback + 每步快照存证 + 验证码检测(弹窗人工)
 */
const DOM = require('./dom');
const path = require('path');
const fs = require('fs');
const { Slider } = require('./slider');
const { TaoApi } = require('./taobao-api');

// 千牛2026新版发布入口（旧 itemupload.taobao.com 已废弃，会跳 noshop）
const PUBLISH_ENTRY_URL = 'https://upload.taobao.com/auction/sell.jhtml';
// 表单页（新版从入口选完类目后跳到这里，域名是 item.upload.taobao.com）
const FORM_URL_RE = /item\.upload\.taobao\.com\/sell\/v2\/publish\.htm/;
const WORKBENCH_URL = 'https://myseller.taobao.com';   // 千牛卖家工作台（后台）
const VERIFY_HINTS = ['拖动滑块', '请完成验证', '安全验证', '滑动验证'];   // 注意：不含"拼图/验证码"（普通文案易误判）

class Publisher {
  constructor({ accounts, store, logger, media }) {
    this.accounts = accounts;
    this.store = store;
    this.logger = logger;
    this.media = media;
  }

  async _shopWindow({ show = false } = {}) {
    const shop = this.store.accounts.find(a => a.type === 'shop');
    if (!shop) throw new Error('请先在「店铺管理」添加商家账号并扫码登录');
    const visibleMode = (this.store.settings.advanced || {}).windowMode === 'visible';
    const win = await this.accounts.getWorkWindow(shop, { show: show || visibleMode });
    return { shop, win };
  }

  /**
   * 发布一条商品
   * 两种模式：api=API直提（默认，移植黑鲸鱼方案）；dom=页面模拟（兼容保留）
   */
  async publish(goods, opts = {}) {
    const mode = ((this.store.settings.advanced || {}).publishMode) || 'api';
    if (mode === 'dom') return this._publishDom(goods, opts);
    try {
      return await this._publishApi(goods, opts);
    } catch (e) {
      // 过滤类跳过（店铺名/品牌词/违禁词等）：不降级、不重试，直接抛给队列标记 skipped
      if (e.skip) throw e;
      // API 模式失败且非登录/风控类错误 → 自动降级 DOM 模式重试一次
      if (!/登录|滑块|风控|权限|冻结|准入/.test(e.message || '')) {
        this.logger.warn('publish', `API模式失败(${e.message})，降级DOM模式重试`);
        try { return await this._publishDom(goods, opts); }
        catch (e2) { throw e2; }
      }
      throw e;
    }
  }

  /** ====================== 配置桥接层（黑鲸鱼 upset/imgset 控件 → 发布行为） ====================== */

  /**
   * 标题处理链（黑鲸鱼 TitleFilter/TitleClear/TitleReplaceKeyword/CustomTitle/Pre/Suffix 同款顺序）
   * @returns {string} 处理后标题
   */
  _applyTitleRules(rawTitle, offerId, up) {
    let t = String(rawTitle || '');
    // 0. 启用自定义过滤总开关（黑鲸鱼 cb_LocalDiyFilter：关闭时标题处理链整体不生效）
    if (!up || up.localDiyFilter === false) return t;
    // 1. 自定义标题映射（宝贝ID=新标题 或 标题=新标题，黑鲸鱼 CustomTitle 同款）
    const customMap = String(up.customTitle || '').split(/\r?\n/).map(x => x.trim()).filter(x => x.includes('='));
    for (const line of customMap) {
      const [key, ...rest] = line.split('=');
      const val = rest.join('=').trim();
      if (!val) continue;
      if (String(offerId) === key.trim() || t === key.trim() || t.includes(key.trim())) { t = val; break; }
    }
    // 2. 标题过滤词（含词直接删除，黑鲸鱼 TitleFilter）
    for (const w of String(up.titleFilter || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
      t = t.split(w).join(' ');
    }
    // 3. 标题清理词（同删除，独立词库）
    for (const w of String(up.titleClear || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
      t = t.split(w).join(' ');
    }
    // 4. 关键词替换（2020=2021 格式）
    for (const line of String(up.titleReplace || '').split(/\r?\n/).map(x => x.trim()).filter(x => x.includes('='))) {
      const [from, ...rest] = line.split('=');
      const to = rest.join('=');
      if (from) t = t.split(from).join(to);
    }
    // 5. 前后缀（多个用 | 分隔随机取一个，黑鲸鱼 TitlePreKeyword/TitleSuffixKeyword）
    //    截断时给后缀保留预算，确保后缀不被切掉
    const pickRand = (s) => { const arr = String(s || '').split('|').map(x => x.trim()).filter(Boolean); return arr.length ? arr[Math.floor(Math.random() * arr.length)] : ''; };
    const pre = pickRand(up.titlePre);
    const suf = pickRand(up.titleSuffix);
    // 6. 清理空白 + 30字截断（淘宝60字符限制）
    t = t.replace(/\s+/g, ' ').trim();
    let bodyBudget = 30 - ((pre ? pre.length + 1 : 0) + (suf ? suf.length + 1 : 0));
    if (bodyBudget < 10) bodyBudget = 10;
    let len = 0, out = '';
    for (const ch of t) {
      len += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.5;
      if (len > bodyBudget) break;
      out += ch;
    }
    t = out.trim() || t.slice(0, 60).trim();
    if (pre) t = pre + ' ' + t;
    if (suf) t = t + ' ' + suf;
    return t.trim();
  }

  /**
   * 价格计算链（黑鲸鱼 PriceDeal/PriceSource/AddNum/Multiplier1/DecimalMode 同款）
   * @param cost 成本价（按 priceSource 取）
   * @returns 售价（低于限价时按 chkPriceToOne 抬到 0.9 元起售规则，否则按保底）
   */
  _calcPriceWithCfg(cost, up) {
    let c = Number(cost) || 0;
    let sell = c;
    if (up.priceDeal) {
      // 价格方式（黑鲸鱼 cbb_Ysf1 原版语义：0=加百分比%+固定金额组合 1=仅加固定金额 2=仅乘倍率 3=指定统一价格）
      const mode = Number(up.ysf1) || 0;
      const mult = Number(up.multiplier) > 0 ? Number(up.multiplier) : 1;
      const add = Number(up.addNum) || 0;
      if (mode === 1) sell = c + add;
      else if (mode === 2) sell = c * mult;
      else if (mode === 3) sell = mult;               // multiplier 作为统一价
      else sell = c * mult + add;                      // 默认：倍率×成本+固定加价
      // 最低价SKU独立加价（黑鲸鱼 AddNumMin/minPriceSku：仅当该SKU是最低价时用另一套加价）
      if (up.minPrice && up.isMinPriceSku) {
        if (up.minPriceSku === 1) sell = c * (1 + (Number(up.addNumMin) || 0) / 100);
        else if (up.minPriceSku === 2) sell = c * (Number(up.addNumMin) > 0 ? Number(up.addNumMin) : 1);
        else sell = c + (Number(up.addNumMin) || 0);
      }
    }
    // 小数位处理 cbb_DecimalMode1（黑鲸鱼同款 6 档）
    switch (Number(up.decimalMode)) {
      case 0: sell = Math.round(sell); break;                       // 四舍五入到元
      case 1: sell = Math.round(sell / 10) * 10; break;             // 四舍五入到十位
      case 2: sell = Math.round(sell * 10) / 10; break;             // 保留1位
      case 3: sell = Math.round(sell * 100) / 100; break;           // 保留2位
      case 4: sell = Math.floor(sell) + 0.8; break;                 // 取整加0.8
      case 5: sell = Math.ceil(sell); break;                        // 向上取整
      default: sell = Math.floor(sell) + 0.9; break;                // 默认 x.9
    }
    // 淘宝最低限价保护
    if (sell < 2) sell = 2;
    return Math.max(0.01, Math.round(sell * 100) / 100);
  }

  /**
   * SKU 过滤（黑鲸鱼 FilterSkuPriceGt/Lt/NoStock/NoImg/FilterSkuWord/SkuNum 同款）
   * @returns 过滤后的 SKU 明细数组
   */
  _filterSkus(skuInfos, up) {
    let list = [...(skuInfos || [])];
    const gtOn = up.skuFilterPriceGt, gtMax = Number(up.skuFilterPriceMax) || 0;
    const ltOn = up.skuFilterPriceLt, ltMin = Number(up.skuFilterPriceMin) || 0;
    const noStock = up.skuFilterNoStock;
    const noImg = up.skuFilterNoImg;
    const words = String(up.filterSkuWord || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    list = list.filter(s => {
      const price = Number(s.price) || 0;
      if (gtOn && gtMax > 0 && price > gtMax) return false;
      if (ltOn && ltMin > 0 && price > 0 && price < ltMin) return false;
      if (noStock && (Number(s.stock) || 0) <= 0) return false;
      if (noImg && !s.image) return false;
      if (words.length && words.some(w => (s.values || []).some(v => String(v).includes(w)))) return false;
      return true;
    });
    // 数量上限（0=不限）
    const cap = Number(up.skuNum) || 0;
    if (cap > 0 && list.length > cap) list = list.slice(0, cap);
    return list;
  }

  /**
   * SKU 转换/合并（黑鲸鱼 ConvertToSku 移植）
   *  - sku1688（txt_1688sku，"规格=尺寸"）：1688 规格名重命名为淘宝规格名
   *  - skuMerge（txtSkuMerge，"规格=尺码+款式"）：把一个 1688 规格的值按分隔符拆成两个规格，
   *    skuInfos 的对应值同步拆分，重新组合
   * @returns {defs, infos, changed}
   */
  _transformSkuDefs(skuDefs, skuInfos, up) {
    let defs = skuDefs.map(d => ({ name: String(d.name || ''), values: (d.values || []).map(v => ({ ...v })) }));
    let infos = (skuInfos || []).map(s => ({ ...s, values: [...(s.values || [])] }));
    let changed = false;

    // 1. 规格重命名（规格=尺寸）
    const renames = String(up.sku1688 || '').split(/\r?\n/).map(x => x.trim()).filter(x => x.includes('='));
    if (renames.length) {
      for (const line of renames) {
        const [from, ...rest] = line.split('=');
        const to = rest.join('=').trim();
        if (!from.trim() || !to) continue;
        for (const d of defs) {
          if (d.name === from.trim()) { d.name = to; changed = true; }
        }
      }
    }

    // 2. 规格合并拆分（规格=尺码+款式：把"规格"的值"M码-黑色"拆成 尺码=M码 + 款式=黑色）
    const merges = String(up.skuMerge || '').split(/\r?\n/).map(x => x.trim()).filter(x => x.includes('=') && x.split('=').pop().includes('+'));
    if (merges.length) {
      for (const line of merges) {
        const [fromRaw, comboRaw] = line.split('=');
        const from = fromRaw.trim();
        const parts = comboRaw.trim().split('+').map(x => x.trim()).filter(Boolean);
        if (!from || parts.length !== 2) continue;
        const di = defs.findIndex(d => d.name === from);
        if (di < 0) continue;
        const srcDef = defs[di];
        // 拆值：尝试常见分隔符 - / 、 ， , 空格
        const splitVal = (text) => {
          const m = String(text).match(/^(.+?)[-–—/、，,\s](.+)$/);
          return m ? [m[1].trim(), m[2].trim()] : null;
        };
        const defA = { name: parts[0], values: [] };
        const defB = { name: parts[1], values: [] };
        const seenA = new Set(), seenB = new Set();
        let anySplit = false;
        for (const v of srcDef.values) {
          const sp = splitVal(v.name);
          if (sp) {
            anySplit = true;
            if (!seenA.has(sp[0])) { seenA.add(sp[0]); defA.values.push({ name: sp[0], imageUrl: '' }); }
            if (!seenB.has(sp[1])) { seenB.add(sp[1]); defB.values.push({ name: sp[1], imageUrl: '' }); }
          } else {
            // 拆不动的值两个规格都挂（兜底保组合不丢）
            if (!seenA.has(v.name)) { seenA.add(v.name); defA.values.push({ ...v }); }
            if (!seenB.has(v.name)) { seenB.add(v.name); defB.values.push({ name: '默认', imageUrl: '' }); }
          }
        }
        if (!anySplit || !defA.values.length || !defB.values.length) continue;
        defs.splice(di, 1, defA, defB);
        // skuInfos 同步拆值：原 values[i] 对应 from 规格的值拆成两个
        const fromIdx = skuDefs.findIndex(d => String(d.name || '') === from);
        infos = infos.map(info => {
          const vals = [...(info.values || [])];
          const raw = vals[fromIdx];
          if (raw == null) return info;
          const sp = splitVal(raw);
          vals.splice(fromIdx, 1, ...(sp || [raw, '默认']));
          return { ...info, values: vals };
        });
        changed = true;
      }
    }
    return { defs, infos, changed };
  }

  /**
   * 发布前过滤链（黑鲸鱼 IgnoreUid/IgnoreBrand/filterImg/FilterNoFreePost/DownItem + 违禁词拦截）
   * @returns null=通过；否则返回跳过原因
   */
  _prefilter(goods, up) {
    const raw = goods.raw || {};
    const title = String(goods.title || '');
    const lines = (s) => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    // 1. 过滤店铺名（黑鲸鱼 IgnoreUid：上家店铺名含词不上传）
    const shopName = String(raw.companyName || raw.sellerName || '').trim();
    for (const w of lines(up.ignoreUid)) {
      if (w && shopName.includes(w)) return `过滤店铺名【${shopName}】含关键词【${w}】`;
    }
    // 2. 品牌过滤词（黑鲸鱼 IgnoreBrand：标题含品牌词不上传）
    for (const w of lines(up.ignoreBrand)) {
      if (w && title.includes(w)) return `标题含品牌过滤词【${w}】`;
    }
    // 3. 过滤图片地址（黑鲸鱼 filterImg：主图URL含地址不上传）
    const mainImgs = (raw.mainImages || []).map(String);
    for (const w of lines(up.filterImg)) {
      if (w && mainImgs.some(u => u.includes(w))) return `主图含过滤地址【${w}】`;
    }
    // 4. 过滤不包邮商品（黑鲸鱼 chkFilterNoFreePost：需采集时抓到运费信息，老数据无字段则不拦截）
    if (up.filterNoFreePost && raw.freeShipping === false) return '1688商品不包邮';
    // 5. 过滤已下架商品（黑鲸鱼 chkDownItem：需采集时抓到下架状态，老数据无字段则不拦截）
    if (up.filterDownItem && raw.offSale === true) return '1688商品已下架';
    // 6. 违禁词拦截（本地词库 risk.blockWords，transform 链遗留闸门在此消费）
    const blockWords = (this.store.settings.risk && this.store.settings.risk.blockWords) || [];
    for (const w of blockWords) {
      if (w && title.includes(w)) return `标题含违禁词【${w}】`;
    }
    return null;
  }

  /**
   * 属性处理链（黑鲸鱼 props/propsChange/propsLack/propsReplace/propsFilter/propsClear）
   * @param attrs 1688 原属性（可被 propsChange 改键名）
   * @param catProps mapProps 输出 [{name,value}]
   * @returns {attrs, catProps, block}：block 非空=属性过滤命中，跳过宝贝
   */
  _applyPropRules(attrs, catProps, pageData, up) {
    const attrs2 = { ...(attrs || {}) };
    const lines = (s) => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    // 1. 属性转换（黑鲸鱼 propsChange：书号=型号，1688属性名映射到淘宝属性名）
    for (const line of lines(up.propsChange)) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (!m) continue;
      const from = m[1].trim(), to = m[2].trim();
      if (attrs2[from] != null && attrs2[from] !== '') {
        attrs2[to] = attrs2[from];
        delete attrs2[from];
      }
    }
    // 2. 属性过滤词（黑鲸鱼 propsFilter：1688属性值含词 → 不上传该宝贝）
    const pfWords = lines(up.propsFilter);
    if (pfWords.length) {
      for (const [k, v] of Object.entries(attrs2)) {
        const val = String(v);
        if (pfWords.some(w => val.includes(w))) return { attrs: attrs2, catProps, block: `属性【${k}=${val}】含过滤词` };
      }
    }
    let props = catProps.map(p => ({ ...p }));
    const valText = (v) => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map(x => x.text || '').join(',');
      return String(v.text != null ? v.text : v);
    };
    const labelOf = (name) => {
      const p = (pageData.props || []).find(x => x.name === name);
      return p ? p.label : name;
    };
    // 3. 属性替换词（黑鲸鱼 propsReplace：属性值文本 a=b）
    for (const line of String(up.propsReplace || '').split(/[,，\n]/).map(x => x.trim()).filter(x => x.includes('='))) {
      const [f, ...r] = line.split('=');
      const to = r.join('=').trim();
      for (const p of props) {
        if (typeof p.value === 'string') p.value = p.value.split(f.trim()).join(to);
        else if (p.value && typeof p.value === 'object' && !Array.isArray(p.value) && p.value.text) p.value.text = p.value.text.split(f.trim()).join(to);
        else if (Array.isArray(p.value)) p.value.forEach(v => { if (v && v.text) v.text = v.text.split(f.trim()).join(to); });
      }
    }
    // 4. 属性清除词（黑鲸鱼 propsClear：从属性值中删除关键词）
    for (const w of lines(up.propsClear)) {
      for (const p of props) {
        if (typeof p.value === 'string') p.value = p.value.split(w).join('');
        else if (p.value && typeof p.value === 'object' && !Array.isArray(p.value) && p.value.text) p.value.text = p.value.text.split(w).join('');
        else if (Array.isArray(p.value)) p.value.forEach(v => { if (v && v.text) v.text = v.text.split(w).join(''); });
      }
    }
    // 5. 缺少属性（黑鲸鱼 propsLack：淘宝必填而上家没有的，从"属性=值"列表补；只添加缺失的）
    const lackPairs = {};
    for (const line of lines(up.propsLack)) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (m) lackPairs[m[1].trim()] = m[2].trim();
    }
    const has = new Set(props.map(p => labelOf(p.name)));
    for (const p of (pageData.props || [])) {
      if (!p.required || !p.name || !p.dataSource || !p.dataSource.length) continue;
      if (has.has(p.label)) continue;
      if (lackPairs[p.label] != null) {
        const v = lackPairs[p.label];
        const hit = p.dataSource.find(d => d.text === v) || p.dataSource.find(d => d.text && (d.text.includes(v) || v.includes(d.text)));
        props.push({ name: p.name, value: hit ? { text: hit.text, value: hit.value } : (p.uiType === 'input' ? v : { text: v, value: v }) });
      }
    }
    // 6. 自定义宝贝属性（黑鲸鱼 props：型号=001，直接覆盖/添加）
    for (const line of lines(up.props)) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (!m) continue;
      const label = m[1].trim(), v = m[2].trim();
      const def = (pageData.props || []).find(x => x.label === label);
      if (!def || !def.name) continue;
      const hit = (def.dataSource || []).find(d => d.text === v) || (def.dataSource || []).find(d => d.text && (d.text.includes(v) || v.includes(d.text)));
      const val = def.uiType === 'input' ? v : (hit ? { text: hit.text, value: hit.value } : { text: v, value: v });
      const idx = props.findIndex(p => p.name === def.name);
      if (idx >= 0) props[idx] = { name: def.name, value: val };
      else props.push({ name: def.name, value: val });
    }
    return { attrs: attrs2, catProps: props, block: null };
  }

  /** ====================== API 直提模式（黑鲸鱼方案） ====================== */
  async _publishApi(goods, opts = {}) {
    const { shop, win } = await this._shopWindow({ show: opts.debug || false });
    const t0 = Date.now();
    const stepNames = { '登录检查': 5, '类目': 15, '主图': 35, '详情图': 60, '属性': 72, '提交': 92, '完成': 100 };
    const stepPct = (m) => { for (const [k, v] of Object.entries(stepNames)) if (m.includes(k)) return v; return null; };
    const log = (m, d) => {
      this.logger.info('publish', `[${goods.offerId}] ${m}`, d);
      const pct = stepPct(m);
      if (pct != null && this.onProgress) {
        this.onProgress({ key: 'publish-' + goods.offerId, title: `上架: ${(goods.title || goods.offerId).slice(0, 16)}`, detail: `${m}（${Math.round((Date.now() - t0) / 1000)}s）`, percent: pct });
      }
    };
    const steps = [];

    // 1. 登录检查 + API 初始化（加载 chuangyi 抓 token，黑鲸鱼机制）
    log('登录检查…');
    const curUrl = win.webContents.getURL();
    if (!/taobao\.com|tmall\.com/.test(curUrl)) {
      await win.loadURL(WORKBENCH_URL);
      await DOM.waitLoadStop(win.webContents, 30000);
      if (/login\.taobao\.com/.test(win.webContents.getURL())) {
        throw new Error('商家账号登录态失效，请到「店铺管理」重新扫码登录');
      }
    }
    const api = new TaoApi(win.webContents.session, win);
    try {
      await api.init();
      log('素材中心就绪');
    } catch (e) {
      // 素材中心是兜底通道（主通道=图片空间直传），token 失败不终止发布
      // 真登录态失效会在后续淘宝接口调用中暴露（queue 按错误文本终止）
      log(`素材中心Token获取失败(降级走图片空间直传): ${e.message}`);
    }

    // 配置提前定义（后续所有环节使用）
    const up = this.store.settings.upset || {};
    // 商家编码配置（advanced.merchantCode：offerId=用1688宝贝ID | none=不添加）
    up.merchantCode = (this.store.settings.advanced || {}).merchantCode || 'offerId';
    const imgCfg = this.store.settings.imgset || {};
    // 图片空间文件夹名（黑鲸鱼 PicDirName：按名查/建目录，上传归档）
    api.picDirName = String(imgCfg.picDir || '').trim();

    // 1.5 发布前过滤链（黑鲸鱼过滤店铺名/品牌词/图片地址/不包邮/已下架 + 违禁词拦截）
    const skipReason = this._prefilter(goods, up);
    if (skipReason) {
      const e = new Error(skipReason);
      e.skip = true;
      throw e;
    }
    log('过滤检查通过');

    // 1.6 1688 分销发布页预热（黑鲸鱼 GetPubData：发布前建立淘宝侧 1688 分销渠道上下文）
    if (up.relation !== false) {
      try { await this._preheat1688Publish(goods, win.webContents.session, log); } catch (e) { /* 预热失败不影响发布 */ }
    }

    // 2. 类目（与 DOM 路径同一套配置：upset.categoryMode=self→统一类目词 / default→复制1688原宝贝类目）
    log('类目匹配…');
    let catKeyword = '';
    if (up.categoryMode === 'self') {
      catKeyword = up.categoryKey || '';
    } else {
      const segs = String((goods.raw && goods.raw.categoryText) || '')
        .split('>').map(s => s.trim()).filter(Boolean);
      catKeyword = segs[segs.length - 1] || up.categoryKey || '';
    }
    if (!catKeyword) throw new Error('未配置类目关键词（上传设置→类目→关键词找类目）');
    let catId = this._catMap ? this._catMap.get(catKeyword) : null;
    if (!catId) {
      const cats = await api.categorySearch(catKeyword);
      if (!cats.length) throw new Error(`类目搜索无结果: ${catKeyword}`);
      catId = String(cats[0].catId);
      this._catMap = this._catMap || new Map();
      this._catMap.set(catKeyword, catId);
      log(`类目匹配: ${cats[0].name} (${catId})`);
    } else {
      log(`类目匹配(缓存): ${catKeyword} → ${catId}`);
    }
    steps.push({ step: 'category', ok: true, note: catKeyword + '→' + catId });

    // 3. 图片上传（主图 → 图片空间；主图转1:1正方形，黑鲸鱼 VerSquareImage800 同款）
    const imgs = this.media.localPaths(goods.offerId);
    if (!imgs.main || !imgs.main.length) throw new Error('本地无主图缓存，请重新采集');
    const sqSize = parseInt(imgCfg.sqImg || '800', 10) || 800;
    const waterText = imgCfg.water === '1' ? String(imgCfg.waterText || '').trim() : '';
    log(`主图上传 ${Math.min(imgs.main.length, 5)}张…`);
    const mainUrls = [];
    let pics = imgs.main.slice(0, 5);
    // 主图来源（黑鲸鱼 MainImg：1=主图+详情首图 2=详情图）；主图打乱 randImg
    if (+up.mainImgSource === 1 && imgs.detail && imgs.detail.length) pics = pics.slice(0, 4).concat([imgs.detail[0]]);
    else if (+up.mainImgSource === 2 && imgs.detail && imgs.detail.length) pics = imgs.detail.slice(0, 5);
    if (imgCfg.randImg) { for (let i = pics.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pics[i], pics[j]] = [pics[j], pics[i]]; } }
    for (let i = 0; i < pics.length; i++) {
      let pic = pics[i];
      // 1:1 处理（黑鲸 VerSquareImage800：3:4 等原图转白底正方形，避免 CHK_IMAGE_NOT_ALLOW_RATIO）
      // bqQsImg 开关化（黑鲸鱼 chkBqQsImg：仅开启时转方图）
      if (imgCfg.bqQsImg !== false) pic = await api.toSquareImage(pic, sqSize);
      // 主图翻转（黑鲸鱼 ItemCopyAutoDeal）
      if (imgCfg.mainFlip) pic = await api.flipImage(pic);
      // 文字水印（黑鲸鱼 ImageWater 同款，右下角半透明）
      if (waterText) pic = await api.addWatermark(pic, waterText);
      // 压缩（黑鲸鱼 IsCompress + CompressRate）
      if (imgCfg.compress) pic = await api.compressImage(pic, imgCfg.compressRate);
      // 文件名加上家ID（黑鲸鱼 chkFileNameAddId）
      const upName = imgCfg.fileNameAddId
        ? `${goods.offerId}_${path.basename(pic)}`
        : path.basename(pic);
      const r = await api.uploadImage(pic, upName);
      mainUrls.push(r.url);
      log(`主图 ${mainUrls.length}/${pics.length}`);
      // 上传间隔（黑鲸鱼 UploadIntervalPic：用户配置秒数优先；0=默认 1.2~2s 防风控基础间隔）
      if (i < pics.length - 1) {
        const cfgSec = Math.max(0, Number(up.intervalPic) || 0);
        const waitMs = cfgSec > 0 ? cfgSec * 1000 : (1200 + Math.random() * 800);
        await new Promise(r2 => setTimeout(r2, waitMs));
      }
    }
    steps.push({ step: 'mainImages', ok: true, note: `${mainUrls.length}张` });

    // 3.6 主图视频（黑鲸鱼 IsUploadVideo → SaveItemVideo → VideoApi1.Upload 同款链路：init→分片PUT→complete→publish）
    let videoObj = null;
    if (imgCfg.uploadVideo && goods.raw && goods.raw.video) {
      try {
        log('主图视频处理…');
        const localVideo = await this.media.downloadVideo(goods.offerId, goods.raw.video);
        if (localVideo) {
          // 封面兜底：AI 封面失败时用第一张已上传主图（比黑鲸鱼更稳）
          videoObj = await api.uploadVideoItem(localVideo, goods.offerId, mainUrls[0] || '');
          if (videoObj && videoObj.videoId) log(`视频上传成功: ${videoObj.videoId}`);
          else videoObj = null;
        } else {
          log('视频下载失败(跳过)');
        }
      } catch (e) { videoObj = null; log(`视频上传失败(跳过): ${e.message}`); }
    }
    steps.push({ step: 'video', ok: true, note: videoObj ? `videoId=${videoObj.videoId}` : '无' });

    // 3.5 3:4 竖图（黑鲸鱼 IsCreateVerImg：第一张主图转 800x1200，verticalImage:[{url}]）
    let verticalUrl = '';
    if ((this.store.settings.imgset || {}).verImg) {
      try {
        const vf = await api.toVerticalImage(pics[0]);
        if (vf) {
          const vr = await api.uploadImage(vf);
          verticalUrl = vr.url;
          log('3:4竖图上传成功');
        }
      } catch (e) { log(`3:4竖图失败(跳过): ${e.message}`); }
    }

    // 4. 详情图（长图模式 wirelessDesc）— 数量/首尾处理按 imgset 配置（黑鲸鱼 DetailItemCopyNum/RemoveDescImgA/B/MainaddDesc 同款）
    let detailUrls = [];
    if (imgs.detail && imgs.detail.length) {
      // 详情图序列处理：移除前N张/后N张；主图追加到详情首
      let dSeq = [...imgs.detail];
      const rmA = Number(imgCfg.removeA_) || 0;
      const rmB = Number(imgCfg.removeB_) || 0;
      if (rmA > 0) dSeq = dSeq.slice(rmA);
      if (rmB > 0 && dSeq.length > rmB) dSeq = dSeq.slice(0, dSeq.length - rmB);
      if (imgCfg.mainAddDesc && pics && pics.length) dSeq = [...pics, ...dSeq];
      const n = Math.min(dSeq.length, Number(imgCfg.keepImgs) || 20);
      log(`详情图上传 ${n}张…`);
      let dPics = dSeq.slice(0, n);
      // 上传列表（长图模式先拼一张，失败可回退逐张）
      let uploadList = dPics;
      let mergedUsed = false;
      // 拼接详情页（黑鲸鱼 chkMegerImage：全部详情图垂直拼接成一张长图）
      if (imgCfg.mergeImg && dPics.length > 1) {
        try {
          const merged = await api.megerImages(dPics);
          if (merged) { uploadList = [merged]; mergedUsed = true; log('详情图已拼接为长图'); }
        } catch (e) { log(`长图拼接失败(退回逐张): ${e.message}`); }
      }
      const uploadOne = async (dp) => {
        // 详情图翻转（黑鲸鱼 ItemCopyAutoDealDesc）
        if (imgCfg.descFlip) dp = await api.flipImage(dp);
        if (waterText) dp = await api.addWatermark(dp, waterText);
        // 压缩
        if (imgCfg.compress) dp = await api.compressImage(dp, imgCfg.compressRate);
        const r = await api.uploadImage(dp, imgCfg.fileNameAddId ? `${goods.offerId}_${path.basename(dp)}` : undefined);
        detailUrls.push(r.url);
        log(`详情图 ${detailUrls.length}/${uploadList.length + (mergedUsed ? dPics.length : 0)}`);
      };
      for (let i = 0; i < uploadList.length; i++) {
        try {
          await uploadOne(uploadList[i]);
        } catch (e) { log(`详情图单张失败(跳过): ${e.message}`); }
        if (i < uploadList.length - 1) await new Promise(r2 => setTimeout(r2, 1200 + Math.random() * 800));
      }
      // 长图上传失败（0张）→ 回退逐张全量上传（长图体积/像素超限是主因，逐张走图片空间直传更稳）
      if (!detailUrls.length && mergedUsed && dPics.length) {
        log(`长图上传失败，回退逐张上传 ${dPics.length}张…`);
        for (let i = 0; i < dPics.length; i++) {
          try { await uploadOne(dPics[i]); } catch (e) { log(`详情图单张失败(跳过): ${e.message}`); }
          if (i < dPics.length - 1) await new Promise(r2 => setTimeout(r2, 1200 + Math.random() * 800));
        }
      }
      // 自定义详情首尾图（黑鲸鱼 headImg/buttomImg：上传后插入详情首/尾）
      try {
        for (const [which, cfgVal, pos] of [['head', imgCfg.headImg, 'unshift'], ['buttom', imgCfg.buttomImg, 'push']]) {
          const v = String(cfgVal || '').trim();
          if (!v) continue;
          let local = '';
          if (/^https?:\/\//i.test(v)) local = (await this.media.downloadImages(goods.offerId, 'detail', [v]))[0] || '';
          else if (fs.existsSync(v)) local = v;
          if (!local) { log(`自定义详情${which === 'head' ? '首' : '尾'}图不可用(跳过)`); continue; }
          const r = await api.uploadImage(local);
          if (pos === 'unshift') detailUrls.unshift(r.url); else detailUrls.push(r.url);
          log(`自定义详情${which === 'head' ? '首' : '尾'}图已上传`);
        }
      } catch (e) { log(`自定义详情首尾图失败(跳过): ${e.message}`); }
      steps.push({ step: 'detailImages', ok: detailUrls.length > 0, note: `${detailUrls.length}张` });
    } else {
      steps.push({ step: 'detailImages', ok: false, note: '无本地详情图' });
    }

    // 5. 属性定义 + 1688属性映射 + 属性处理链（黑鲸鱼 props/propsChange/propsLack/propsReplace/propsFilter/propsClear）
    log('属性定义获取…');
    const pageData = await api.getPublishPageData(catId);
    log(`属性定义 ${pageData.props.length}项`);
    const attrsRaw = (goods.raw && goods.raw.attributes) || {};
    let catProps = TaoApi.mapProps(attrsRaw, pageData.props);
    const propRes = this._applyPropRules(attrsRaw, catProps, pageData, up);
    if (propRes.block) {
      const e = new Error('属性过滤：' + propRes.block);
      e.skip = true;
      throw e;
    }
    catProps = propRes.catProps;
    steps.push({ step: 'props', ok: true, note: `${catProps.length}/${pageData.props.filter(p => p.required).length}必填` });
    // 6. 品牌查询（黑鲸鱼同款：默认改“其他”；UI 指定品牌/无品牌时按配置）
    let brandId = '', brandName = '';
    try {
      const brandKw = (up.brandOther || up.brandNoBrand) ? '其他' : (String(up.brand || '').trim() || '其他');
      const brands = await api.brandQuery(catId, brandKw);
      if (brands.length) { brandId = String(brands[0].id); brandName = brands[0].name; }
    } catch (_) {}

    // 7. 运费模板：优先用「店铺管理」已同步的 sellerInfo（含真实ID，免每品刷新发布页）；
    //    sellerInfo 无匹配时才 refreshTemplates 兜底（会话缓存，黑鲸鱼 GlobalData 模式）
    let shipTemplate = '';
    const cfgTpl = this.store.settings.template.shipTemplate;
    if (cfgTpl && /^\d+$/.test(String(cfgTpl).trim())) {
      shipTemplate = String(cfgTpl).trim();
    } else {
      try {
        // 7a. sellerInfo 同步数据优先（名称→ID，黑鲸鱼 GlobalData.ShipTemplate 同款）
        const synced = (this.store.sellerInfo && this.store.sellerInfo.shipTemplates) || [];
        let hit = null;
        if (synced.length) {
          hit = cfgTpl
            ? synced.find(t => (t && t.name) === cfgTpl || (t && t.name && t.name.includes(cfgTpl)) || (typeof t === 'string' && t === cfgTpl))
            : (synced.find(t => t && t.id) || null);
          if (hit) shipTemplate = String((hit.id != null && hit.id !== '') ? hit.id : (typeof hit === 'string' ? '' : ''));
        }
        // 7b. sellerInfo 无匹配 → refreshTemplates 接口兜底（会话缓存）
        if (!shipTemplate) {
          if (!this._tplCache) this._tplCache = {};
          let tpls = this._tplCache.list;
          if (!tpls) {
            tpls = await api.refreshTemplates(catId);
            if (tpls && tpls.length) this._tplCache.list = tpls;
          }
          // 7b-2. asyncOpt API 被风控 → DOM 兜底：从发布页下拉读编辑链接 templateId
          if (!tpls || !tpls.length) {
            log('asyncOpt API 被风控，DOM 提取模板 ID…');
            const domTpls = await DOM.evalInPage(win.webContents, `
              const out = [];
              const blocks = [...document.querySelectorAll('[class*="child-block"], [class*="logis-block"]')].filter(b => (b.innerText || '').includes('运费模板'));
              const shipBlock = blocks.find(b => b.querySelector('a[href*="templateId"]')) || blocks[0];
              if (!shipBlock) return JSON.stringify([]);
              const getTplId = () => {
                const a = shipBlock.querySelector('a[href*="templateId"]');
                if (!a) return '';
                const m = (a.href || '').match(/templateId=([0-9]+)/) || (a.getAttribute('href') || '').match(/templateId=([0-9]+)/);
                return m ? m[1] : '';
              };
              const currentName = (shipBlock.querySelector('em') || {}).textContent || '';
              const currentId = getTplId();
              if (currentName && currentId) out.push({ name: currentName, id: currentId });
              const input = shipBlock.querySelector('input[role="combobox"]');
              if (input) {
                input.click();
                await new Promise(r => setTimeout(r, 1500));
                const opts = [...document.querySelectorAll('.next-select-menu .next-menu-item[role="option"]')].filter(el => el.offsetParent !== null);
                const optNames = opts.map(o => (o.querySelector('.next-menu-item-text') || o).textContent.trim());
                for (let i = 0; i < opts.length; i++) {
                  const name = optNames[i];
                  if (name === currentName) continue;
                  opts[i].click();
                  await new Promise(r => setTimeout(r, 1000));
                  const tplId = getTplId();
                  if (name && tplId) out.push({ name, id: tplId });
                }
                const orig = opts.find((o, i) => optNames[i] === currentName);
                if (orig) { orig.click(); await new Promise(r => setTimeout(r, 500)); }
                document.body.click();
              }
              return JSON.stringify(out);
            `).catch(() => '[]');
            tpls = JSON.parse(domTpls || '[]');
            if (tpls && tpls.length) this._tplCache.list = tpls;
          }
          const match = cfgTpl ? tpls.find(t => t.name === cfgTpl || t.name.includes(cfgTpl)) : null;
          shipTemplate = String((match || (tpls && tpls[0]) || {}).id || this._tplCache.last || '');
          if (shipTemplate) this._tplCache.last = shipTemplate;
          if (!shipTemplate) throw new Error('未获取到运费模板（请到「店铺管理」同步运费模板，或检查商家登录态）');
          log(`运费模板(刷新): ${shipTemplate}${match ? `(匹配“${cfgTpl}”)` : ''}（共${tpls.length}个）`);
        } else {
          log(`运费模板(已同步): ${shipTemplate}`);
        }
      } catch (e) {
        if (this._tplCache && this._tplCache.last) {
          shipTemplate = this._tplCache.last;
          log(`运费模板获取失败(${e.message})，用上次成功模板兜底: ${shipTemplate}`);
        } else {
          throw new Error('运费模板获取失败：' + e.message);
        }
      }
    }

    // 8. 构造 UpItem
    // 标题处理链（黑鲸鱼 TitleFilter/Clear/Replace/CustomTitle/Pre/Suffix → 30字截断）
    // 重复标题过滤（cbk_filter_title：与已发布重复时自动追加随机后缀）
    let titleRaw = this._applyTitleRules(goods.title || '', goods.offerId, up);
    if (up.filterTitle) {
      const publishedTitles = this.store.goods
        .filter(g => g.status === 'published' && g.offerId !== goods.offerId)
      .map(g => (this._applyTitleRules(g.publishTitle || g.title || '', g.offerId, up)));
      if (publishedTitles.includes(titleRaw)) {
        const suf = String(Math.floor(Math.random() * 9000) + 1000);
        titleRaw = titleRaw.slice(0, 26) + suf;
        log(`标题与已发布重复，自动追加后缀: ${suf}`);
      }
    }
    let title = titleRaw;
    // 标题自动重组（黑鲸鱼 cb_Title/TitleRandom：分词洗牌重排；分词接口失败则保持原序）
    if (up.titleRebuild) {
      const words = await api.getSplitWord(title);
      if (words && words.length > 1) {
        const arr = [...words];
        const out = [];
        while (arr.length) out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
        let rebuilt = out.join(' ').replace(/\s+/g, '').trim();
        if (rebuilt && rebuilt !== title) {
          title = rebuilt.slice(0, 60);
          log(`标题自动重组: ${title.slice(0, 24)}`);
        }
      } else {
        log('分词服务不可用，标题保持原序');
      }
    }
    // 标题翻译成英文（黑鲸鱼 chkTranslateTitle：百度翻译；失败返回原标题）
    if (up.translateTitle) {
      const en = await api.translateTitle(title);
      if (en && en !== title) { title = en.slice(0, 60); log('标题已翻译为英文'); }
    }
    // 详情隐藏链接（黑鲸鱼 cbb_HideLink：1=白字链接 2=白字宝贝ID；two2one 二合1时链接指向1688详情页）
    let descHtml = detailUrls.map(u => `<img src="${u}">`).join('');
    const hideMode = Number(imgCfg.hideLink) || 0;
    if (hideMode === 1 || up.two2one || hideMode === 2) {
      const aliUrl = `https://detail.1688.com/offer/${goods.offerId}.html`;
      const hidden = (hideMode === 2)
        ? `<div style="color:#fff">${goods.offerId}</div>`
        : `<a href="${aliUrl}" target="_blank" style="color:#fff">Link</a>`;
      descHtml = hidden + descHtml;
      log(`详情隐藏链接已插入(模式${hideMode === 2 ? '2' : '1'})`);
    }
    // PC/无线详情差异化（黑鲸鱼 NoPcDesc/UseWlDesc/NoWlDesc：无线用长图，PC可关）
    const descPc = imgCfg.noPcDesc ? '' : descHtml;
    const descWl = (imgCfg.noWlDesc || imgCfg.useWlDesc === false) ? '' : descHtml;
    // 8.5 SKU 多规格（1688 skuDefs+skus → 淘宝 saleProp+sku，黑鲸鱼 GetSaleCat 复刻）
    // SKU 过滤（黑鲸鱼 FilterSkuPriceGt/Lt/NoStock/NoImg/FilterSkuWord/SkuNum）
    let saleProp = {};
    let skuList = [];
    let skuMinPrice = null;
    let skuDefsRaw = (goods.raw && goods.raw.skuDefs) || [];
    const skuInfosAll = (goods.raw && goods.raw.skus) || [];
    const skuInfos = this._filterSkus(skuInfosAll, up);
    if (skuInfosAll.length && skuInfos.length < skuInfosAll.length) {
      log(`SKU过滤: ${skuInfosAll.length} → ${skuInfos.length} 组合`);
    }
    // SKU 转换/合并（黑鲸鱼 ConvertToSku：txt_1688sku 重命名 / txtSkuMerge 合并拆分）
    let skuInfosForBuild = skuInfos;
    const { defs: defsT, infos: infosT, changed } = this._transformSkuDefs(skuDefsRaw, skuInfos, up);
    let skuDefs = defsT;
    if (changed) { skuInfosForBuild = infosT; log('SKU转换/合并已应用'); }
    // SKU 图片上传（黑鲸鱼 IniSkuImg：颜色值图 → 素材中心 → saleProp 值挂 imageUrl）
    if (imgCfg.uploadSkuImg && skuDefs.length) {
      let skuImgCount = 0;
      for (const def of skuDefs) {
        for (const v of (def.values || [])) {
          if (!v.imageUrl || v.uploadedUrl) continue;
          try {
            const local = (await this.media.downloadImages(goods.offerId, 'sku', [v.imageUrl]))[0];
            if (!local) continue;
            let img = local;
            if (imgCfg.skuSq800) img = await api.toSquareImage(img, 800); // SKU图改800x800
            if (imgCfg.skuImgDeal) img = await api.flipImage(img);         // SKU图翻转
            const r = await api.uploadImage(img);
            if (r && r.url) { v.imageUrl = r.url; v.uploadedUrl = true; skuImgCount++; }
            await new Promise(r2 => setTimeout(r2, 800 + Math.random() * 600));
          } catch (e) { log(`SKU图上传失败(跳过): ${e.message}`); }
        }
      }
      if (skuImgCount) log(`SKU图上传 ${skuImgCount} 张`);
    }
    // SKU 值替换词/随机字符（黑鲸鱼 SkuReplaceWord/SkuRandomWord）
    const skuReplacePairs = String(up.skuReplaceWord || '').split(/[,，]/).map(x => x.trim()).filter(x => x.includes('='));
    const skuRandomWord = String(up.skuRandomWord || '').trim();
    const valueTransform = (skuReplacePairs.length || skuRandomWord)
      ? (text) => {
        let t = String(text);
        for (const p of skuReplacePairs) { const [f, ...r] = p.split('='); if (f) t = t.split(f.trim()).join(r.join('=').trim()); }
        if (skuRandomWord) t = t + skuRandomWord + Math.floor(Math.random() * 900 + 100);
        return t;
      }
      : null;
    if (skuDefs.length && skuInfosForBuild.length && (pageData.saleFields || []).length) {
      // SKU 价格走黑鲸鱼价格链（PriceDeal/倍率/加价/小数位；最低价SKU独立加价 + 增加库存）
      const minSkuPrice = skuInfosForBuild.length ? Math.min(...skuInfosForBuild.map(s => Number(s.price) || Infinity)) : Infinity;
      const skuPriceFn = (c) => this._calcPriceWithCfg(c, { ...up, isMinPriceSku: up.minPrice && Number(c) <= minSkuPrice });
      const stockBase = Number(this.store.settings.template.stock) || 99;
      const minSkuKc = Number(up.minSkuKc) || 0; // 最低价SKU增加库存
      const skuStockFn = (c) => (up.minPrice && Number(c) <= minSkuPrice && minSkuKc > 0) ? String(stockBase + minSkuKc) : String(stockBase);
      const r = TaoApi.buildSku(skuDefs, skuInfosForBuild, pageData.saleFields,
        skuPriceFn, { stock: stockBase, fallbackCost: (goods.raw && goods.raw.price) || goods.sellPrice || 0, specSkuMap: pageData.specSkuMap || {}, valueTransform,
          addSku: { addNoSku: !!up.addNoSku, addNoSku1: !!up.addNoSku1, addSkuText: up.addSku || '' } });
      if (up.addNoSku || up.addNoSku1) log(`缺失SKU补齐已启用（自定义规则${String(up.addSku || '').split(/\r?\n/).filter(x => x.includes('=')).length}条）`);
      // 最低价SKU增加库存（黑鲸鱼 minskukc：发布后改库存不便，直接在组合上叠加）
      if (up.minPrice && minSkuKc > 0) {
        for (const s of r.sku) {
          if (Number(s.skuPrice) <= minSkuPrice) s.skuStock = String(stockBase + minSkuKc);
        }
      }
      void skuStockFn;
      saleProp = r.saleProp; skuList = r.sku; skuMinPrice = r.price;
      log(`SKU规格: ${Object.keys(saleProp).map(k => `${Array.isArray(saleProp[k]) ? saleProp[k].length : ((saleProp[k] && saleProp[k].value) || []).length}值`).join('/')} 共${skuList.length}组合`);
      // 8.5.5 SKU 参数（2026新版 skuParam_*：适用体型等后台"SKU参数面板"必填校验用）
      // required 的（如适用体型）必填第一个候选值防报错；非必填优先从 1688 属性匹配（图案=纯色），匹配不上留空
      const skuParams = pageData.skuParams || [];
      if (skuParams.length && skuList.length) {
        const attrs1688 = attrsRaw || {};
        for (const s of skuList) {
          for (const sp of skuParams) {
            if (s[sp.key]) continue;
            let v = null;
            const src = attrs1688[sp.label] || attrs1688[String(sp.label).replace(/^适用/, '')];
            if (src && (sp.dataSource || []).length) {
              const hit = sp.dataSource.find(d => d.text === src) || sp.dataSource.find(d => d.text && (d.text.includes(src) || src.includes(d.text)));
              if (hit) v = hit;
            }
            if (!v && sp.required && (sp.dataSource || []).length) v = sp.dataSource[0];
            if (v) s[sp.key] = { text: String(v.text), value: String(v.value) };
          }
        }
        const filled = skuParams.filter(p => skuList[0] && skuList[0][p.key]).map(p => p.label).join('/');
        if (filled) log(`SKU参数已填充: ${filled}`);
      }
    } else if (skuDefs.length && !skuInfosForBuild.length) {
      log('有规格定义但无SKU明细（或全部被过滤），一口价模式');
    }
    // 一口价价格（无SKU时）：priceDeal 开启走黑鲸鱼价格链（priceSource 取成本），否则沿用既有售价
    let finalPrice = skuMinPrice;
    if (finalPrice == null) {
      if (up.priceDeal) {
        const skuPrices = (skuInfos.length ? skuInfos : skuInfosAll).map(s => Number(s.price)).filter(v => isFinite(v) && v > 0);
        const cost = (+up.priceSource === 1 && skuPrices.length) ? Math.min(...skuPrices)
          : (isFinite(Number(goods.raw && goods.raw.price)) && Number(goods.raw && goods.raw.price) > 0 ? Number(goods.raw.price) : goods.sellPrice);
        finalPrice = this._calcPriceWithCfg(cost, up);
      } else {
        finalPrice = goods.sellPrice != null ? goods.sellPrice : goods.price;
      }
    }
    // 上传方式（黑鲸鱼 cbb_UploadWay：0=立即上架 1=定时上架 2=放入仓库；UI 存 advanced.uploadMode）
    const uploadMode = (this.store.settings.advanced || {}).uploadMode || this.store.settings.template.uploadMode || 'warehouse';
    const warehouse = uploadMode === 'warehouse' || (uploadMode !== 'shelf' && uploadMode !== 'timed' && +up.uploadWay === 2);
    const putawayTime = (uploadMode === 'timed' && up.putawayTime)
      ? (String(up.putawayTime).replace('T', ' ') + (String(up.putawayTime).length === 16 ? ':00' : ''))
      : null;
    // 随机货号（黑鲸鱼 chkRadHh）与商家编码（黑鲸鱼：上家宝贝ID做商家编码 | 不添加）
    // merchantCode: 'offerId'=用1688宝贝ID做商家编码 | 'none'=不添加（随机货号优先，与黑鲸鱼一致）
    const merchantCode = String(up.merchantCode || 'offerId');
    let outerId = String(goods.offerId || '');
    if (up.randHh) {
      outerId = 'HH' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100);
    } else if (merchantCode === 'none') {
      outerId = '';
    }
    let shopcat = [];
    if (up.uploadClassfy && up.uploadClassfyId && /^\d+$/.test(String(up.uploadClassfyId).trim())) {
      shopcat = [Number(String(up.uploadClassfyId).trim())];
    }
    // 店铺分类自动挂载（uploadClassfy 总开关）：
    // ① 日期分类（黑鲸鱼 mCheckBox1：按日期名查已有分类，查到就挂；黑鲸鱼无建分类API，找不到不创建）
    // ② 类目匹配回退：日期分类没挂上时，店铺分类名与商品类目关键词一致（如"连衣裙"）则自动挂
    if (up.uploadClassfy && !shopcat.length) {
      let shopCats = [];
      try { shopCats = await api.getShopCats(); } catch (e) { log(`店铺分类查询失败(跳过): ${e.message}`); }
      if (up.autoDateCat && shopCats.length) {
        const dateCat = new Date().toISOString().slice(5, 10).replace('-', '月') + '日';
        const hit = shopCats.find(c => c.text && (c.text.endsWith(dateCat) || c.text.includes(dateCat)));
        if (hit && /^\d+$/.test(hit.value)) { shopcat = [Number(hit.value)]; log(`日期分类: ${hit.text}`); }
        else log(`日期分类【${dateCat}】未找到(不自动创建)`);
      }
      if (!shopcat.length && catKeyword && shopCats.length) {
        const kw = String(catKeyword).trim();
        // getShopCats 的 text 可能是"父分类->子分类"格式，取末段参与匹配
        const leaf = t => String(t || '').split('->').pop().trim();
        const hitExact = shopCats.find(c => c.value && leaf(c.text) === kw);
        const hitFuzzy = shopCats.find(c => c.value && kw && (leaf(c.text).includes(kw) || kw.includes(leaf(c.text))));
        const hit = hitExact || hitFuzzy;
        if (hit && /^\d+$/.test(hit.value)) { shopcat = [Number(hit.value)]; log(`店铺分类(类目匹配): ${hit.text}`); }
      }
    }
    // 尺码表预生成（黑鲸鱼 chkSizeTableTj → IsAutoSizemapTj：服装类目尺码表；失败静默，提交报"尺寸表必填"时还有二次兑底）
    let sizeMappingV3 = null;
    let sizeTexts = [];
    if (up.sizeTable) {
      try {
        sizeTexts = (skuDefs || []).filter(d => /尺码|尺寸|码数/.test(String(d.name || '')))
          .flatMap(d => (d.values || []).map(v => String(v.name || ''))).filter(Boolean);
        if (!sizeTexts.length && saleProp) {
          for (const [k, v] of Object.entries(saleProp)) {
            if (/20509|20549|21433|20518/.test(k)) sizeTexts = (Array.isArray(v) ? v : (v.value || [])).map(x => String(x.text || '')).filter(Boolean);
          }
        }
        if (sizeTexts.length) {
          // 尺码组：取发布页选中的 selectedSizeGroupId（女装 women_tops 等，勿用默认男装组）
          const szGroup = (pageData.specSkuMap && Object.values(pageData.specSkuMap).find(v => v && (v.subName || v.value)))
            || null;
          const sizeMapDef = await api.getSizeMap(catId, szGroup);
          if (sizeMapDef && Object.keys(sizeMapDef).length) {
            sizeMappingV3 = TaoApi.buildSizeMappingV3({ sizeMap: sizeMapDef, title, sizeTexts, withRecommend: !!up.sizeTableTj });
            log(`尺码表已生成: ${sizeTexts.length}个尺码${up.sizeTableTj ? '（含推荐尺码）' : ''}`);
          } else {
            log('该类目无必填尺码列(跳过尺码表)');
          }
        }
      } catch (e) { log(`尺码表生成失败(跳过): ${e.message}`); }
    }
    // 清空草稿箱（黑鲸鱼 chkClearDraft：提交前清当前类目草稿，防草稿箱满）
    if (up.clearDraft) {
      try {
        const drafts = await api.getDraftList(catId);
        if (drafts.length) {
          log(`清空草稿箱: ${drafts.length}条`);
          for (const d of drafts) await api.deleteDraft(catId, d.id);
        }
      } catch (e) { log(`清空草稿箱失败(跳过): ${e.message}`); }
    }
    const upItem = TaoApi.buildUpItem({
      catId, title,
      price: finalPrice,
      quantity: (this.store.settings.template.stock || 99),
      images: mainUrls,
      desc: descPc,
      wirelessDesc: descWl,
      catProps,
      brandId, brandName,
      shipTemplate,
      verticalUrl,
      // 发货地：优先 1688 商品真实发货地（freightInfo.location，如"广东省 揭阳市"），
      // 其次模板设置，最后默认——写死杭州会导致发货地址与商品不符（用户实测问题）
      location: (goods.raw && goods.raw.location) || (this.store.settings.template && this.store.settings.template.location) || '浙江省 杭州市',
      warehouse,
      putawayTime,
      sku: skuList,             // 多规格 SKU（黑鲸鱼 UpSku）；空数组=一口价
      saleProp,
      outerId,
      shopcat,
      // 黑鲸鱼 UploadCondition 全量对应（二手/定制/条形码/库存计数/服务承诺/7天退货/鉴别/视频）
      secondHand: +up.twoItem === 1,
      customItem: +up.customItem > 0 ? +up.customItem : 0,
      barcode: String(up.barCode || '').trim(),
      subStock: +up.stockType === 0 ? 0 : 1,
      sevenDay: up.day7 !== false,
      backPromise: !!up.backR,
      appraiseService: !!up.raiseService,
      video: videoObj,
      formDefaults: pageData.formDefaults || {},
      // 黑鲸鱼上传条件二期（发货时效/重量/多件优惠/尺码表/代购）
      deliveryTime: Number(up.deliveryTime) || 0,
      postWeight: Number(up.postWeight) || 0,
      multiDiscount: !!up.multiDiscount,
      multiDiscountVal: Number(up.multiDiscountVal) > 0 ? Number(up.multiDiscountVal) : 9.5,
      sizeMappingV3,
      dgSendCity: String(up.dgSendCity || '').trim(),
      // 导购标题（黑鲸鱼 TitleToShop：0=不设置 1=标题生成 2=自定义 DgTitle）
      titleToShop: Number(up.titleToShop) || 0,
      dgTitle: String(up.dgTitle || '').trim(),
      // 适用商户门店（黑鲸鱼 chkSdShop/selStore：勾选后带 store 字段）
      shopStoreId: (up.sdShop && up.shopStoreId) ? String(up.shopStoreId) : '',
    });
    log('UpItem 构造完成');

    // 9. 提交（含自动重试）
    log('提交…');
    if (opts.debug) {
      // 调试模式：保存 UpItem 到本地不提交
      const dump = path.join(process.env.APPDATA || '', '千牛铺货助手', 'data', `upitem-${goods.offerId}.json`);
      fs.writeFileSync(dump, JSON.stringify(upItem, null, 2), 'utf8');
      log(`调试模式: UpItem 已保存 ${dump}`);
      steps.push({ step: 'submit', ok: true, note: 'debug未提交' });
      return { ok: true, steps, itemId: '', itemUrl: '', debug: true, upItem };
    }

    const submitOpts = {
      priceToOne: !!up.priceToOne,     // 价格超限自动修改SKU价格（黑鲸鱼 chkPriceToOne）
      nxImg: String(imgCfg.nxImg || '').trim(),  // 能效标识图（黑鲸鱼 txtNxImg）
      sizeTable: !!up.sizeTable,       // 尺寸表必填时自动生成重试（黑鲸鱼 IsAutoSizemap 兑底）
      sizeTexts,
    };
    const r = await api.submit(upItem, submitOpts);
    if (!r.ok) {
      steps.push({ step: 'submit', ok: false, note: r.error });
      log('提交失败: ' + r.error);
      // 失败时保存到草稿箱（黑鲸鱼 chkFailSaveDraft → draftOp/add.json）
      if (up.failSaveDraft) {
        try {
          const d = await api.saveDraft(upItem);
          if (d.ok) { log(`已保存到草稿箱【${d.name}】编号:${d.id}`); steps.push({ step: 'draft', ok: true, note: d.id }); }
          else log('保存草稿失败: ' + d.error);
        } catch (e) { log(`保存草稿异常: ${e.message}`); }
      }
      throw new Error('发布失败: ' + r.error);
    }
    steps.push({ step: 'submit', ok: true, note: `商品${r.itemId} 重试${r.retries}次` });
    log(`发布成功: ${r.itemId}`);
    // 一件变二件（黑鲸鱼 chkFission 商品裂变：同一商品再发一件，标题尾部加随机尾错开）
    let extraItemId = '';
    if (up.fission) {
      try {
        log('商品裂变：第2件发布中…');
        const upItem2 = JSON.parse(JSON.stringify(upItem));
        upItem2.outerId = String(upItem2.outerId || '') + 'F' + Math.floor(Math.random() * 900 + 100);
        const r2 = await api.submit(upItem2, { ...submitOpts, maxRetry: 2 });
        if (r2.ok) { extraItemId = r2.itemId; log(`裂变成功: ${r2.itemId}`); steps.push({ step: 'fission', ok: true, note: r2.itemId }); }
        else log('裂变失败(不影响主商品): ' + r2.error);
      } catch (e) { log(`裂变异常(不影响主商品): ${e.message}`); }
    }

    // 发布成功 → 建立 1688 分销关联（黑鲸鱼 RelationItem1688：linkConsignSellItem）
    // 关联后买家下单自动生成 1688 采购单（真正的一件代发），失败不影响发布结果
    let relationOk = null;
    if (up.relation !== false) {
      relationOk = await this._relation1688(goods, r.itemId, win, log);
      steps.push({ step: 'relation1688', ok: !!relationOk, note: relationOk === true ? '分销关联成功' : (relationOk === false ? '分销关联失败(不影响发布)' : '未关联') });
    }

    return { ok: true, steps, itemId: r.itemId, itemUrl: r.itemUrl, extraItemId, relationOk, durationSec: Math.round((Date.now() - t0) / 1000) };
  }

  /**
   * 发布后建立 1688 分销关联（黑鲸鱼 UploadItemApi.RelationItem1688 完整移植）
   *
   * 黑鲸鱼链路（ItemCopy.decrypted.cs L118914）：
   *   1. GetShopItemInfo(淘宝itemId) → 编辑页 window.Json.components.sku → skuMapWriteParamMap
   *   2. TbH5Sign.Post1688 POST h5api.m.1688.com/h5/mtop.com.alibaba.cbu.distribute.web.linkconsignsellitem/1.0/
   *      URL 带 __channel_ra_model_key=QIANNIU_DXData（千牛分销白名单渠道，风控低）
   *      Header: Origin=detail.1688.com / Referer=分销页 / Sec-Fetch-Mode=no-cors / Sec-Fetch-Site=same-site
   *      Cookie 手动拼接（含 x5sec 风控凭证）；响应种新 _m_h5_tk 时重签重试一次
   *   3. 成功判定 data.data.linkSuccess=true → SaveRe1688 缓存
   *      "开小差" → 也记成功缓存（黑鲸鱼实测该响应实际已受理）
   *      "::Session过期" → BrowserLoad 分销页刷新登录态后重试一次
   *
   * 关联后买家下单自动生成 1688 采购单（真正的一件代发）；失败不影响发布结果
   * @returns true=关联成功 false=关联失败 null=未执行（缺数据/无1688账号）
   */
  async _relation1688(goods, itemId, shopWin, log) {
    const offerId = goods.offerId;
    const supplierUserId = goods.raw && goods.raw.supplierUserId;
    if (!offerId || !itemId) { log('分销关联跳过: 缺商品ID'); return null; }
    if (!supplierUserId) { log('分销关联跳过: 采集数据无供应商ID（老数据重新采集后可用）'); return null; }

    // 1688 登录态（采集账号 session，cookie 容器等价黑鲸鱼 GetCookie）
    const acc = this.accounts.getWorking1688 && this.accounts.getWorking1688();
    if (!acc) { log('分销关联跳过: 无1688采集账号'); return null; }
    const { session } = require('electron');
    const aliSession = session.fromPartition(acc.partition, { cache: true });
    const referer = `https://detail.1688.com/offer/${offerId}.html?sk=consign&biz=qianniu&isNeedCloseWinport=y`;

    /** 单次关联调用（黑鲸鱼 RelationItem1688 主体） */
    const linkOnce = async (skuMap) => {
      const params = {
        offerId: String(offerId),
        supplierUserId: String(supplierUserId),
        itemId: String(itemId),
        outPlatform: 'TB',
        skuMapWriteParamMap: skuMap || {},
      };
      const raw = await this._post1688Mtop(aliSession, referer,
        'mtop.com.alibaba.cbu.distribute.web.linkConsignSellItem', { params: JSON.stringify(params) });
      // 成功判定（黑鲸鱼：data.data.linkSuccess → SaveRe1688 缓存）
      let j = null;
      try { j = JSON.parse(raw); } catch (_) {}
      const ret = (j && j.ret && j.ret[0]) || '';
      if (/SUCCESS::/.test(ret) || /SUCCESS$/.test(ret)) {
        const inner = (j.data && j.data.data) || j.data || {};
        if (inner && (inner.linkSuccess === true || inner.linkSuccess === 'true')) return { ok: true };
        return { ok: false, ret };
      }
      // 黑鲸鱼："开小差" → SaveRe1688 记缓存（防重复关联）但仍按失败返回
      if (String(raw).includes('开小差')) return { ok: false, ret: '开小差(已缓存防重试)', via: '开小差' };
      const err = new Error('mtop: ' + (ret || String(raw).slice(0, 120)));
      err.raw = raw;
      err.ret = ret;
      throw err;
    };

    try {
      log('分销关联：建立1688一件代发关联…');
      // 1) SKU 规格映射（黑鲸鱼 GetShopItemInfo：淘宝编辑页 sku → outerSpec/innerSpec）
      let skuMap = {};
      let skuMapNote = '空';
      try {
        skuMap = await this._buildSkuMap(goods, itemId, shopWin) || {};
        skuMapNote = String(Object.keys(skuMap).length);
      } catch (e) { /* 映射失败用空映射，关联仍生效 */ }
      // 2) linkConsignSellItem（千牛渠道）
      const r1 = await linkOnce(skuMap);
      if (r1.ok) {
        log(`分销关联成功${r1.via ? '(' + r1.via + ')' : ''}: 1688商品${offerId} ↔ 淘宝${itemId}（SKU映射${skuMapNote}条）`);
        return true;
      }
      // 3) linkSuccess 未返回 → 空映射重试（黑鲸鱼 skuMapWriteParamMap:{} 路径）
      log('分销关联未确认，空映射重试一次…');
      const r2 = await linkOnce({});
      if (r2.ok) { log(`分销关联成功(空映射): 1688商品${offerId} ↔ 淘宝${itemId}`); return true; }
      return false;
    } catch (e) {
      // Session 过期（黑鲸鱼：BrowserLoad 分销页刷新登录态 → 重试一次）
      if (/SESSION_EXPIRED|Session过期|FAIL_SYS_SESSION_EXPIRED/i.test(String(e.ret || e.message))) {
        try {
          log('分销关联: 1688登录态过期，加载分销页刷新会话重试…');
          const win = await this.accounts.getWorkWindow(acc, { show: false });
          await win.loadURL(referer);
          await DOM.waitLoadStop(win.webContents, 30000).catch(() => {});
          await DOM.sleep(3000);
          const r3 = await linkOnce({});
          if (r3.ok) { log(`分销关联成功(重试): 1688商品${offerId} ↔ 淘宝${itemId}`); return true; }
          return false;
        } catch (e2) { log(`分销关联失败(重试后): ${e2.message}`); return false; }
      }
      // 滑块/风控（黑鲸鱼模式：弹浏览器加载 punish 页过滑块后重试；此处用 Slider 自动化等价实现）
      if (/USER_VALIDATE|RGV587|被挤爆/.test(String(e.ret || e.message))) {
        try {
          // 解析 mtop 返回的 punish 验证页地址（RGV587 响应 data.url）
          let punishUrl = '';
          try {
            const j = JSON.parse(e.raw || '{}');
            punishUrl = (j.data && j.data.url) || '';
          } catch (_) {}
          const win = await this.accounts.getWorkWindow(acc, { show: false });
          const target = punishUrl || referer;
          log(`分销关联遇滑块验证：自动过验证并重试（${punishUrl ? 'punish页' : '分销页'}）…`);
          await win.loadURL(target);
          await DOM.waitLoadStop(win.webContents, 30000).catch(() => {});
          await DOM.sleep(2500);
          const sl = await Slider.solve(win, this.logger, 'relation-slider', 3);
          log(`滑块验证${sl.passed ? '通过' : '未通过(可能需人工)'}`);
          if (sl.passed) {
            await DOM.sleep(1500);
            const r4 = await linkOnce({});
            if (r4.ok) { log(`分销关联成功(滑块后重试): 1688商品${offerId} ↔ 淘宝${itemId}`); return true; }
          }
          log('分销关联仍失败：该商品已在淘宝发布成功，可稍后打开1688分销后台手动补关联');
          return false;
        } catch (e2) { log(`分销关联滑块处理异常: ${e2.message}`); return false; }
      }
      log(`分销关联失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 直连 1688 mtop（黑鲸鱼 TbH5Sign.Post1688 完整移植，L61903）
   * 与 JSONP 的本质差异：POST + 手动 Cookie(含 x5sec) + 千牛渠道参数 + 风控头，走千牛白名单链路
   * 载体：Node 原生 https 模块（Chromium net 栈对此类请求报 ERR_BLOCKED_BY_CLIENT，
   *       视频上传 _putBinary 同款先例；黑鲸鱼 .NET HttpItem 无此限制）
   * - URL: h5api.m.1688.com/h5/{api小写}/1.0/?jsv=2.7.4&…&__channel_logger_mtop_report=1&__channel_ra_model_key=QIANNIU_DXData
   * - 签名: MD5(token + '&' + t + '&12574478&' + postdata原文)  token=_m_h5_tk 首段
   * - Cookie: h5api.m.1688.com 域全量 + detail.1688.com 域 x5sec（风控通过凭证）合并
   * - 响应 Set-Cookie 种新 _m_h5_tk 时自动重签重试一次（黑鲸鱼同款）
   * @returns 响应原文（JSON 字符串）
   */
  async _post1688Mtop(aliSession, referer, api, dataObj) {
    const crypto = require('crypto');
    const nodeHttps = require('https');
    const APP_KEY = '12574478';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const dataStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
    const apiPath = String(api).toLowerCase();

    // Cookie 容器（黑鲸鱼 GetCookie(rurl)：h5api 域全量 + 关键风控 cookie）
    const buildCookie = async () => {
      const parts = [];
      const seen = new Set();
      const add = (list) => (list || []).forEach(c => {
        if (c.name && c.value != null && !seen.has(c.name)) { seen.add(c.name); parts.push(`${c.name}=${c.value}`); }
      });
      try { add(await aliSession.cookies.get({ url: 'https://h5api.m.1688.com/' })); } catch (_) {}
      try {
        // x5sec 等风控凭证在 detail.1688.com 域（黑鲸鱼 cookie 容器是全域合并的）
        add((await aliSession.cookies.get({ url: 'https://detail.1688.com/' })).filter(c =>
          /x5sec|sgcookie|cookie2|_csrf|unb|cna|isg|l=/i.test(c.name)));
      } catch (_) {}
      return parts.join('; ');
    };
    const getToken = (cookie) => {
      const m = String(cookie).match(/_m_h5_tk=([^_;]+)/);
      return m ? m[1].split('_')[0] : 'undefined';
    };
    // Set-Cookie 回写 session（黑鲸鱼 ConvertCookie → 容器；下次请求生效）
    const absorbSetCookie = async (setCookies) => {
      try {
        for (const sc of (setCookies || [])) {
          const m = String(sc).match(/^([^=]+)=([^;]*)/);
          if (!m) continue;
          await aliSession.cookies.set({ url: 'https://h5api.m.1688.com/', name: m[1], value: m[2] }).catch(() => {});
        }
      } catch (_) {}
    };
    /** Node https 单次请求（gzip/br 自动解压） */
    const doOnce = async (cookie) => {
      const t = Date.now().toString();
      const token = getToken(cookie);
      const sign = crypto.createHash('md5').update(`${token}&${t}&${APP_KEY}&${dataStr}`, 'utf8').digest('hex');
      const pathUrl = `/h5/${apiPath}/1.0/?jsv=2.7.4&appKey=${APP_KEY}&t=${t}&sign=${sign}` +
        `&api=${encodeURIComponent(api)}&v=1.0&type=originaljson&dataType=jsonp&timeout=20000` +
        `&__channel_logger_mtop_report=1&__channel_ra_model_key=QIANNIU_DXData`;
      const body = 'data=' + encodeURIComponent(dataStr);
      return await new Promise((resolve, reject) => {
        const req = nodeHttps.request({
          hostname: 'h5api.m.1688.com',
          port: 443,
          path: pathUrl,
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': referer,
            'Origin': 'https://detail.1688.com',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-site',
            ...(cookie ? { Cookie: cookie } : {}),
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const enc = String(res.headers['content-encoding'] || '');
            let out = buf;
            try {
              if (/br/i.test(enc)) out = require('zlib').brotliDecompressSync(buf);
              else if (/gzip/i.test(enc)) out = require('zlib').gunzipSync(buf);
              else if (/deflate/i.test(enc)) out = require('zlib').inflateSync(buf);
            } catch (_) { out = buf; }
            resolve({ status: res.statusCode, body: out.toString('utf8'), setCookies: res.headers['set-cookie'] });
          });
        });
        req.on('error', e => reject(e));
        const timer = setTimeout(() => { req.destroy(); reject(new Error('请求超时')); }, 20000);
        req.on('close', () => clearTimeout(timer));
        req.write(body);
        req.end();
      });
    };

    // 黑鲸鱼流程：首次请求 → 响应种新 _m_h5_tk 且未成功 → 重签重试一次
    let cookie = await buildCookie();
    let r = await doOnce(cookie);
    await absorbSetCookie(r.setCookies);
    let txt = String(r.body || '');
    const oldToken = getToken(cookie);
    if (!/SUCCESS|"linkSuccess"/.test(txt) && txt.length < 600) {
      const newCookie = await buildCookie();
      if (getToken(newCookie) !== oldToken) {
        r = await doOnce(newCookie);
        await absorbSetCookie(r.setCookies);
        txt = String(r.body || '');
      }
    }
    return txt;
  }

  /**
   * 发布前预热 1688 分销发布页（黑鲸鱼 UploadItemApi.GetPubData，公开调用处）
   * GET item.upload.taobao.com/from1688/render.htm?sourceId={offerId}&targetUserId={供应商uid}&__channel_logger_channel_type=qn
   * 作用：在淘宝侧建立"1688 分销铺货"渠道上下文（种渠道 cookie），黑鲸鱼发布前必调
   * 载体：Node 原生 https（Chromium net 对此类请求报 ERR_BLOCKED_BY_CLIENT，_putBinary 同款先例）
   */
  async _preheat1688Publish(goods, shopSession, log) {
    const offerId = goods.offerId;
    const supplierUserId = goods.raw && goods.raw.supplierUserId;
    if (!offerId || !supplierUserId || !shopSession) return false;
    const nodeHttps = require('https');
    const url = `https://item.upload.taobao.com/from1688/render.htm?sourceId=${offerId}&__channel_logger_offer_id=${offerId}&newPublish=true&from1688PredictCacheId=${offerId}&targetUserId=${supplierUserId}&__channel_logger_channel_type=qn`;
    try {
      const cookieParts = (await shopSession.cookies.get({ url: 'https://item.upload.taobao.com/' }).catch(() => []))
        .map(c => `${c.name}=${c.value}`).join('; ');
      const status = await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = nodeHttps.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Upgrade-Insecure-Requests': '1',
            'Referer': `https://item.upload.taobao.com/from1688/publish.htm?__channel_logger_channel_type=qn&__channel_logger_offer_id=${offerId}&sourceId=${offerId}&targetUserId=${supplierUserId}`,
            ...(cookieParts ? { Cookie: cookieParts } : {}),
          },
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', e => reject(e));
        const timer = setTimeout(() => { req.destroy(); reject(new Error('预热超时')); }, 15000);
        req.on('close', () => clearTimeout(timer));
        req.end();
      });
      log(`1688分销发布页预热完成（status=${status}，渠道上下文已建立）`);
      return true;
    } catch (e) {
      log(`1688分销预热失败(不影响发布): ${e.message}`);
      return false;
    }
  }

  /**
   * 构造 SKU 规格映射（黑鲸鱼 GetShopItemInfo 同源）
   * 淘宝编辑页 window.Json.components.sku.props.value[] → {skuId, props:[{name:pid, text}]}
   * + saleProp.props.subItems pid→label（如 颜色分类/尺码）
   * 输出 { "淘宝skuId": { outerSkuId, outerSpec:{淘宝名→淘宝值}, innerSpec:{1688名→1688值} } }
   * innerSpec：淘宝值文本直接匹配 1688 SKU 的 values（发布时值来自1688，文本一致）
   */
  async _buildSkuMap(goods, itemId, shopWin) {
    if (!shopWin || shopWin.isDestroyed()) return null;
    // 导航到淘宝编辑页（黑鲸鱼 GetShopItemInfo URL 同款）
    await shopWin.loadURL(`https://item.upload.taobao.com/sell/v2/publish.htm?itemId=${itemId}&fromAIPublish=true`);
    await DOM.waitLoadStop(shopWin.webContents, 30000).catch(() => {});
    await DOM.sleep(3000); // SPA 渲染
    const info = await DOM.evalInPage(shopWin.webContents, `
      try {
        const J = window.Json;
        if (!J || !J.components) return null;
        // pid → 规格名（颜色分类/尺码）
        const labels = {};
        try {
          const sp = J.components.saleProp && J.components.saleProp.props && J.components.saleProp.props.subItems || {};
          for (const k of Object.keys(sp)) labels[k] = sp[k].label || k;
        } catch (e) {}
        // SKU 列表
        const skus = (J.components.sku && J.components.sku.props && J.components.sku.props.value) || [];
        if (!Array.isArray(skus) || !skus.length) return null;
        return skus.map(s => ({
          skuId: String(s.skuId || ''),
          props: (s.props || []).map(p => ({ name: labels[p.name] || p.name, text: String(p.text || '') })),
        }));
      } catch (e) { return null; }
    `);
    if (!info || !info.length) return null;

    // 1688 侧规格名（skuDefs：[{name:颜色, values:[{name:黑色}]}]）
    const aliDefs = (goods.raw && goods.raw.skuDefs) || [];
    const map = {};
    for (const sku of info) {
      if (!sku.skuId) continue;
      const outerSpec = {};
      const innerSpec = {};
      for (const p of sku.props) {
        outerSpec[p.name] = p.text;
        // 1688 侧规格名对齐（淘宝"颜色分类"→1688"颜色"；尺码同名）
        let aliName = p.name;
        if (aliDefs.length) {
          const hit = aliDefs.find(d => d.name && (d.name === p.name ||
            (p.name.includes(d.name)) || (d.name.includes(p.name.replace('分类', '')))));
          if (hit) aliName = hit.name;
        }
        innerSpec[aliName] = p.text; // 发布时值来自1688（或其转换），文本直传
      }
      if (!Object.keys(outerSpec).length) continue;
      map[sku.skuId] = { outerSkuId: sku.skuId, outerSpec, innerSpec };
    }
    return Object.keys(map).length ? map : null;
  }

  /** ====================== DOM 页面模拟模式（保留兼容） ====================== */
  async _publishDom(goods, opts = {}) {
    const { shop, win } = await this._shopWindow({ show: opts.debug || false });
    const t0 = Date.now();
    // 每条 log 同步上报进度卡片（带累计耗时），用户不用翻日志
    const stepNames = { '打开千牛工作台': 5, '进入发布页': 12, '类目': 22, '标题': 32, '主图': 45, '价格': 55, '详情图': 70, '物流': 78, '售后': 85, '品牌': 88, '商家编码': 91, '提交': 96 };
    const stepPct = (m) => {
      for (const [k, v] of Object.entries(stepNames)) if (m.includes(k)) return v;
      return null;
    };
    const log = (m, d) => {
      this.logger.info('publish', `[${goods.offerId}] ${m}`, d);
      const pct = stepPct(m);
      if (pct != null && this.onProgress) {
        this.onProgress({ key: 'publish-' + goods.offerId, title: `上架: ${(goods.title || goods.offerId).slice(0, 16)}`, detail: `${m}（${Math.round((Date.now() - t0) / 1000)}s）`, percent: pct });
      }
    };
    const steps = [];

    try {
      // ---------- 0. 打开千牛工作台（后台入口）确认店铺登录态，再进发布页 ----------
      // 若窗口已在淘宝系发布页（上次流程残留），跳过工作台检查直接走流程（减少导航+防beforeunload）
      const curUrl = win.webContents.getURL();
      if (!/taobao\.com|tmall\.com/.test(curUrl)) {
        log('打开千牛工作台，确认店铺登录态…');
        await win.loadURL(WORKBENCH_URL);
        await DOM.waitLoadStop(win.webContents, 30000);
        await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
        if (/login\.taobao\.com/.test(win.webContents.getURL())) {
          throw new Error('商家账号登录态失效，请到「店铺管理」重新扫码登录');
        }
      }
      const shopName = (shop.name || '').replace(/^店铺[:：]\s*/, '');
      win.setTitle(`千牛发布 - ${shopName}（后台静默，请勿关闭）`);
      log('进入新版发布页');
      // 千牛2026新版：upload.taobao.com 入口 → 方式选择页 → 搜索类目 → 表单页
      // 同域内导航（已在 upload/item.upload 页时不重复 loadURL，防 beforeunload 卡顿）
      if (!/upload\.taobao\.com|item\.upload\.taobao\.com/.test(win.webContents.getURL())) {
        await win.loadURL(PUBLISH_ENTRY_URL);
        await DOM.waitLoadStop(win.webContents, 30000);
      } else {
        // 已在发布器内：回入口页重新选类目
        await win.loadURL(PUBLISH_ENTRY_URL).catch(async () => {
          // beforeunload 被拦时用 reload 兜底
          await DOM.sleep(500);
        });
        await DOM.waitLoadStop(win.webContents, 30000).catch(() => {});
      }
      await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
      await this._guardVerification(win, log);

      // ---------- 1. 类目 ----------
      // 配置来源：上传设置(upset) categoryMode=self→统一类目词 / default→复制1688原宝贝类目
      const upSet = this.store.settings.upset || {};
      let cat = '';
      if (upSet.categoryMode === 'self') {
        cat = upSet.categoryKey || '';
      } else {
        // 复制原宝贝类目：取1688面包屑叶子类目（最具体，如"女装>连衣裙"→"连衣裙"）；
        // 采集没拿到面包屑时，回退到用户配置的类目词
        const segs = String((goods.raw && goods.raw.categoryText) || '')
          .split('>').map(s => s.trim()).filter(Boolean);
        cat = segs[segs.length - 1] || upSet.categoryKey || '';
      }
      const catOk = await this._stepCategory(win, cat, log);
      steps.push({ step: 'category', ok: catOk.ok, note: catOk.note });
      if (!catOk.ok) throw new Error('类目选择失败: ' + catOk.note);

      // ---------- 2. 标题（应用黑鲸鱼标题处理链） ----------
      const title = this._applyTitleRules(goods.title || '', goods.offerId, this.store.settings.upset || {});
      await this._stepTitle(win, title, log);
      steps.push({ step: 'title', ok: true });

      // ---------- 3. 主图 ----------
      const imgs = this.media.localPaths(goods.offerId);
      let mainOk = false;
      if (imgs.main && imgs.main.length) {
        mainOk = await this._stepMainImages(win, imgs.main.slice(0, 5), log);
      } else {
        log('本地无主图缓存（采集时未下载），主图步骤跳过——请补采');
      }
      steps.push({ step: 'mainImages', ok: mainOk, note: mainOk ? `${imgs.main.length}张` : '未上传' });

      // ---------- 4. 价格/数量 ----------
      await this._stepPrice(win, goods, log);
      steps.push({ step: 'price', ok: true });

      // ---------- 5. 详情图（失败不阻断） ----------
      if (this.store.settings.advanced && this.store.settings.advanced.enableDetailImages) {
        try {
          const dn = await this._stepDetailImages(win, imgs.detail.slice(0, 40), log);
          steps.push({ step: 'detailImages', ok: true, note: `${dn}张` });
        } catch (e) {
          steps.push({ step: 'detailImages', ok: false, note: e.message });
          log('详情图上传失败，跳过继续（不影响上架）: ' + e.message);
        }
      }

      // ---------- 6. 物流 ----------
      await this._stepShipping(win, log);
      steps.push({ step: 'shipping', ok: true });

      // ---------- 7. 售后 ----------
      await this._stepAfterSale(win, goods, log);
      steps.push({ step: 'afterSale', ok: true });

      // ---------- 7.5 品牌/商家编码（仿破军星） ----------
      try {
        await this._stepBrand(win, log);
        steps.push({ step: 'brand', ok: true });
      } catch (e) { steps.push({ step: 'brand', ok: false, note: e.message }); }
      try {
        await this._stepMerchantCode(win, goods, log);
        steps.push({ step: 'merchantCode', ok: true });
      } catch (e) { steps.push({ step: 'merchantCode', ok: false, note: e.message }); }

      // ---------- 7.6 商品属性（新版必填属性）+ 物流服务（发货地/提取方式） ----------
      try {
        await this._stepProps(win, goods, log);
        steps.push({ step: 'props', ok: true });
      } catch (e) { steps.push({ step: 'props', ok: false, note: e.message }); log('属性填充异常(继续): ' + e.message); }
      try {
        await this._stepShipArea(win, log);
        steps.push({ step: 'shipArea', ok: true });
      } catch (e) { steps.push({ step: 'shipArea', ok: false, note: e.message }); log('物流服务选择异常(继续): ' + e.message); }

      // ---------- 8. 提交（支持放入仓库） ----------
      if (opts.debug) {
        win.show();
        win.setTitle('【调试模式】商品已填写完成未提交 —— 请人工核对表单');
        log('调试模式：已填完所有字段，暂停在提交前');
        return { ok: true, debug: true, steps, durationMs: Date.now() - t0 };
      }

      const uploadMode = (this.store.settings.advanced && this.store.settings.advanced.uploadMode) || 'warehouse';
      const submitted = await this._stepSubmit(win, log, uploadMode);
      steps.push({ step: 'submit', ok: true, mode: uploadMode });
      return { ok: true, steps, durationMs: Date.now() - t0, itemUrl: submitted.itemUrl, mode: uploadMode };
    } catch (e) {
      await DOM.captureSnapshot.call({ dir: this.store.dir }, win.webContents, 'publish-fail-' + goods.offerId);
      return { ok: false, error: e.message, steps, durationMs: Date.now() - t0 };
    }
  }

  /** 单品调试发布 */
  async debugPublish(goodsId) {
    const goods = this.store.goodsById(goodsId);
    if (!goods) return { ok: false, error: '商品不存在' };
    return this.publish(goods, { debug: true });
  }

  // ============ 各步骤实现 ============

  /** 验证码/滑块守卫：先自动滑块，失败才弹人工 */
  async _guardVerification(win, log) {
    const check = async () => {
      const hit = await DOM.evalInPage(win.webContents, `
        const t = document.body.innerText || '';
        const hints = ${JSON.stringify(VERIFY_HINTS)};
        const hitWord = hints.find(h => t.includes(h));
        return hitWord || '';
      `).catch(() => '');
      return hit;   // 命中的验证词，空串=无验证
    };
    const found = await check();
    if (!found) return;
    log(`检测到安全验证「${found}」，自动拖动滑块…`);
    // 瞬态验证：等2秒看是否自动放行（淘宝punish页有自动刷新机制）
    await DOM.sleep(2500);
    if (!(await check())) { log('验证已自动消失，继续'); return; }

    // 自动滑块（真实事件模拟，不弹窗）
    const auto = await Slider.solve(win, this.logger, 'publish');
    if (auto.passed && !(await check())) {
      log('滑块自动验证通过');
      return;
    }

    // 自动失败才弹人工
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setTitle('【需要人工】千牛页面出现安全验证，请手动完成滑块验证（完成后自动继续）');
    this.logger.warn('publish', '自动滑块未通过，已弹出窗口等待人工处理');
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      await DOM.sleep(3000);
      const still = await check();
      if (!still) {
        try { win.setAlwaysOnTop(false); } catch (_) {}
        if (!this.store.settings.advanced || !this.store.settings.advanced.keepWindowVisible) win.hide();
        log('人工验证完成，继续发布');
        return;
      }
    }
    try { win.setAlwaysOnTop(false); } catch (_) {}
    throw new Error('等待人工验证超时(5分钟)');
  }

  /** 步骤1: 千牛2026新版类目流程
   *  入口 upload.taobao.com/auction/sell.jhtml → 方式选择页 →「搜索发品」开启
   *  → 输入类目词 → 搜索 → 点类目候选 → 确认下一步 → 表单页
   *  兜底：发布历史里的最近类目词（一键复填）
   */
  async _stepCategory(win, catKeyword, log) {
    // 已在表单页（URL 判定最可靠）
    if (await this._onFormPage(win)) return { ok: true, note: '已在表单页' };

    // 1. 等方式选择页就绪（"开启"按钮 或 搜索输入框）
    const mode = await this._waitModePage(win, 30000);
    if (mode === 'timeout') return { ok: false, note: '发布入口页加载超时' };

    // 2. 若在方式选择页：点「搜索发品」的开启
    if (mode === 'choice') {
      log('新版发布：点击「搜索发品」…');
      const clicked = await DOM.evalInPage(win.webContents, `
        const cards = [...document.querySelectorAll('div,section')];
        const card = cards.find(el => (el.innerText || '').includes('搜索发品') && (el.innerText || '').includes('开启'));
        if (!card) return false;
        const btns = [...card.querySelectorAll('button, [class*="btn" i], span, a')].filter(b => (b.innerText || '').trim() === '开启');
        if (!btns.length) return false;
        btns[0].click();
        return true;
      `).catch(() => false);
      if (!clicked) return { ok: false, note: '「搜索发品」入口未找到' };
      await DOM.sleep(4000);
    }

    // 3. 输入类目词搜索（类目路径取叶子段：女装>连衣裙 → 连衣裙）
    const segs = String(catKeyword || '').split('>').map(s => s.trim()).filter(Boolean);
    const kw = (segs[segs.length - 1] || '').split(/\s+/)[0].slice(0, 10);
    if (!kw) return { ok: false, note: '未配置类目关键词（上传设置→类目→关键词找类目）' };
    log(`新版发布：搜索类目「${kw}」…`);
    const searched = await DOM.evalInPage(win.webContents, `
      const inp = document.querySelector('input[placeholder*="产品名称"], input[placeholder*="类目关键词"]');
      if (!inp) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(kw)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    `).catch(() => 'err');
    if (searched !== 'filled') return { ok: false, note: '类目搜索框未找到' };
    await DOM.humanPause(600, 1200);
    // 点搜索按钮
    await DOM.evalInPage(win.webContents, `
      const btns = [...document.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '搜索');
      if (btns.length) btns[0].click();
      'ok';
    `).catch(() => {});
    await DOM.sleep(5000);

    // 4. 点类目候选项（精确匹配类目路径文本）
    log('选择类目候选…');
    const picked = await DOM.evalInPage(win.webContents, `
      const want = ${JSON.stringify(kw)};
      // 类目候选项：sell-component-general-category-result-cate-path 或含路径文本的元素
      const paths = [...document.querySelectorAll('.sell-component-general-category-result-cate-path, [class*="result-cate-path"], [class*="cate-path"]')];
      let target = paths.find(el => (el.innerText || '').trim().endsWith(want));
      if (!target) {
        // 兜底：任何精确含类目词的路径文本
        const all = [...document.querySelectorAll('div,span,li,a')].filter(el => {
          const t = (el.innerText || '').trim();
          return t.includes('>') && t.includes(want) && t.length < 60;
        });
        target = all[all.length - 1];
      }
      if (!target) return 'no-candidate';
      target.scrollIntoView({ block: 'center' });
      target.click();
      return 'picked:' + (target.innerText || '').trim().slice(0, 30);
    `).catch(() => 'err');
    if (!String(picked).startsWith('picked')) {
      return { ok: false, note: '类目候选未找到（搜索词可能太宽泛，换更精确的词如「连衣裙」）: ' + picked };
    }
    log('已选类目: ' + String(picked).slice(7));
    await DOM.sleep(2000);

    // 5. 确认，下一步
    await DOM.evalInPage(win.webContents, `
      const btns = [...document.querySelectorAll('button')].filter(b => /确认，下一步|确认， 下一步|下一步/.test((b.innerText || '').trim()));
      if (btns.length) { btns[btns.length - 1].click(); return 'ok'; }
      return 'no-next';
    `).catch(() => 'no-next');

    // 6. 等表单页
    for (let i = 0; i < 16; i++) {
      await DOM.sleep(2500);
      if (await this._onFormPage(win)) return { ok: true, note: '新版流程选类目: ' + kw };
    }
    return { ok: false, note: '确认后未进入表单页（可能需要人工核对）' };
  }

  /** 等待新版发布方式页就绪：choice=方式选择页 search=搜索输入页 form=表单页 timeout */
  async _waitModePage(win, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const state = await DOM.evalInPage(win.webContents, `
        const url = location.href;
        if (/sell\\/v2\\/publish\\.htm/.test(url)) return 'form';
        const hasSearchInput = !!document.querySelector('input[placeholder*="产品名称"], input[placeholder*="类目关键词"]');
        if (hasSearchInput) return 'search';
        const hasChoice = (document.body.innerText || '').includes('搜索发品') && (document.body.innerText || '').includes('开启');
        if (hasChoice) return 'choice';
        return 'loading';
      `).catch(() => 'loading');
      if (state !== 'loading') return state;
      await DOM.sleep(1500);
    }
    return 'timeout';
  }

  /** 是否已在商品编辑表单页（新版 URL + 表单元素双判定） */
  async _onFormPage(win) {
    return DOM.evalInPage(win.webContents, `
      if (${FORM_URL_RE.toString()}.test(location.href)) return true;
      const hasTitle = document.querySelector('input[placeholder*="30个汉字"], input[placeholder*="标题"], textarea[placeholder*="标题"]');
      const hasImg = document.querySelector('input[type="file"]');
      return !!(hasTitle || hasImg);
    `).catch(() => false);
  }

  /** 步骤2: 标题 */
  async _stepTitle(win, title, log) {
    if (!title) throw new Error('标题为空');
    const sels = [
      'input[placeholder*="标题"]', 'input[placeholder*="30"]', 'input[placeholder*="60"]',
      'input[maxlength="60"]', 'input[maxlength="30"]',
      '[class*="title"] input', '#J_Title input', 'input[class*="title"]',
    ];
    let ok = false;
    for (const sel of sels) {
      try {
        const r = await DOM.fillText(win.webContents, sel, title);
        if (r && r.ok) { ok = true; break; }
      } catch (_) {}
    }
    if (!ok) throw new Error('标题输入框定位失败');
    await DOM.humanPause(400, 1000);
    log('标题已填: ' + title.slice(0, 20) + '...');
  }

  /** 步骤3: 主图上传（千牛2026新版完整链路）
   *  新版无 input[type=file]：点击空格子打开素材选择器(跨域iframe) →
   *  点「本地上传」出现 file input → 拦截 file chooser →
   *  DOM.setFileInputFiles 注入本地图片 → 上传完成后点「完成」 →
   *  勾选 PicList_checkbox（刚上传的图在列表前N位）→ 点「确定(N)」应用
   */
  async _stepMainImages(win, files, log) {
    const wc = win.webContents;
    const dbg = wc.debugger;
    try { dbg.attach('1.3'); } catch (_) { /* already attached */ }
    const maxWait = 60000;

    // 0. 先等页面网络空闲（表单页 React 懒加载：主图组件晚于标题渲染）
    await DOM.waitForNetworkIdle(wc, 1200, 30000).catch(() => {});
    await DOM.sleep(1500);

    // 1. 等主图格子渲染完成（React 异步渲染，标题填完后立即查会找不到）
    let cellOk = 'err';
    const w0 = Date.now();
    while (Date.now() - w0 < maxWait) {
      cellOk = await DOM.evalInPage(wc, `
        const cell = document.querySelector('.image-empty');
        if (!cell) return 'no-cell';
        cell.scrollIntoView({ block: 'center' });
        return 'ok';
      `).catch(() => 'err');
      if (cellOk === 'ok') break;
      await DOM.sleep(1500);
    }
    if (cellOk !== 'ok') {
      log('主图格子未找到（等待渲染超时，页面可能仍在加载）: ' + String(cellOk));
      return false;
    }
    log('主图格子已就绪，打开素材选择器…');
    await DOM.humanPause(400, 800);
    // 真实鼠标点击空格子（React 懒加载可能未挂 JS click 监听，用 CDP Input 模拟用户点击）
    const cellPos = await DOM.evalInPage(wc, `
      const cell = document.querySelector('.image-empty');
      if (!cell) return null;
      cell.scrollIntoView({ block: 'center' });
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    `).catch(() => null);
    if (cellPos) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cellPos.x, y: cellPos.y }).catch(() => {});
        await DOM.sleep(300);
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: cellPos.x, y: cellPos.y, button: 'left', clickCount: 1 }).catch(() => {});
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cellPos.x, y: cellPos.y, button: 'left', clickCount: 1 }).catch(() => {});
        await DOM.sleep(2000);
        // 用 WebSocket CDP 检测 iframe（webContents.debugger 看不到 OOPIF）
        const { CDPWS } = require('./cdp-ws');
        const _cdp = new CDPWS(9224);
        try {
          await _cdp.connect(t => t.title && t.title.includes('商品发布'));
          const sf = await _cdp.findFrame(/sucai-selector/).catch(() => null);
          _cdp.close();
          if (sf) break;
        } catch (_) { _cdp.close(); }
      }
    } else {
      await DOM.evalInPage(wc, `document.querySelector('.image-empty').click(); 'ok'`).catch(() => {});
    }
    await DOM.sleep(3000);

    // 3. 用 WebSocket CDP 找 sucai iframe（webContents.debugger 对跨域 OOPIF 支持不完整）
    const { CDPWS } = require('./cdp-ws');
    const cdp = new CDPWS(9224);
    await cdp.connect(t => t.title && t.title.includes('商品发布'));
    await cdp.send('Page.enable').catch(() => {});

    let sucaiFrame = null;
    const w1 = Date.now();
    while (Date.now() - w1 < maxWait && !sucaiFrame) {
      sucaiFrame = await cdp.findFrame(/sucai-selector/).catch(() => null);
      if (!sucaiFrame) await DOM.sleep(1500);
    }
    if (!sucaiFrame) { cdp.close(); throw new Error('素材选择器iframe未找到'); }
    log('素材选择器已打开');

    // 4. 在 sucai iframe 内操作（WebSocket CDP 可正常访问 OOPIF）
    const evalW = cdp.createFrameEval(sucaiFrame.id);

    // 等素材面板加载完成
    const wb = Date.now();
    while (Date.now() - wb < 30000) {
      const rs = await evalW(`document.readyState`);
      const bodyLen = await evalW(`(document.body && document.body.innerText || '').length`);
      if (rs === 'complete' && bodyLen > 0) break;
      await DOM.sleep(1000);
    }

    // 点「本地上传」直到 file input 出现
    let fiOk = false;
    const w2 = Date.now();
    while (Date.now() - w2 < 30000 && !fiOk) {
      const n = await evalW(`document.querySelectorAll('input[type=file]').length`);
      if (n > 0) { fiOk = true; break; }
      await evalW(`(function(){
        const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '本地上传');
        if (b) b.click();
      })()`);
      await DOM.sleep(1200);
    }
    log('素材file input: ' + (fiOk ? '就绪' : '未出现'));
    if (!fiOk) { cdp.close(); throw new Error('素材面板file input未找到'); }

    // 取 file input 在 iframe 内坐标
    const pos = await evalW(`(function(){
      const inp = document.querySelector('input[type=file]');
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    if (!pos) { cdp.close(); throw new Error('file input坐标获取失败'); }

    // iframe 在主 frame 的位置（主 frame 同源，用 CDPWS.eval）
    const ipEval = await cdp.eval(`(function(){
      const f = [...document.querySelectorAll('iframe')].filter(f => /sucai-selector/.test(f.src||'') && f.offsetWidth > 0 && f.getBoundingClientRect().x >= 0)[0];
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })()`);
    if (!ipEval) { cdp.close(); throw new Error('素材iframe位置获取失败'); }
    const cx = Math.round(ipEval.x + pos.x);
    const cy = Math.round(ipEval.y + pos.y);
    log('点击file input坐标: ' + cx + ',' + cy);

    // 5. 拦截 file chooser + CDP 点击 file input（全走 WebSocket CDP）
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy }).catch(() => {});
    await DOM.sleep(300);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });

    const chooser = await cdp.waitForEvent('Page.fileChooserOpened', 10000);
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    if (!chooser) { cdp.close(); throw new Error('文件选择未触发'); }
    log('file chooser 已拦截');

    // 6. 注入本地图片
    await cdp.send('DOM.setFileInputFiles', { files, backendNodeId: chooser.params.backendNodeId });
    log(`主图文件已注入${files.length}张，等待上传…`);

    // 7. 等上传完成
    for (let i = 0; i < 30; i++) {
      await DOM.sleep(1500);
      const st = await evalW(`document.querySelectorAll('[class*="PicList_pic_imgBox"],[class*="pic_img"]').length`);
      if (st > 0 && st >= files.length) break;
    }

    // 8. 点「完成」关闭上传面板
    await evalW(`(function(){
      const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '完成');
      if (b) b.click();
    })()`);
    await DOM.sleep(3000);

    // 9. 勾选素材列表中刚上传的图片
    //    上传完成后新图在列表末尾，需勾选最后 N 个而非前 N 个
    const need = Math.min(files.length, 5);
    const pickInfo = await evalW(`(function(){
      // 找所有可选的 checkbox / 选择按钮
      var cbs = Array.from(document.querySelectorAll('[class*="PicList_checkbox"],[class*="checkbox"],[class*="select"]')).filter(e => e.offsetParent !== null);
      // 也尝试找图片卡片上的点击区域
      if (!cbs.length) cbs = Array.from(document.querySelectorAll('[class*="PicList_pic"],[class*="pic_item"],[class*="material-item"]')).filter(e => e.offsetParent !== null);
      if (!cbs.length) {
        // 诊断：dump 按钮和 class 含 pic 的元素
        var btns = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t=>t).slice(0,8);
        var picCls = Array.from(document.querySelectorAll('[class*="Pic"]')).slice(0,5).map(e => e.className.slice(0,50));
        return 'no-cb:0 btns=' + JSON.stringify(btns) + ' pics=' + JSON.stringify(picCls);
      }
      // 选最后 N 个（新上传的在末尾）
      var targets = cbs.slice(-${need});
      targets.forEach(function(c) { c.click(); });
      return 'clicked:' + targets.length + ' total:' + cbs.length;
    })()`);
    log('勾选素材: ' + pickInfo);
    await DOM.sleep(1500);

    // 10. 点「确定(N)」应用
    const confirmed = await evalW(`(function(){
      var btns = Array.from(document.querySelectorAll('button'));
      var b = btns.find(function(b) { return /^确定/.test((b.textContent||'').trim()); });
      if (!b) {
        // 诊断
        var texts = btns.map(function(b) { return (b.textContent||'').trim(); }).filter(function(t) { return t; }).slice(0, 10);
        return 'nf:' + JSON.stringify(texts);
      }
      b.click(); return 'ok';
    })()`);
    log('确定: ' + confirmed);
    await DOM.sleep(4000);

    // 11. 验证主图区
    const after = await DOM.evalInPage(wc, `
      const block = document.getElementById('sell-field-mainImagesGroup');
      if (!block) return -1;
      return block.querySelectorAll('.image-empty').length;
    `).catch(() => -1);
    const emptyAfter = typeof after === 'string' ? JSON.parse(after) : after;
    log('主图上传完成（剩余空格: ' + emptyAfter + '）');

    cdp.close();
    return true;
  }

  /** 步骤4: 价格/数量 */
  async _stepPrice(win, goods, log) {
    const s = this.store.settings;
    const price = goods.sellPrice != null ? goods.sellPrice : goods.price;
    const stock = s.template.stock || 99;

    // 新版发布页价格框：id=sell-field-price 内 input（placeholder 为空）
    const priceSels = [
      '#sell-field-price input',
      '#sell-field-price input[type="text"]',
      'input[placeholder*="价格"]', 'input[placeholder*="一口价"]',
      '[class*="price"] input', '#J_Price input', 'input[class*="price"]',
      'input[aria-label*="价"]',
    ];
    let priceOk = false;
    for (const sel of priceSels) {
      try {
        const r = await DOM.fillText(win.webContents, sel, String(price));
        if (r && r.ok) { priceOk = true; break; }
      } catch (_) {}
    }
    log('价格填充: ' + (priceOk ? price : '未找到价格框(可能为SKU模式，需人工处理)'));
    if (!priceOk) log.warn && log('价格框未定位，继续尝试数量');

    // 数量（新版 id 为 sell-field-stock / struct-quantity 附近）
    const stockSels = [
      '#sell-field-stock input', '#sell-field-stockCount input',
      'input[placeholder*="数量"]', '[class*="quantity"] input', '[class*="amount"] input', 'input[class*="stock"]',
      '#sell-field-p-stock input', '#sell-field-quantity input',
    ];
    let stockOk = false;
    for (const sel of stockSels) {
      try {
        const r = await DOM.fillText(win.webContents, sel, String(stock));
        if (r && r.ok) { stockOk = true; log('数量已填: ' + stock); break; }
      } catch (_) {}
    }
    // 价格未填成功不视为致命（部分类目 SKU 表结构不同），仅记录
  }

  /** 步骤5: 详情图（旺铺编辑器） */
  async _stepDetailImages(win, files, log) {
    if (!files || !files.length) return 0;
    let uploaded = 0;
    // 详情区常见在 iframe（旺铺编辑器 upload.taobao.com），同源可进
    // 策略：找到详情区"图片"上传的 file input，逐张设置
    const perRound = 1; // 逐张稳定
    for (let i = 0; i < Math.min(files.length, 40); i++) {
      const sel = '[class*="detail"] input[type="file"], [class*="desc"] input[type="file"], iframe input[type="file"], [class*="ke-edit"] input[type="file"], input[type="file"][accept*="image"]:not([class*="main"])';
      try {
        // 可能需要先点击"图片"工具按钮唤起
        await DOM.clickByText(win.webContents, '[class*="tool"], [class*="menu"] *, [title*="图"], a, span, button, div', '图片', { timeoutMs: 2000 }).catch(() => {});
        await DOM.setFileInputFiles(win.webContents, sel, [files[i]], { timeoutMs: 6000 });
        uploaded++;
        await DOM.sleep(2500 + Math.random() * 1500);
        if (uploaded % 5 === 0) log(`详情图进度 ${uploaded}/${files.length}`);
      } catch (e) {
        // 连续2张失败就停
        log(`详情图第${i + 1}张失败: ${e.message}`);
        if (uploaded === 0 && i >= 1) throw new Error('详情图上传无法建立流程');
        break;
      }
    }
    log(`详情图完成 ${uploaded}张`);
    return uploaded;
  }

  /** 步骤6: 物流（运费模板） */
  async _stepShipping(win, log) {
    const tpl = this.store.settings.template.shipTemplate;
    if (!tpl) { log('未配置运费模板名，跳过'); return; }
    try {
      await DOM.selectOption(win.webContents,
        '[class*="freight"] select, select[class*="freight"], [class*="ship"] select, select',
        tpl, { timeoutMs: 6000 });
      log('运费模板已选择: ' + tpl);
    } catch (e) {
      log('运费模板选择失败(不阻断): ' + e.message);
    }
  }

  /** 步骤7: 售后（7天无理由 / 退货地址） */
  async _stepAfterSale(win, goods, log) {
    const s = this.store.settings.template;
    if (s.sevenDayReturn !== false) {
      try {
        await DOM.clickByText(win.webContents,
          '[class*="return"] label, [class*="refund"] label, label, [class*="radio"], [class*="check"]',
          '支持7天', { timeoutMs: 5000 }).catch(async () => {
          await DOM.clickByText(win.webContents, 'label, [class*="radio"], [class*="check"], span, div',
            '7天无理由', { timeoutMs: 3000 });
        });
        log('7天无理由已选');
      } catch (e) { log('7天无理由选择失败(不阻断): ' + e.message); }
    }
    // 退货地址：优先按供应商匹配，查不到用全局兜底
    const supplier = goods && goods.raw && goods.raw.supplierUserId
      ? this.store.findSupplier(goods.raw.supplierUserId)
      : null;
    const addr = (supplier && supplier.returnAddress) || s.returnAddress;
    if (addr) {
      try {
        await DOM.selectOption(win.webContents,
          '[class*="address"] select, select[class*="address"], select',
          addr, { timeoutMs: 6000 });
        log('退货地址已选: ' + addr + (supplier && supplier.returnAddress ? '(供应商匹配)' : '(全局)'));
      } catch (e) { log('退货地址选择失败(不阻断): ' + e.message); }
    }
  }

  /** 步骤7.5a: 品牌处理（仿破军星：品牌改other/其他，失败随机品牌） */
  async _stepBrand(win, log) {
    const adv = this.store.settings.advanced || {};
    const mode = adv.brandMode || 'other';
    if (mode === 'keep') return;

    // 找品牌属性行：label含"品牌"的表单
    const r = await DOM.evalInPage(win.webContents, `
      // 找品牌相关输入框/下拉
      const candidates = [];
      document.querySelectorAll('input, select, [class*="select"]').forEach(el => {
        // 从关联label找
        let label = '';
        let p = el;
        for (let i = 0; i < 4 && p; i++) {
          p = p.parentElement;
          if (!p) break;
          const lbl = p.querySelector('[class*="label"], label, [class*="title"]');
          if (lbl && (lbl.innerText || '').includes('品牌')) { label = lbl.innerText; break; }
        }
        if (label.includes('品牌')) candidates.push(el);
      });
      return candidates.length;
    `).catch(() => 0);

    if (!r) return; // 页面无品牌项（类目不同），跳过

    if (mode === 'custom' && adv.brandCustom) {
      await DOM.fillText(win.webContents, 'input[placeholder*="品牌"], [class*="brand"] input', adv.brandCustom).catch(() => {});
      log('品牌已填: ' + adv.brandCustom);
    } else {
      // 品牌修改为 other/其他（搜索输入"其他"选第一个候选）
      try {
        const sel = await DOM.waitForAnySelector(win.webContents, [
          'input[placeholder*="品牌"]', 'input[placeholder*="请输入品牌"]',
          '[class*="brand"] input', '[class*="Brand"] input',
        ], 3000);
        if (sel >= 0) {
          const sels = ['input[placeholder*="品牌"]', 'input[placeholder*="请输入品牌"]', '[class*="brand"] input', '[class*="Brand"] input'];
          await DOM.fillText(win.webContents, sels[sel], '其他');
          await DOM.sleep(800);
          // 点下拉候选"其他"
          await DOM.clickByText(win.webContents,
            '[class*="option"], [class*="item"], li, span, div',
            '其他', { timeoutMs: 2500 }).catch(() => {});
          log('品牌已设置为其他(other)');
        }
      } catch (e) {
        if (adv.brandRandom !== false) log('品牌设置失败（不阻断，人工或随机处理）');
        else log('品牌设置失败（不阻断）');
      }
    }
  }

  /** 步骤7.5b: 商家编码（仿破军星：用1688宝贝ID做商家编码） */
  async _stepMerchantCode(win, goods, log) {
    const adv = this.store.settings.advanced || {};
    const mode = adv.merchantCode || 'offerId';
    if (mode === 'none') return;
    const code = mode === 'offerId' ? String(goods.offerId) : '';

    const sels = [
      'input[placeholder*="商家编码"]', 'input[placeholder*="编码"]',
      '[class*="code"] input', '#J_OuterCode', 'input[name*="code" i]',
    ];
    for (const sel of sels) {
      try {
        const r = await DOM.fillText(win.webContents, sel, code);
        if (r && r.ok) { log('商家编码已填: ' + code); return; }
      } catch (_) {}
    }
    log('商家编码输入框未找到（类目可能无此项，跳过）');
  }

  /** 步骤7.5c: 商品属性（新版必填属性下拉逐项选择）
   *  先点「一键采纳推荐值」（自动填能填的），再对剩余必填项逐项下拉选第一个可用值
   */
  /**
   * 1688属性名 → 淘宝属性名 映射表
   * key=淘宝属性label, value=1688采集数据中对应的属性名列表（按优先级）
   */
  static ATTR_MAP = {
    '面料':       ['面料成分', '面料名称', '主面料成分', '主面料成分2'],
    '材质成分':   ['材质成分', '主面料成分', '主面料成分2', '面料成分', '成分含量'],
    '风格':       ['风格类型', '风格'],
    '裙型':       ['裙型'],
    '适用场景':   ['适用场景'],
    '适用人群':   ['适用人群'],
    '袖长':       ['袖长', '袖型'],
    '上市年份季节': ['上市年份/季节', '上市年份季节'],
    '领型':       ['领型'],
    '腰型':       ['腰型'],
    '版型':       ['版型'],
    '裙长':       ['裙长'],
    '工艺':       ['工艺'],
    '图案':       ['图案'],
    '流行元素':   ['流行元素'],
  };

  /** 标题关键词 → 属性值兜底映射（当1688无属性时从标题提取） */
  static TITLE_KW_MAP = {
    '裙型': { '包臀': '包臀裙', 'A字': 'A字裙', '百褶': '百褶裙', '蛋糕': '蛋糕裙', '鱼尾': '鱼尾裙', '衬衫': '衬衫裙' },
    '袖长': { '无袖': '无袖', '短袖': '短袖', '长袖': '长袖', '吊带': '吊带/背心', '七分袖': '七分袖' },
    '领型': { 'V领': 'V领', 'U领': 'U字领', '圆领': '圆领', '方领': '方领', '一字领': '一字领', '翻领': '翻领' },
    '腰型': { '高腰': '高腰', '中腰': '中腰', '低腰': '低腰', '收腰': '收腰' },
    '风格': { '纯欲': '纯欲', '法式': '法式', '韩系': '韩系', '休闲': '休闲', '通勤': '通勤', '甜美': '甜美', '复古': '复古', '名媛': '名媛' },
  };

  /** 从采集数据+标题提取属性值 */
  _resolveAttr(taobaoLabel, goods) {
    const attrs = (goods.raw && goods.raw.attributes) || {};
    const title = goods.title || goods.publishTitle || '';
    const map = Publisher.ATTR_MAP[taobaoLabel];
    // 1. 从1688采集属性直接取
    if (map) {
      for (const k of map) {
        if (attrs[k] && attrs[k].trim()) return attrs[k].trim();
      }
    }
    // 2. 从标题关键词提取
    const kwMap = Publisher.TITLE_KW_MAP[taobaoLabel];
    if (kwMap) {
      for (const [kw, val] of Object.entries(kwMap)) {
        if (title.includes(kw)) return val;
      }
    }
    return null;
  }

  async _stepProps(win, goods, log) {
    // 1. 一键采纳推荐值（若存在）
    const acc = await DOM.evalInPage(win.webContents, `
      return (function(){
        const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '一键采纳推荐值');
        if (!b) return 'no-btn';
        b.scrollIntoView({ block: 'center' });
        b.click();
        return 'ok';
      })()
    `).catch(() => 'err');
    if (acc === 'ok') { log('已点击一键采纳推荐值'); await DOM.sleep(4000); }

    // 2. 获取所有必填属性行
    const rows = await DOM.evalInPage(win.webContents, `
      return JSON.stringify(Array.from(document.querySelectorAll('[id^="sell-field-p-"]')).map(r => {
        const label = (r.querySelector('.sell-component-info-wrapper-label') || {}).textContent || '';
        const required = !!(r.querySelector('.sell-component-info-wrapper-required'));
        const select = r.querySelector('.next-select-trigger, [class*="select"]');
        const input = r.querySelector('input:not([type=radio]):not([type=checkbox])');
        return { id: r.id, label: label.trim().slice(0, 20), required, hasSelect: !!select, selText: select ? (select.textContent || '').trim().slice(0, 12) : '', hasInput: !!input };
      }).filter(x => x.required && (x.hasSelect || x.hasInput)))
    `).catch(() => '[]');
    let list = [];
    try { list = JSON.parse(rows); } catch (_) {}
    log('必填属性项: ' + list.map(x => x.label).join('/') || '无');

    // 3. 逐项处理：从采集数据/标题提取值 → 匹配下拉选项；无值时选第一项兜底
    for (const it of list) {
      // 已填（select 文本非"请选择"或输入框非空）则跳过
      if (it.hasSelect && !/请选择/.test(it.selText || '')) continue;

      // 从采集数据提取期望值
      const want = this._resolveAttr(it.label, goods);
      log('属性[' + it.label + '] 期望值: ' + (want || '无(兜底选第一项)'));

      if (it.hasSelect) {
        // 下拉型：点触发器 → 等弹出层 → CDP 真实点击选项
        // 先关闭可能残留的弹出层
        await DOM.evalInPage(win.webContents, `document.body.click()`).catch(() => {});
        await DOM.sleep(500);

        // 点开下拉
        await DOM.evalInPage(win.webContents, `
          (function(){
            const row = document.getElementById(${JSON.stringify(it.id)});
            if (!row) return;
            const trig = row.querySelector('.next-select-trigger');
            if (trig) { trig.scrollIntoView({ block: 'center' }); trig.click(); }
          })()
        `).catch(() => {});

        // 等待弹出层出现并获取选项坐标（轮询3秒）
        let optInfo = null;
        for (let wait = 0; wait < 6; wait++) {
          await DOM.sleep(500);
          optInfo = await DOM.evalInPage(win.webContents, `
            return (function(){
              // 2026新版弹层class兼容：sell-o-select-options / next-select-popup / next-menu / role=option
              const boxes = Array.from(document.querySelectorAll('.sell-o-select-options, .next-select-popup, .next-select-menu, .next-menu[class*="select"], [class*="select-options"], [class*="select-popup"], [role="listbox"], .next-overlay-inner .next-menu')).filter(b => b.offsetParent !== null);
              const optBox = boxes[0];
              if (!optBox) return null;
              const sels = '.options-item, .next-menu-item, [class*="options-item"], [class*="menu-item"], [role="option"]';
              let items = Array.from(optBox.querySelectorAll(sels));
              // 精确class全无 → 退化取弹层直接叶子元素（仅当叶子自身是短文本且无嵌套选项）
              if (!items.length) {
                items = Array.from(optBox.querySelectorAll('li, div, span')).filter(e =>
                  !e.querySelector(sels) && e.children.length <= 2 && (e.textContent || '').trim().length < 40
                );
              }
              items = items.filter(e =>
                e.offsetParent !== null && (e.textContent || '').trim() && (e.textContent || '').trim().length < 40
              );
              if (!items.length) return null;
              const want = ${JSON.stringify(want || '')};
              let target = null;
              if (want) {
                target = items.find(e => (e.textContent || '').trim().includes(want));
                if (!target) target = items.find(e => want.includes((e.textContent || '').trim()));
                if (!target) {
                  const wantKeys = want.split(/[\/（(、,，\\s]+/).filter(k => k.length > 1);
                  target = items.find(e => {
                    const t = (e.textContent || '').trim();
                    return wantKeys.some(k => t.includes(k) || k.includes(t));
                  });
                }
              }
              if (!target) target = items[0];
              const r = target.getBoundingClientRect();
              return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: target.textContent.trim().slice(0, 15), count: items.length });
            })()
          `).catch(() => null);
          if (optInfo) { try { optInfo = JSON.parse(optInfo); } catch(_) {} break; }
        }

        if (optInfo && optInfo.x) {
          // 用 CDP 真实鼠标点击选项
          const dbg = win.webContents.debugger;
          try { dbg.attach('1.3'); } catch (_) {}
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: optInfo.x, y: optInfo.y }).catch(() => {});
          await DOM.sleep(200);
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: optInfo.x, y: optInfo.y, button: 'left', clickCount: 1 });
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: optInfo.x, y: optInfo.y, button: 'left', clickCount: 1 });
          log('属性[' + it.label + ']: picked:' + optInfo.text + ' (' + optInfo.count + '项)');
        } else {
          // 兜底：JS 点击
          const fallback = await DOM.evalInPage(win.webContents, `
            return (function(){
              const boxes = Array.from(document.querySelectorAll('.sell-o-select-options, .next-select-popup, .next-select-menu, .next-menu[class*="select"], [class*="select-options"], [class*="select-popup"], [role="listbox"], .next-overlay-inner .next-menu')).filter(b => b.offsetParent !== null);
              const optBox = boxes[0];
              if (!optBox) return 'no-popup';
              const sels = '.options-item, .next-menu-item, [class*="options-item"], [class*="menu-item"], [role="option"]';
              let items = Array.from(optBox.querySelectorAll(sels)).filter(e => e.offsetParent !== null);
              if (!items.length) items = Array.from(optBox.querySelectorAll('li, div, span')).filter(e => !e.querySelector(sels) && e.children.length <= 2);
              items = items.filter(e => (e.textContent || '').trim() && (e.textContent || '').trim().length < 40);
              if (!items.length) return 'no-items';
              const want = ${JSON.stringify(want || '')};
              let target = want ? items.find(e => (e.textContent || '').trim().includes(want)) : null;
              if (!target) target = items[0];
              target.click();
              return 'js-picked:' + target.textContent.trim().slice(0, 15);
            })()
          `).catch(() => 'err');
          log('属性[' + it.label + ']: ' + fallback);
        }
      } else if (it.hasInput) {
        // 输入型：用 React 兼容方式填充
        const v = want || '其他';
        const fillResult = await DOM.evalInPage(win.webContents, `
          return (function(){
            const row = document.getElementById(${JSON.stringify(it.id)});
            if (!row) return 'no-row';
            const inp = row.querySelector('input:not([type=radio]):not([type=checkbox])');
            if (!inp) return 'no-input';
            inp.focus();
            const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            proto.call(inp, ${JSON.stringify(v)});
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('blur', { bubbles: true }));
            return 'filled:' + inp.value;
          })()
        `).catch(() => 'err');
        log('属性[' + it.label + ']: ' + fillResult);
      }
      await DOM.sleep(1000);
    }

    // 4. 材质成分特殊处理：如果是吊牌图片上传（OCR），无标准表单，尝试找"添加材质成分"按钮或跳过
    const matRow = await DOM.evalInPage(win.webContents, `
      return (function(){
        var row = document.getElementById('sell-field-p-149422948');
        if (!row) return null;
        // 检查是否有"添加材质成分"按钮或可点击的占位区
        var addBtn = row.querySelector('[class*="add"], [class*="material-item"]:not(.image-empty)');
        var hasOcr = row.querySelector('.image-uploader, .ocr-image-upload-wrap');
        return JSON.stringify({ hasOcr: !!hasOcr, hasAdd: !!addBtn });
      })()
    `).catch(() => null);
    if (matRow) {
      try {
        const mat = JSON.parse(matRow);
        if (mat.hasOcr) {
          log('材质成分为吊牌OCR上传，跳过（不影响其他属性）');
          // 不阻断流程，后续提交如报错则提示用户手动上传
        }
      } catch (_) {}
    }
  }

  /** 步骤7.5d: 物流服务（发货地radio + 提取方式checkbox + 运费模板） */
  async _stepShipArea(win, log) {
    // 发货地：选「大陆及港澳台」
    const area = await DOM.evalInPage(win.webContents, `
      return (function(){
        const row = document.getElementById('sell-field-shippingArea');
        if (!row) return 'no-row';
        const rb = row.querySelector('.next-radio-label');
        if (!rb) return 'no-radio';
        rb.click();
        return 'ok';
      })()
    `).catch(() => 'err');
    if (area === 'ok') log('发货地已选: 大陆及港澳台');
    await DOM.sleep(1200);

    // 提取方式：勾选「使用物流配送」（React 受控 checkbox 需点 .next-checkbox-wrapper）
    const ext = await DOM.evalInPage(win.webContents, `
      return (function(){
        const row = document.getElementById('sell-field-tbExtractWay');
        if (!row) return 'no-row';
        // 找"使用物流配送"的 checkbox wrapper
        const wrapper = Array.from(row.querySelectorAll('.next-checkbox-wrapper')).find(w =>
          (w.textContent || '').indexOf('使用物流配送') >= 0 && !w.classList.contains('disabled')
        );
        if (!wrapper) return 'no-cb';
        // 如果已 checked 则先取消再勾选（强制触发 React onChange）
        if (wrapper.classList.contains('checked')) {
          wrapper.click();
        }
        wrapper.click();
        return 'ok';
      })()
    `).catch(() => 'err');
    if (ext === 'ok') log('提取方式已选: 使用物流配送');
    await DOM.sleep(1200);
  }

  /** 步骤8: 提交（支持放入仓库） */
  async _stepSubmit(win, log, uploadMode = 'warehouse') {
    await this._guardVerification(win, log);

    // 0. 新版上架时间 radio：warehouse→「放入仓库」；direct→「立刻上架」
    const timeRadio = await DOM.evalInPage(win.webContents, `
      return (function(){
        const want = ${JSON.stringify(uploadMode === 'direct' ? '立刻上架' : '放入仓库')};
        const labels = Array.from(document.querySelectorAll('label, [class*="radio-label"], [class*="radio"] span'));
        const hit = labels.find(l => (l.textContent || '').trim() === want && l.offsetParent !== null);
        if (hit) { hit.click(); return 'ok'; }
        // 兜底：文本匹配
        const all = Array.from(document.querySelectorAll('span, div')).filter(e => (e.textContent || '').trim() === want && e.offsetParent !== null && e.children.length === 0);
        if (all.length) { all[0].click(); return 'ok'; }
        return 'no-radio';
      })()
    `).catch(() => 'err');
    if (timeRadio === 'ok') log(`上架时间已选: ${uploadMode === 'direct' ? '立刻上架' : '放入仓库'}`);
    await DOM.sleep(1000);

    // 1. 提交按钮（新版为「提交宝贝信息」）
    const buttonTexts = ['提交宝贝信息', '提交宝贝', '直接上架', '放入仓库', '确 定', '发布'];
    let clicked = false;
    let clickedText = '';
    for (const t of buttonTexts) {
      try {
        await DOM.clickByText(win.webContents,
          'button, [class*="submit"], [class*="btn"], a',
          t, { timeoutMs: 4000, exact: true });
        clicked = true;
        clickedText = t;
        break;
      } catch (_) {}
    }
    if (!clicked) throw new Error('提交按钮未找到');

    // 等待结果：成功页 or 错误提示（仓库模式成功的标志不同）
    const start = Date.now();
    while (Date.now() - start < 60000) {
      await DOM.sleep(2000);
      const r = await DOM.evalInPage(win.webContents, `
        const url = location.href;
        const text = (document.body.innerText || '').slice(0, 3000);
        // 成功判定：发布成功页 / 仓库管理页 / 成功提示
        if (/publishSuccess|itemmanage|发布成功|恭喜|已成功|仓库中/.test(url) || /发布成功|恭喜|已成功放入|已加入仓库/.test(text)) {
          return { done: 'success' };
        }
        // 新版校验错误面板：sell-struct-error-board / assistant 错误(数字)
        const errBoard = document.querySelector('.sell-struct-error-board, [class*="assistant-error"], [class*="error-board"]');
        if (errBoard && /错误|必填|不能为空|请填写/.test(errBoard.innerText || '')) {
          return { done: 'error', msg: (errBoard.innerText || '').trim().slice(0, 300) };
        }
        // 旧版错误
        const err = document.querySelector('[class*="error"], .field-error, [class*="tips"]');
        if (err && (err.innerText || '').trim() && /失败|错误|不能|请填写|必填/.test(err.innerText)) {
          return { done: 'error', msg: err.innerText.trim().slice(0, 200) };
        }
        // URL跳转到管理页也算成功
        if (/itemmanage|publishSuccess|sellermanage/.test(location.href)) return { done: 'success' };
        return { done: null };
      `);
      if (r && r.done === 'success') {
        // 尝试提取宝贝链接
        const itemUrl = await DOM.evalInPage(win.webContents, `
          const a = document.querySelector('a[href*="item.taobao.com"], a[href*="world.taobao.com/item"], a[href*=".tmall.com"]');
          return a ? a.href : '';
        `).catch(() => '');
        log(`上传成功（${uploadMode === 'direct' ? '直接上架' : '放入仓库'}，按钮: ${clickedText}）`);
        return { ok: true, itemUrl };
      }
      if (r && r.done === 'error') throw new Error('发布被拦截: ' + r.msg);
      await this._guardVerification(win, log);
    }
    throw new Error('提交后60秒未检测到成功/失败结果（可能仍在上传或需要人工查看）');
  }
}

module.exports = Publisher;
