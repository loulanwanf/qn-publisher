/**
 * 数据存储：JSON 文件持久化（账号/商品/配置/队列/每日风控计数）
 * 目录: userData/data/
 *   settings.json     全局配置（价格策略/违禁词/模板/节奏）
 *   accounts.json     账号列表
 *   goods.json        商品库
 *   queue.json        任务队列
 *   counters.json     每日上架计数（风控限量用）
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  // ---------- 采集 ----------
  collect: {
    // 筛选
    onlyFenxiao: false,        // 不强制一件代发（用户以"起批量≤N"筛选替代）
    onlyYanxuan: false,         // 只采集1688严选
    priceMin: null,             // 默认价格区间下限（元，null=不限）
    priceMax: null,             // 默认价格区间上限
    // 图片下载
    downloadImages: true,       // 下载主图（上架必须）
    downloadDetail: true,       // 下载详情图
    // 采集节奏（防限流）
    maxPages: 10,               // 单次采集页数上限
    pageDelay: [1500, 3500],    // 翻页间隔毫秒（随机区间）
    detailScrollWait: 3000,     // 详情页滚动等待毫秒
    // 失败处理
    retryEmpty: true,           // 空结果自动重试（1688偶发限流）
    retryTimes: 2,              // 重试次数
    fenzhaoLevel: 0,
  },
  // ---------- 标题 ----------
  title: {
    removeWords: ['批发', '代理', '招商', '厂家直销', '源头工厂', '一件代发', '义乌', '跨境外贸', '地摊', '尾货', '处理品', '库存'],
    limit: 30,
    template: '{title}',
    addPrefix: '',
    addSuffix: '',
  },
  // ---------- 价格 ----------
  price: {
    source: 'original',         // original=起批价 | max=区间最高价
    mode: 'percent',            // percent | fixed | stepped
    percent: 35,
    fixed: 5,
    minProfit: 3,
    roundRule: 'yuan9',
    floorPrice: 2,               // 淘宝最低限价（元），低于此价触发 floorAction
    floorAction: 'raise',        // 低于限价时 raise=抬价 | skip=跳过
    stepped: [
      { max: 10, percent: 50 },
      { max: 50, percent: 30 },
      { max: 200, percent: 22 },
      { max: Infinity, percent: 15 },
    ],
  },
  // ---------- 商品模板 ----------
  template: {
    category: '',               // 类目关键词
    shipTemplate: '',           // 运费模板名
    returnAddress: '',          // 退货地址名
    location: '',
    sevenDayReturn: true,
    stock: 99,
    delayHours: 0,
  },
  // ---------- 图片设置 ----------
  image: {
    mainCount: 5,               // 主图数量
    detailCount: 20,            // 详情图数量（0=不上传）
    mainAppendDetail: true,     // 主图追加到详情页首
  },
  // ---------- 高级（上传行为） ----------
  advanced: {
    uploadMode: 'warehouse',    // warehouse=放入仓库 | direct=直接上架
    windowMode: 'quiet',        // quiet=后台静默（需人工时才弹窗） | visible=始终显示窗口
    merchantCode: 'offerId',    // offerId=用1688宝贝ID做商家编码 | none
    brandMode: 'other',         // other | keep | custom
    brandCustom: '',
    brandRandom: true,          // 品牌失败随机品牌
    enableDetailImages: true,
    keepWindowVisible: false,
  },
  // ---------- 风控节奏 ----------
  pace: {
    dailyLimit: 30,
    minGap: 45,
    maxGap: 180,
  },
  // ---------- 违禁词 ----------
  risk: {
    blockWords: ['最便宜', '最低价', '第一品牌', '国家级', '顶级', '极品', '万能', '秒杀全网', '全网最低', '绝无仅有', '史无前例', '独家', '首个', '首选', '王牌', '冠军品牌', '永久', '百分百', '纯天然', '祖传', '特效', '根治'],
    replaceMap: { '第一': '优选', '顶级': '精选', '极品': '优选', '最好': '优选', '绝对': '非常', '秒杀': '热卖' },
  },
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.imgDir = path.join(dir, 'images');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.imgDir, { recursive: true });
    this.files = {
      settings: path.join(dir, 'settings.json'),
      accounts: path.join(dir, 'accounts.json'),
      goods: path.join(dir, 'goods.json'),
      queue: path.join(dir, 'queue.json'),
      counters: path.join(dir, 'counters.json'),
      shops: path.join(dir, 'shops.json'),
      records: path.join(dir, 'records.json'),
      sellerInfo: path.join(dir, 'sellerInfo.json'),
      suppliers: path.join(dir, 'suppliers.json'),
    };
    this.settings = this._load(this.files.settings, DEFAULT_SETTINGS);
    this.accounts = this._load(this.files.accounts, []);
    this.goods = this._load(this.files.goods, []);
    this.queue = this._load(this.files.queue, []);
    this.counters = this._load(this.files.counters, {});
    this.shops = this._load(this.files.shops, []);
    this.records = this._load(this.files.records, []);
    this.sellerInfo = this._load(this.files.sellerInfo, { shipTemplates: [], returnAddresses: [], shopName: '', fetchedAt: null });
    this.suppliers = this._load(this.files.suppliers, []);
    this._saveTimer = null;
    // 启动时自动备份（每天最多一份，保留最近7份）
    this._autoBackup();
  }

  /** 数据自动备份：启动时若有数据变更文件则做一次快照，保留最近 MAX_BACKUPS 份 */
  _autoBackup() {
    try {
      const MAX = 7;
      fs.mkdirSync(this.backupDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      // 今天已备份过则跳过（启动多次不重复）
      if (fs.existsSync(path.join(this.backupDir, today))) return;
      // 有真实数据才备份（首次运行空数据不必要）
      const hasData = Object.keys(this.files).some(k => {
        try { const st = fs.statSync(this.files[k]); return st.size > 0; } catch (_) { return false; }
      });
      if (!hasData) return;
      const dir = path.join(this.backupDir, today);
      fs.mkdirSync(dir, { recursive: true });
      for (const k of Object.keys(this.files)) {
        const src = this.files[k];
        try {
          if (fs.existsSync(src)) {
            const st = fs.statSync(src);
            if (st.size > 0) fs.copyFileSync(src, path.join(dir, path.basename(src)));
          }
        } catch (_) {}
      }
      // 清理超出保留数量的历史备份
      const all = fs.readdirSync(this.backupDir).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
      while (all.length > MAX) {
        const rm = all.shift();
        try { fs.rmSync(path.join(this.backupDir, rm), { recursive: true, force: true }); } catch (_) {}
      }
    } catch (_) {}
  }

  /** 手动立即备份（返回备份目录路径或 null） */
  backupNow() {
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const dir = path.join(this.backupDir, stamp);
      fs.mkdirSync(dir, { recursive: true });
      for (const k of Object.keys(this.files)) {
        try {
          if (fs.existsSync(this.files[k])) fs.copyFileSync(this.files[k], path.join(dir, path.basename(this.files[k])));
        } catch (_) {}
      }
      return dir;
    } catch (_) { return null; }
  }

  /** 列出可用备份目录（含日期），供恢复/查看 */
  listBackups() {
    try {
      if (!fs.existsSync(this.backupDir)) return [];
      return fs.readdirSync(this.backupDir)
        .filter(n => /^\d{4}-\d{2}-\d{2}/.test(n))
        .sort().reverse();
    } catch (_) { return []; }
  }

  _load(file, fallback) {
    try {
      if (!fs.existsSync(file)) return structuredClone(fallback);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // 损坏则备份后重建
      try { fs.copyFileSync(file, file + '.bak-' + Date.now()); } catch (_) {}
      return structuredClone(fallback);
    }
  }

  _save(file, data) {
    // 防抖批量写
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushSave();
    }, 800);
  }

  /** 立即同步落盘全部数据（退出应用时调用，防止防抖中的改动丢失） */
  flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      this._save(this.files.settings, this.settings);
      this._save(this.files.accounts, this.accounts);
      this._save(this.files.goods, this.goods);
      this._save(this.files.queue, this.queue);
      this._save(this.files.counters, this.counters);
      this._save(this.files.shops, this.shops);
      this._save(this.files.records, this.records);
      this._save(this.files.sellerInfo, this.sellerInfo);
      this._save(this.files.suppliers, this.suppliers);
    } catch (e) { console.error('flush save failed', e); }
  }

  // ---------- settings ----------
  getSettings() { return this.settings; }
  saveSettings(patch) {
    this.settings = deepMerge(structuredClone(this.settings), patch || {});
    this._debounceSave();
    return this.settings;
  }

  // ---------- accounts ----------
  saveAccounts() { this._debounceSave(); }

  // ---------- goods ----------
  listGoods(filter = {}) {
    let list = this.goods;
    if (filter.status) list = list.filter(g => g.status === filter.status);
    if (filter.keyword) {
      const k = filter.keyword.toLowerCase();
      list = list.filter(g => (g.title || '').toLowerCase().includes(k) || (g.offerId || '').includes(k));
    }
    const { page = 1, pageSize = 50 } = filter;
    const total = list.length;
    const start = (page - 1) * pageSize;
    return { total, page, pageSize, items: list.slice(start, start + pageSize) };
  }

  updateGoods(id, patch) {
    const g = this.goods.find(x => x.id === id);
    if (g) Object.assign(g, patch, { updatedAt: Date.now() });
    this._debounceSave();
    return g;
  }

  removeGoods(id) {
    this.goods = this.goods.filter(x => x.id !== id);
    this.queue = this.queue.filter(x => x.goodsId !== id);
    this._debounceSave();
    return true;
  }

  clearGoods(status) {
    if (status) this.goods = this.goods.filter(g => g.status !== status);
    else this.goods = [];
    this._debounceSave();
    return true;
  }

  addGoods(items) {
    const now = Date.now();
    for (const it of items) {
      const exist = this.goods.find(g => g.offerId === it.offerId);
      if (exist) continue;
      this.goods.push({
        id: 'g' + now + '-' + Math.random().toString(36).slice(2, 8),
        offerId: it.offerId,
        source: '1688',
        raw: it,
        title: it.title || '',
        status: 'pending',     // pending | queued | publishing | published | failed | skipped
        sellPrice: null,
        createdAt: now,
        updatedAt: now,
        error: null,
        publishLog: [],
      });
    }
    this._debounceSave();
    return true;
  }

  goodsById(id) { return this.goods.find(g => g.id === id); }
  goodsByOffer(offerId) { return this.goods.find(g => g.offerId === offerId); }

  exportGoodsCsv(filePath) {
    const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
    const head = ['ID', '1688货号', '标题', '成本价', '售价', '状态', '错误', '创建时间'];
    const rows = this.goods.map(g => [
      g.id, g.offerId, g.title,
      g.raw && g.raw.price != null ? g.raw.price : '',
      g.sellPrice != null ? g.sellPrice : '',
      g.status, g.error || '',
      new Date(g.createdAt).toLocaleString('zh-CN'),
    ]);
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    fs.writeFileSync(filePath, csv);
    return { count: rows.length, path: filePath };
  }

  // ---------- queue ----------
  saveQueue() { this._debounceSave(); }

  // ---------- 每日计数（风控限量） ----------
  todayKey() { return new Date().toISOString().slice(0, 10); }
  todayCount() { return this.counters[this.todayKey()] || 0; }
  incTodayCount() {
    const k = this.todayKey();
    this.counters[k] = (this.counters[k] || 0) + 1;
    this._debounceSave();
    return this.counters[k];
  }

  // ---------- 店铺管理（历史采集店铺） ----------
  recordShop({ shopUrl, name, goodsCount }) {
    if (!shopUrl) return;
    // 归一化店铺URL（去参数）
    const key = String(shopUrl).split('?')[0].replace(/\/$/, '');
    let s = this.shops.find(x => x.shopUrl.split('?')[0].replace(/\/$/, '') === key);
    if (s) {
      if (name) s.name = name;
      if (goodsCount) s.goodsCount = goodsCount;
      s.lastCollectAt = Date.now();
    } else {
      this.shops.push({
        id: 'shop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        shopUrl: key,
        name: name || '未命名店铺',
        goodsCount: goodsCount || 0,
        lastCollectAt: Date.now(),
      });
    }
    this._debounceSave();
  }
  listShops() { return this.shops.slice().sort((a, b) => (b.lastCollectAt || 0) - (a.lastCollectAt || 0)); }
  removeShop(id) {
    this.shops = this.shops.filter(s => s.id !== id);
    this._debounceSave();
    return true;
  }

  // ---------- 上传记录 ----------
  addRecord(rec) {
    // rec: { goodsId, offerId, title, ok, error, itemUrl }
    this.records.push({ ...rec, at: Date.now() });
    if (this.records.length > 500) this.records = this.records.slice(-500);
    this._debounceSave();
  }
  listRecords(n = 100) { return this.records.slice(-n).reverse(); }

  // ---------- 供应商管理（退货地址/失联下架） ----------
  /** 列出所有供应商，附带已铺商品数 */
  listSuppliers() {
    // 从商品库统计每家供应商已铺商品数
    const countMap = {};
    for (const g of this.goods) {
      const uid = g.raw && g.raw.supplierUserId;
      if (!uid) continue;
      countMap[uid] = (countMap[uid] || 0) + 1;
    }
    return this.suppliers.map(s => ({
      ...s,
      goodsCount: countMap[s.supplierUserId] || 0,
    })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 按 supplierUserId 查供应商（内部用） */
  findSupplier(userId) {
    if (!userId) return null;
    return this.suppliers.find(s => s.supplierUserId === String(userId));
  }

  /** 新增/更新供应商（按 supplierUserId 去重）
   * data: { supplierUserId, shopName, returnAddress(地址库名称), returnAddressDetail(完整退货信息), status, note }
   */
  upsertSupplier(data) {
    if (!data || !data.supplierUserId) return null;
    const uid = String(data.supplierUserId);
    let s = this.suppliers.find(x => x.supplierUserId === uid);
    if (s) {
      if (data.shopName !== undefined) s.shopName = data.shopName;
      if (data.returnAddress !== undefined) s.returnAddress = data.returnAddress;
      if (data.returnAddressDetail !== undefined) s.returnAddressDetail = data.returnAddressDetail;
      if (data.status !== undefined) s.status = data.status;
      if (data.note !== undefined) s.note = data.note;
      s.updatedAt = Date.now();
    } else {
      s = {
        id: 'sup-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        supplierUserId: uid,
        shopName: data.shopName || '',
        returnAddress: data.returnAddress || '',
        returnAddressDetail: data.returnAddressDetail || '',
        status: data.status || 'active',   // active | ghost(失联)
        note: data.note || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.suppliers.push(s);
    }
    this._debounceSave();
    return s;
  }

  /** 删除供应商 */
  removeSupplier(id) {
    this.suppliers = this.suppliers.filter(s => s.id !== id);
    this._debounceSave();
    return true;
  }

  /** 找出指定供应商所有已发布商品的 numIid（从 records + goods 汇总）
   *  返回 numIid 数组（去空去重）
   */
  getItemIdsBySupplier(supplierUserId) {
    if (!supplierUserId) return [];
    const uid = String(supplierUserId);
    // 从发布记录找：有 ok=true 且 offerId 匹配的
    const offerIds = new Set();
    for (const g of this.goods) {
      if (g.raw && String(g.raw.supplierUserId) === uid && g.offerId) {
        offerIds.add(String(g.offerId));
      }
    }
    const itemIds = new Set();
    for (const r of this.records) {
      if (!r.ok || !r.itemUrl) continue;
      // itemUrl 格式: https://item.taobao.com/item.htm?id=123456 或 https://detail.tmall.com/item.htm?id=xxx
      const m = String(r.itemUrl).match(/[?&]id=(\d+)/);
      if (!m) continue;
      // 匹配 offerId
      if (r.offerId && offerIds.has(String(r.offerId))) {
        itemIds.add(m[1]);
      }
    }
    return [...itemIds];
  }

  /** 标记供应商失联，并把该供应商所有已发布商品标记为 needsDelist */
  markSupplierGhost(id) {
    const s = this.suppliers.find(x => x.id === id);
    if (!s) return null;
    s.status = 'ghost';
    s.updatedAt = Date.now();
    // 把该供应商的商品标记为待下架
    const uid = s.supplierUserId;
    let n = 0;
    for (const g of this.goods) {
      if (g.raw && String(g.raw.supplierUserId) === uid) {
        g.needDelist = true;
        n++;
      }
    }
    this._debounceSave();
    return { supplier: s, markedCount: n };
  }
}

function deepMerge(target, src) {
  for (const k of Object.keys(src || {})) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
  return target;
}

module.exports = Store;
