/**
 * 1688 采集引擎
 * 支持入口：
 *   - 店铺首页/全部商品页 (shop*.1688.com)
 *   - 店铺内分类页 (任意 *.1688.com 列表URL)
 *   - 搜索结果页 (s.1688.com/selloffer/...)
 * 两阶段：
 *   1. preview: 翻页收集商品链接(offerId+标题+价格)，不抓详情，快速预览
 *   2. collect: 对选中商品抓完整详情(标题/主图/SKU/价格/详情图/一件代发标志)
 * 提取策略：window.__INIT_DATA__ 全局数据优先，DOM 兜底，均失败留存证快照
 */
const DOM = require('./dom');
const iconv = require('iconv-lite');
const { EventEmitter } = require('events');
const { Slider } = require('./slider');

const OFFER_LINK_RE = /1688\.com\/offer\/(\d{6,})\.html/;
const MAX_PAGES_DEFAULT = 10;

class Collector extends EventEmitter {
  constructor({ accounts, store, logger, media }) {
    super();
    this.accounts = accounts;
    this.store = store;
    this.logger = logger;
    this.media = media;
  }

  /** 上报细分进度 { key, title, detail, percent, done, error } */
  _prog(p) { try { this.emit('progress', p); } catch (_) {} }

  /** 取一个可用采集账号并打开工作窗口；没有登录账号时用默认 session 游客采集 */
  async _session() {
    const acc = this.accounts.getWorking1688();
    const visible = (this.store.settings.advanced || {}).windowMode === 'visible';
    if (acc) {
      const win = await this.accounts.getWorkWindow(acc, { show: visible });
      this._attachStealth(win);
      return { acc, win, isGuest: false };
    }
    // 游客模式：用默认 session 的隐藏窗口
    if (!this._guestWin || this._guestWin.isDestroyed()) {
      const { BrowserWindow, session } = require('electron');
      const sess = session.defaultSession;
      sess.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'zh-CN,zh;q=0.9'
      );
      this._guestWin = new BrowserWindow({
        width: 1200, height: 860, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      this._guestWin.setMenuBarVisibility(false);
      this._guestWin.on('closed', () => { this._guestWin = null; });
    }
    this._attachStealth(this._guestWin);
    this.logger.warn('collect', '无采集账号登录态，使用游客模式采集（1688部分信息可能受限）');
    return { acc: { name: '游客模式' }, win: this._guestWin, isGuest: true };
  }

  /** 退出应用时销毁游客采集窗口（登录账号窗口由 accounts.destroyAllWindows 统一销毁） */
  destroyWindows() {
    if (this._guestWin && !this._guestWin.isDestroyed()) {
      try { this._guestWin.destroy(); } catch (_) {}
    }
    this._guestWin = null;
  }

  /** 在窗口的 webContents 上挂反检测注入（每次页面开始加载时注入） */
  _attachStealth(win) {
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc._stealthAttached) return;
    wc._stealthAttached = true;
    wc.on('did-start-loading', () => {
      wc.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
    });
  }

  async _navTo(win, url, { timeoutMs = 45000, needLoginHint = false, isGuest = false } = {}) {
    await win.loadURL(url);

    // 等待 URL 稳定：1688 有 login_jump/_____tmd_____ 中转链，必须等它跳完
    const t0 = Date.now();
    let lastUrl = '';
    let stableSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      await DOM.sleep(1000);
      const cur = win.webContents.getURL();
      const now = Date.now();
      if (cur === lastUrl) {
        if (stableSince && now - stableSince >= 2500) break; // URL 稳定2.5秒
      } else {
        lastUrl = cur;
        stableSince = now;
      }
      // 中转链中的 URL 不算稳定
      if (/_____tmd_____/.test(lastUrl)) stableSince = 0;
    }
    await DOM.waitLoadStop(win.webContents, 10000).catch(() => {});
    // 注入反检测
    await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
    // 等待 SPA 渲染（1688 React 应用渲染需要1~3秒）
    await DOM.sleep(2000);

    const cur = () => win.webContents.getURL();
    // 若被踢到登录页：重试导航（cookie 还在时通常重试即过）
    let retries = 0;
    while ((/login\.1688\.com/.test(cur()) || /_____tmd_____.*login/.test(cur())) && retries < 2) {
      retries++;
      this.logger.warn('collect', `被跳转到1688登录/验证页，重试导航(${retries}/2)…`);
      await DOM.sleep(2500);
      await win.loadURL(url);
      await DOM.waitLoadStop(win.webContents, timeoutMs);
      await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
      await DOM.sleep(2500);
    }
    if (/login\.1688\.com/.test(cur())) {
      if (isGuest) {
        this.logger.warn('collect', '该页面需要登录才能查看，跳过（游客模式）');
        return false;
      }
      // 自动弹出扫码窗口（用户扫码后本次导航继续重试）
      this.logger.warn('collect', '1688登录态失效，自动弹出扫码窗口…');
      const acc = this.accounts.getWorking1688();
      if (acc) {
        try {
          await this.accounts.openLogin(acc.id, null);
          // 登录成功后再试一次导航
          await win.loadURL(url);
          await DOM.waitLoadStop(win.webContents, timeoutMs);
          await DOM.sleep(2000);
          if (!/login\.1688\.com/.test(win.webContents.getURL())) {
            this.logger.success('collect', '重新登录成功，继续采集');
            return true;
          }
        } catch (e) {
          this.logger.error('collect', '重新登录失败: ' + e.message);
        }
      }
      throw new Error('1688登录态失效，请到「账号管理」重新扫码登录');
    }
    // 1688 滑块验证检测：如果出现验证码，弹窗让用户手动过一次
    const passed = await this._guardPunish(win, isGuest);
    if (passed === false) {
      // 验证通过但页面未跳转，重新加载目标页
      this.logger.warn('collect', '滑块验证已通过但页面未跳转，重新加载目标页');
      await DOM.sleep(1500);
      await win.loadURL(url);
      await DOM.waitLoadStop(win.webContents, timeoutMs);
      await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
      // 二次检查：仍拦截则再人工（最多3轮）
      for (let retry = 0; retry < 3; retry++) {
        const p2 = await DOM.evalInPage(win.webContents, `
          document.title.includes('验证') || document.title.includes('拦截') ||
          (document.body && document.body.innerText.includes('滑块') && document.body.innerText.includes('验证'))
        `).catch(() => false);
        if (!p2) return true;
        await this._guardPunish(win, isGuest);
        await win.loadURL(url);
        await DOM.waitLoadStop(win.webContents, timeoutMs);
      }
      throw new Error('多次滑块验证后仍无法访问页面');
    }
    return true;
  }

  /** 检测并处理 1688 滑块验证（punish page） */
  async _guardPunish(win, isGuest) {
    const isPunish = await DOM.evalInPage(win.webContents, `
      document.title.includes('验证') || document.title.includes('拦截') ||
      (document.body && document.body.innerText.includes('滑块') && document.body.innerText.includes('验证'))
    `).catch(() => false);

    if (!isPunish) return;

    if (isGuest) {
      this.logger.warn('collect', '1688要求滑块验证，游客模式无法自动通过，建议添加采集账号并登录');
      throw new Error('1688要求滑块验证，请先在「账号管理」添加采集账号并扫码登录');
    }

    // 第一步：自动滑块（sendInputEvent 真实事件 + 贝塞尔轨迹，全程不弹窗）
    this.logger.info('collect', '检测到1688滑块验证，自动拖动中…');
    this._prog && this._prog({ key: 'slider', title: '滑块验证', detail: '1688要求滑块验证，自动拖动中…' });
    const auto = await Slider.solve(win, this.logger, 'collect');
    if (auto.passed) {
      this.logger.success('collect', `滑块自动验证通过（第${auto.attempt || 1}次）`);
      await DOM.sleep(2500);
      await DOM.waitLoadStop(win.webContents, 15000).catch(() => {});
      const still = await DOM.evalInPage(win.webContents, `
        document.title.includes('验证') || document.title.includes('拦截') ||
        (document.body && document.body.innerText.includes('滑块') && document.body.innerText.includes('验证'))
      `).catch(() => false);
      return !still;
    }

    // 第二步：自动失败才弹窗人工（置顶+聚焦）
    this.logger.warn('collect', '自动滑块未通过，弹出窗口请人工完成验证');
    this._prog && this._prog({ key: 'slider', title: '滑块验证', detail: '自动尝试失败，请人工拖动滑块', done: true, error: true });
    try { win.show(); } catch (_) {}
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
    win.setTitle('【需要人工】1688滑块验证 - 请拖动滑块完成验证（完成后自动继续）');
    win.focus();
    win.webContents.focus();

    // 等待用户过滑块（页面会从验证页跳转到真实内容）
    const start = Date.now();
    let verified = false;
    while (Date.now() - start < 5 * 60 * 1000) {
      await DOM.sleep(2000);
      const stillPunish = await DOM.evalInPage(win.webContents, `
        document.title.includes('验证') || document.title.includes('拦截') ||
        (document.body && document.body.innerText.includes('滑块') && document.body.innerText.includes('验证'))
      `).catch(() => false);
      if (!stillPunish) { verified = true; break; }
    }
    if (!verified) {
      try { win.setAlwaysOnTop(false); } catch (_) {}
      throw new Error('等待人工滑块验证超时(5分钟)');
    }
    try { win.setAlwaysOnTop(false); } catch (_) {}
    win.hide();
    this.logger.success('collect', '滑块验证已通过');
    await DOM.sleep(2500);
    await DOM.waitLoadStop(win.webContents, 15000).catch(() => {});
    // 验证通过后页面应已跳转到真实内容；若仍停在验证页返回false（由调用方重新加载）
    const still = await DOM.evalInPage(win.webContents, `
      document.title.includes('验证') || document.title.includes('拦截') ||
      (document.body && document.body.innerText.includes('滑块') && document.body.innerText.includes('验证'))
    `).catch(() => false);
    return !still;
  }

  /**
   * 关键词采集：1688搜索页 s.1688.com
   * @param params { keyword, pages, priceMin, priceMax, onlyFenxiao, onlyYanxuan }
   */
  async collectByKeyword({ keyword, pages = 3, priceMin, priceMax, onlyFenxiao, onlyYanxuan, sortType }) {
    let { acc, win, isGuest } = await this._session();
    // 采集配置：单次页数上限 clamp
    const ccfg = this.store.settings.collect || {};
    if (ccfg.maxPages) pages = Math.min(pages, ccfg.maxPages);
    // 构造搜索URL（1688 搜索页 keywords 参数按 GBK 编码，UTF-8 会乱码）
    const gbk = (s) => {
      const buf = iconv.encode(String(s), 'gbk');
      let out = '';
      for (const x of buf) out += '%' + x.toString(16).padStart(2, '0').toUpperCase();
      return out;
    };
    const q = [];
    q.push('keywords=' + gbk(keyword));
    if (priceMin) q.push('beginPrice=' + encodeURIComponent(priceMin));
    if (priceMax) q.push('endPrice=' + encodeURIComponent(priceMax));
    if (onlyFenxiao) q.push('f4=y');       // 一件代发筛选
    if (onlyYanxuan) q.push('f10=y');      // 1688严选筛选
    if (sortType) q.push('sortType=' + sortType);   // 排序（如 booked=销量，服务端不生效时由上层本地排序兜底）
    const u = 'https://s.1688.com/selloffer/offer_search.htm?' + q.join('&');
    this.logger.info('collect', `关键词采集: ${keyword} (最多${pages}页)`, { account: acc.name });

    const capture = this._startNetCapture(win);
    const all = new Map();
    let noNew = 0;

    for (let page = 1; page <= pages; page++) {
      this._prog({ key: 'collect-keyword', title: `关键词采集「${keyword.slice(0, 8)}」`, detail: `第 ${page}/${pages} 页，已获取 ${all.size} 条…`, percent: Math.round(((page - 1) / pages) * 100) });
      const pageUrl = page === 1 ? u.toString() : (() => {
        const u2 = new URL(u.toString());
        u2.searchParams.set('beginPage', String(page));
        return u2.toString();
      })();

      // 空结果整页重试（1688搜索页偶发限流返回空，按采集配置重试+换账号）
      const ccfg = this.store.settings.collect || {};
      const retries = (ccfg.retryEmpty === false || isGuest) ? 0 : Math.max(0, ccfg.retryTimes || 2);
      let newCount = 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          this.logger.warn('collect', `第${page}页空结果（疑似限流），${attempt}/${retries} 次重试（换账号）…`);
          this._prog({ key: 'collect-keyword', title: `关键词采集「${keyword.slice(0, 8)}」`, detail: `第 ${page}/${pages} 页空结果，重试 ${attempt}/${retries}…`, percent: Math.round(((page - 1) / pages) * 100) });
          await DOM.sleep(8000 + Math.random() * 6000);
          // 换一个采集账号的窗口
          try {
            const next = this.accounts.getWorking1688();
            if (next && next.id !== acc.id) {
              const nextWin = await this.accounts.getWorkWindow(next, { show: false });
              this._attachStealth(nextWin);
              win = nextWin; acc = next;
            }
          } catch (_) {}
        }
        const navOk = await this._navTo(win, pageUrl, { isGuest });
        if (navOk === false) break;
        await this._scrollForLazy(win, 6);
        let batch = [];
        try {
          let clickItems = await this._extractByClick(win);
          if (!clickItems || !clickItems.length) {
            await DOM.sleep(4000);
            clickItems = await this._extractByClick(win);
          }
          batch = batch.concat(clickItems || []);
        } catch (e) { this.logger.warn('collect', '点击捕获失败: ' + e.message); }
        try {
          const netItems = await capture.extract();
          batch = batch.concat(netItems);
        } catch (_) {}
        // 搜索页卡片是 <a> 结构（offerId 在 detail.m.1688.com?offerId= 参数里），DOM 提取兜底
        try {
          const domItems = await this._extractOfferLinks(win);
          if (domItems && domItems.length) batch = batch.concat(domItems);
        } catch (_) {}
        newCount = 0;
        for (const it of batch) {
          if (it.offerId && !all.has(it.offerId)) { all.set(it.offerId, it); newCount++; }
        }
        if (newCount > 0) break;   // 拿到数据，结束重试循环
      }
      this.logger.info('collect', `关键词第${page}页: 新增${newCount}条, 累计${all.size}条`);
      this._prog({ key: 'collect-keyword', title: `关键词采集「${keyword.slice(0, 8)}」`, detail: `第 ${page}/${pages} 页 ✓ 新增${newCount}条，累计 ${all.size} 条`, percent: Math.round((page / pages) * 100) });
      if (newCount === 0) { noNew++; if (noNew >= 2) break; } else noNew = 0;
      await DOM.sleep(...this.store.settings.collect.pageDelay);
    }
    capture.stop();

    let items = [...all.values()];
    if (onlyFenxiao) items = items.filter(x => x.isFenxiao !== false);
    // 价格过滤（兜底，搜索参数可能未生效）
    if (priceMin != null) items = items.filter(x => x.price == null || x.price >= +priceMin);
    if (priceMax != null) items = items.filter(x => x.price == null || x.price <= +priceMax);
    this.logger.success('collect', `关键词采集完成: ${items.length} 个`);
    return { ok: true, items, account: acc.name, message: `采集到 ${items.length} 个宝贝` };
  }

  /**
   * 验证店铺：打开店铺页，提取店铺名/宝贝数/分类列表
   * 返回 { ok, shopUrl, shopName, goodsCount, categories:[{name,count,url}], offerListUrl }
   */
  async verifyShop(shopUrl) {
    const { acc, win, isGuest } = await this._session();
    // 店铺首页 → offerlist
    let offerListUrl = shopUrl;
    if (/^https:\/\/shop[\w-]+\.1688\.com\/?$/.test(shopUrl)) {
      offerListUrl = shopUrl.replace(/\/$/, '') + '/page/offerlist.htm';
    }
    this.logger.info('collect', `验证店铺: ${shopUrl}`);
    this._prog({ key: 'verify-shop', title: '验证店铺', detail: '打开店铺页…', percent: 20 });
    const navOk = await this._navTo(win, offerListUrl, { isGuest });
    if (navOk === false) return { ok: false, message: '店铺需要登录才能访问' };
    this._prog({ key: 'verify-shop', title: '验证店铺', detail: '读取店铺名/宝贝数/分类…', percent: 60 });
    await this._scrollForLazy(win, 3);
    await DOM.sleep(2000);

    const info = await DOM.evalInPage(win.webContents, `
      const out = { shopName: '', goodsCount: null, categories: [] };
      const hostDomain = location.hostname;
      // 店铺名：多策略（title 前段 / 店铺名元素 / meta），title 通常形如 "店名-全部商品页-1688.com"
      const rawTitle = document.title || '';
      let name = rawTitle.split(/[-_|－–]+/)[0].trim();
      if (!name || name.length < 2) name = rawTitle.replace(/[,，\\s]*(全部商品|首页|阿里巴巴|1688).*$/, '').trim();
      const nameEl = document.querySelector('[class*="shopName"], [class*="shop-name"], .company-name, [class*="companyName"]');
      if (nameEl && (nameEl.innerText || '').trim()) name = nameEl.innerText.trim();
      if (!name && document.querySelector('meta[name="application-name"]')) name = document.querySelector('meta[name="application-name"]').content || '';
      out.shopName = name.slice(0, 40);
      // 宝贝总数：如 "共304件相关产品"
      const cm = (document.body.innerText || '').match(/共\\s*(\\d+)\\s*件/);
      if (cm) out.goodsCount = +cm[1];
      // 分类：如 "连衣裙(276)女式T恤(28)" —— 文本形式 + 可能的链接形式
      document.querySelectorAll('a[href]').forEach(a => {
        const t = (a.innerText || '').trim();
        const m = t.match(/^(.{1,12}?)\\s*[(（](\\d+)[)）]$/);
        if (m && a.href.includes(hostDomain)) {
          out.categories.push({ name: m[1], count: +m[2], url: a.href });
        }
      });
      if (!out.categories.length) {
        // 文本兜底：找 "分类：" 行
        const tm = (document.body.innerText || '').match(/分类[：:]\\s*([^\\n]{2,80})/);
        if (tm) {
          const parts = tm[1].split(/(?=[\\u4e00-\\u9fa5a-zA-Z])/);
          let cur = '';
          for (const p of parts) {
            const pm = p.match(/^(.{1,12}?)\\s*[(（](\\d+)[)）]$/);
            if (pm) { if (cur) { out.categories.push({ name: cur.trim(), count: +pm[2] }); cur = ''; } else { out.categories.push({ name: pm[1], count: +pm[2] }); } }
            else if (/^[(（]/.test(p)) { const n = p.match(/[(（](\\d+)[)）]/); if (n && cur) { out.categories.push({ name: cur.trim(), count: +n[1] }); cur = ''; } }
            else cur = p;
          }
        }
      }
      out.categories = out.categories.slice(0, 20);
      out.offerListUrl = location.href.split('?')[0];
      return out;
    `).catch(() => null);

    if (!info) return { ok: false, message: '店铺信息提取失败' };

    // 列表页 title 常为"全部商品页"无店名 → 回店铺首页取一次 title
    if (!info.shopName || /全部商品|首页/.test(info.shopName)) {
      this._prog({ key: 'verify-shop', title: '验证店铺', detail: '读取店铺名…', percent: 80 });
      try {
        await this._navTo(win, shopUrl.replace(/\/$/, '') + '/', { isGuest });
        const homeTitle = await DOM.evalInPage(win.webContents, `
          const t = document.title || '';
          let name = t.split(/[-_|－–]+/)[0].trim();
          if (!name || /1688|阿里巴巴|首页/.test(name)) name = t.replace(/[-_,，\\s]*(阿里巴巴|1688\\.com|首页).*$/, '').trim();
          return name.slice(0, 40);
        `).catch(() => '');
        if (homeTitle && !/全部商品|首页/.test(homeTitle)) info.shopName = homeTitle;
      } catch (_) {}
    }
    if (!info.shopName) info.shopName = shopUrl.match(/shop[\w]+\.1688/)?.[0] || '1688店铺';

    this.logger.success('collect', `店铺验证通过: ${info.shopName} (${info.goodsCount || '?'}件, ${info.categories.length}个分类)`);
    // 记录店铺
    this.store.recordShop({
      shopUrl,
      name: info.shopName,
      goodsCount: info.goodsCount,
    });
    return {
      ok: true,
      shopUrl,
      shopName: info.shopName,
      goodsCount: info.goodsCount,
      categories: info.categories || [],
      offerListUrl: info.offerListUrl || offerListUrl,
    };
  }

  /**
   * 阶段1：翻页收集商品链接
   * @param params { url, maxPages, keyword(仅搜索页需要,可选), filterFenxiao }
   */
  async previewShop({ url, maxPages = MAX_PAGES_DEFAULT, filterFenxiao = false }) {
    const { acc, win, isGuest } = await this._session();
    // 采集配置：单次页数上限 clamp
    const ccfg = this.store.settings.collect || {};
    if (ccfg.maxPages) maxPages = Math.min(maxPages, ccfg.maxPages);
    // 店铺首页自动转为商品列表页（1688店铺首页一般是介绍页，商品在 offerlist）
    let targetUrl = url;
    if (/^https:\/\/shop[\w-]+\.1688\.com\/?$/.test(url)) {
      targetUrl = url.replace(/\/$/, '') + '/page/offerlist.htm';
      this.logger.info('collect', `检测到店铺首页，转为商品列表页: ${targetUrl}`);
    }
    this.logger.info('collect', `开始列表采集: ${targetUrl} (最多${maxPages}页)`, { account: acc.name });

    // 开启网络响应捕获（1688新版页面商品数据在XHR响应里，DOM无链接）
    const capture = this._startNetCapture(win);

    const all = new Map(); // offerId -> {offerId, title, price, url, isFenxiao}
    let noNewCount = 0;

    for (let page = 1; page <= maxPages; page++) {
      this._prog({ key: 'preview-shop', title: '全店采集', detail: `第 ${page}/${maxPages} 页，已获取 ${all.size} 条…`, percent: Math.round(((page - 1) / maxPages) * 100) });
      const navOk = await this._navTo(win, targetUrl, { isGuest });
      if (navOk === false) { this.logger.warn('collect', '页面需要登录，游客模式无法采集此页'); break; }
      await this._scrollForLazy(win, 6);
      // 三通道提取：点击捕获（主力）+ 网络响应 + DOM
      let batch = [];
      try {
        let clickItems = await this._extractByClick(win);
        // 空结果自动重试（页面可能渲染慢或瞬时限流；次数/开关由采集配置控制）
        if (!clickItems || !clickItems.length) {
          const ccfg = this.store.settings.collect || {};
          const times = ccfg.retryEmpty === false ? 0 : Math.max(1, ccfg.retryTimes || 2);
          for (let t = 0; t < times && (!clickItems || !clickItems.length); t++) {
            this.logger.warn('collect', `点击捕获0条，等待重试(${t + 1}/${times})…`);
            await DOM.sleep(4000);
            await this._scrollForLazy(win, 3);
            clickItems = await this._extractByClick(win);
          }
        }
        this.logger.info('collect', `点击捕获提取: ${(clickItems || []).length} 条`);
        batch = batch.concat(clickItems || []);
      } catch (e) {
        this.logger.warn('collect', '点击捕获失败: ' + e.message);
      }
      try {
        const netItems = await capture.extract();
        if (netItems.length) this.logger.info('collect', `网络捕获提取: ${netItems.length} 条`);
        batch = batch.concat(netItems);
      } catch (e) { /* 静默 */ }
      const domItems = await this._extractOfferLinks(win);
      if (domItems.length) batch = batch.concat(domItems);
      let newCount = 0;
      for (const it of batch) {
        if (it.offerId && !all.has(it.offerId)) { all.set(it.offerId, it); newCount++; }
      }
      this.logger.info('collect', `第${page}页: 合计${batch.length}条, 新增${newCount}条, 累计${all.size}条`);
      this._prog({ key: 'preview-shop', title: '全店采集', detail: `第 ${page}/${maxPages} 页 ✓ 新增${newCount}条，累计 ${all.size} 条`, percent: Math.round((page / maxPages) * 100) });

      if (newCount === 0) { noNewCount++; if (noNewCount >= 2) { this.logger.warn('collect', '连续2页无新商品，认为已采完'); break; } }
      else noNewCount = 0;

      // 尝试翻页：点"下一页"，判断 URL 是否变化/内容是否更新
      const turned = await this._nextPage(win, page, isGuest);
      if (!turned) {
        this.logger.warn('collect', '没有找到下一页（或已是最后一页），结束翻页');
        break;
      }
      await DOM.sleep(...this.store.settings.collect.pageDelay);
    }

    capture.stop();

    let items = [...all.values()];
    if (filterFenxiao) {
      // 列表页先按文字粗筛（详情阶段再精确判定）
      items = items.filter(x => x.isFenxiao !== false);
    }
    // 采集成功 → 粘性账号（下次优先复用这个已过验证的窗口）
    if (items.length > 0 && !isGuest && this.accounts.markSticky) {
      this.accounts.markSticky(acc.id);
    }
    this.logger.success('collect', `列表采集完成，共 ${items.length} 个商品`);
    return { ok: true, items, account: acc.name };
  }

  /**
   * 网络响应捕获器：CDP Network domain 监听 XHR 响应，
   * 从响应体里解析商品数据（offerId/标题/价格）
   * 1688新版店铺页(2025模板)商品数据全在 XHR 响应 JSON 里，DOM 无 <a> 链接
   */
  _startNetCapture(win) {
    const dbg = win.webContents.debugger;
    try { dbg.attach('1.3'); } catch (e) { /* already attached 正常 */ }
    const responseQueue = []; // {requestId, url}
    const self = this;

    const onMsg = (_event, method, params) => {
      if (method === 'Network.responseReceived') {
        const r = params.response || {};
        const u = r.url || '';
        // 只关心 1688 的 XHR/接口（排除静态资源）
        if (/1688\.com|alicdn\.com/.test(u) &&
            !/\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(\?|$)/i.test(u) &&
            (r.mimeType || '').includes('json') || /mtop|render|offer|async|api|page/i.test(u)) {
          responseQueue.push({ requestId: params.requestId, url: u });
        }
      }
    };
    dbg.on('message', onMsg);
    dbg.sendCommand('Network.enable').catch(() => {});

    return {
      async extract() {
        const items = [];
        // 快照当前队列
        const q = responseQueue.splice(0, responseQueue.length);
        for (const { requestId, url } of q) {
          try {
            const body = await dbg.sendCommand('Network.getResponseBody', { requestId });
            const text = body && body.body;
            if (!text || text.length > 3000000) continue;
            const parsed = parseOffersFromJson(text, url);
            if (parsed.length) {
              self.logger.info('collect', `接口捕获成功: ${url.slice(0, 80)} → ${parsed.length} 条`);
              items.push(...parsed);
            }
          } catch (e) { /* 响应体已释放等，忽略 */ }
        }
        // 去重
        const seen = new Map();
        for (const it of items) {
          if (it.offerId && !seen.has(it.offerId)) seen.set(it.offerId, it);
        }
        return [...seen.values()];
      },
      stop() {
        try { dbg.removeListener('message', onMsg); } catch (e) {}
      },
    };
  }

  /** 滚动触发懒加载 */
  async _scrollForLazy(win, times = 5) {
    for (let i = 0; i < times; i++) {
      await win.webContents.executeJavaScript(`
        window.scrollBy(0, Math.floor(window.innerHeight * 0.85));
        'ok';
      `).catch(() => {});
      await DOM.sleep(rand600());
    }
    // 回到顶部，防止分页组件在视口外点不到
    await win.webContents.executeJavaScript(`window.scrollTo(0, 0); 'ok'`).catch(() => {});
    await DOM.sleep(500);
  }

  /**
   * 【主力提取方案】模拟点击卡片捕获跳转URL
   * 1688新版店铺页(2025模板)卡片是JS渲染div无<a>链接，
   * 点击触发 window.open('https://detail.1688.com/offer/{offerId}.html')
   * patch window.open 拦截记录，不真开窗口
   */
  async _extractByClick(win) {
    // 注意：evalInPage 自动包装 (async()=>{ code })()，code 内可直接用 await/return
    return DOM.evalInPage(win.webContents, `
      // patch window.open 捕获跳转
      const jumps = [];
      const origOpen = window.open;
      window.open = function(...args) { jumps.push(String(args[0] || '')); return null; };

      // 商品卡片：含标题 p[title] + 图片的可点击div
      const cards = [...document.querySelectorAll('div[style*="cursor: pointer"], div[style*="cursor:pointer"]')].filter(el => {
        return el.querySelector('p[title]') && el.querySelector('img') && (el.innerText||'').length < 500;
      });

      const results = [];
      for (let i = 0; i < cards.length && i < 60; i++) {
        const card = cards[i];
        jumps.length = 0;
        const p = card.querySelector('p[title]');
        const title = (p && p.title) || '';
        const text = card.innerText || '';
        const pm = text.match(/¥\\s*([0-9]+\\.?[0-9]*)/);
        const price = pm ? parseFloat(pm[1]) : null;
        const isFx = /一件代发|可分销|分销|代发/.test(text) ? true : null;
        // 销量
        const sm = text.match(/已售([0-9]+\\+?)件/);

        try {
          card.scrollIntoView({ block: 'center' });
          const rect = card.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + 60, clientY: rect.y + 60 };
          card.dispatchEvent(new MouseEvent('mousedown', opts));
          card.dispatchEvent(new MouseEvent('mouseup', opts));
          card.click();
        } catch (e) { continue; }

        // 等跳转记录（React onClick 同步触发，350ms足够）
        await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 200)));
        if (jumps.length) {
          const m = jumps[0].match(/offer\\/(\\d{9,15})\\.html/);
          if (m) {
            results.push({
              offerId: m[1],
              title: title.slice(0, 60),
              price,
              isFenxiao: isFx,
              monthSales: sm ? sm[1] : null,
              source: 'click',
            });
          }
        }
      }
      window.open = origOpen;
      return results;
    `);
  }

  /** 提取页面内所有 offer 链接（兼容 detail.1688.com/offer、/offer/、detail.m.1688.com?offerId= 三种形式） */
  async _extractOfferLinks(win) {
    return DOM.evalInPage(win.webContents, `
      const seen = new Map();
      // 从任意URL里提取 offerId（路径形式 + 查询参数形式）
      const idFromUrl = (href) => {
        const m1 = href.match(/1688\\.com\\/offer\\/(\\d{6,})(\\.html)?/) || href.match(/detail\\.1688\\.com\\/offer\\/(\\d{6,})/);
        if (m1) return m1[1];
        // 搜索页形式: detail.m.1688.com/page/index.html?offerId=xxx
        const m2 = href.match(/[?&]offerId=(\\d{6,})/);
        if (m2) return m2[1];
        return null;
      };
      document.querySelectorAll('a[href]').forEach(a => {
        const id = idFromUrl(a.href || '');
        if (!id || seen.has(id)) return;
        // 标题：img alt / a title / 卡片文本（找 offer 标题类元素）
        const img = a.querySelector('img');
        let title = (img && (img.alt || img.title)) || a.title || (a.innerText || '').trim().split('\\n')[0] || '';
        // 搜索页卡片：从父容器找标题/价格/代发标记
        let card = a.closest('[class*="offer"],[class*="card"],[class*="item"],[class*="product"],li,div');
        let price = null, isFenxiao = null, monthSales = null, minOrderQty = null;
        if (card) {
          const t = card.innerText || '';
          // 价格：必须 ¥ 符号开头（避免把年份2026/销量当价格）
          const ptext = t.match(/¥\\s*([0-9][0-9.,~\\-]*万?)/);
          if (ptext) {
            const raw = ptext[1];
            price = raw.includes('万') ? parseFloat(raw) * 10000 : parseFloat(String(raw).replace(/[~,\\-].*$/, ''));
            if (!isFinite(price)) price = null;
          }
          isFenxiao = /一件代发|可分销|分销|代发/.test(t) ? true : null;
          const sm = t.match(/已售([0-9]+\+?)件/);
          if (sm) monthSales = sm[1];
          // 起批量："1件起批" / "2件起批"（热点选品按起订量1判定可代发）
          const mq = t.match(/([0-9]+)件起批/);
          if (mq) minOrderQty = parseInt(mq[1], 10);
        }
        if (!title || title.length < 4) {
          // 从卡片找长文本行做标题
          const lines = card ? [...card.querySelectorAll('div,span,p')].map(e => (e.innerText||'').trim()).filter(t => t.length >= 8 && t.length <= 60 && !/¥|已售|件|代发|包邮/.test(t)) : [];
          if (lines.length) title = lines[0];
        }
        seen.set(id, { offerId: id, url: 'https://detail.1688.com/offer/' + id + '.html', title: title.slice(0, 60), price, isFenxiao, monthSales, minOrderQty });
      });
      // 2. 兜底：window 数据源中的 offer 列表（部分模板把数据放全局）
      try {
        const dumps = [window.__INIT_DATA__, window.__ALI_GLOBAL_DATA, window.pageData, window.g_page_config];
        for (const d of dumps) {
          if (!d) continue;
          const s = JSON.stringify(d);
          const re = /"offerId":"?(\\d{6,})"?/g;
          let m;
          while ((m = re.exec(s)) !== null) {
            const id = m[1];
            if (!seen.has(id)) seen.set(id, { offerId: id, url: 'https://detail.1688.com/offer/' + id + '.html', title: '', price: null, isFenxiao: null });
          }
        }
      } catch (e) {}
      // 3. 再兜底：IMG 的 data-lazy / data-src 里也可能有 offerId（图片懒加载卡片的常见做法）
      try {
        document.querySelectorAll('img[data-src], img[data-lazy], img[src*="offer"]').forEach(img => {
          const src = img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.src || '';
          const m = src.match(/offer\\/(\\d{6,})/);
          if (!m) return;
          const id = m[1];
          if (!seen.has(id)) seen.set(id, { offerId: id, url: 'https://detail.1688.com/offer/' + id + '.html', title: img.alt || '', price: null, isFenxiao: null });
        });
      } catch (e) {}

      // 4. 【1688 2025新版店铺页专用】卡片是 JS 渲染 div（p[title] 标题 + 图片URL含offerId）
      //    图片 URL 形如 https://cbu01.alicdn.com/img/ibank/O1CN01..._!!6000000001234-0-cib.jpg
      //    从 data-src/src 中提取数字ID作为 offerId
      try {
        const cards = [];
        document.querySelectorAll('p[title]').forEach(p => { cards.push(p); });
        // 优先从包含卡片的 img 数据提取
        const allImgs = document.querySelectorAll('img');
        const imgData = [];
        allImgs.forEach(img => {
          const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.src || '';
          if (/alicdn\\.com\\/img\\/(ibank|offer|imgextra)/.test(src)) imgData.push({ src, alt: img.alt || '' });
        });
        // 找卡片附近的图片 + 标题配对
        for (const p of cards) {
          const title = p.title || (p.innerText || '').trim().split('\\n')[0] || '';
          // 卡片容器（往上找含图片的容器）
          let card = p;
          let cardImg = null;
          for (let i = 0; i < 5 && card; i++) {
            card = card.parentElement;
            if (!card) break;
            const im = card.querySelector('img');
            if (im) { cardImg = im; break; }
          }
          if (!cardImg) continue;
          const src = cardImg.getAttribute('data-src') || cardImg.getAttribute('data-lazy-src') || cardImg.src || '';
          // 提取数字ID（ibank URL 数字通常是 offerId）
          const idMatch = src.match(/_(\\d{6,15})_?0[-_]?cib/) || src.match(/ibank\\/([^_]+)_!!(\\d{6,15})/) || src.match(/(\\d{6,15})_!?!/);
          const id = idMatch ? (idMatch[2] || idMatch[1]) : null;
          if (id && !seen.has(id)) {
            // 价格：卡片文本里的 ¥xx
            const cardText = card.innerText || '';
            const ptext = cardText.match(/¥?\\s*([0-9][0-9.,~\\-]*万?)/);
            const price = ptext ? parsePrice(ptext[1]) : null;
            const isFx = /一件代发|可分销|分销|代发/.test(cardText) ? true : null;
            seen.set(id, { offerId: id, url: 'https://detail.1688.com/offer/' + id + '.html', title: title.slice(0, 60), price, isFenxiao: isFx });
          }
        }
      } catch (e) {}

      // 5. 最后兜底：react fiber 属性里的 offerId
      try {
        document.querySelectorAll('[data-offer-id],[data-offerId],[data-id*="offer"],a[data-href]').forEach(el => {
          const id = el.getAttribute('data-offer-id') || el.getAttribute('data-offerId') || el.getAttribute('data-id') || '';
          if (id && /^\\d{6,}$/.test(id) && !seen.has(id)) {
            const t = (el.innerText || '').split('\\n')[0] || '';
            seen.set(id, { offerId: id, url: 'https://detail.1688.com/offer/' + id + '.html', title: t.slice(0, 60), price: null, isFenxiao: null });
          }
        });
      } catch (e) {}

      function parsePrice(t) {
        const n = parseFloat(String(t).replace(/[,~\\-万]/g, ''));
        if (isNaN(n)) return null;
        return String(t).includes('万') ? n * 10000 : n;
      }
      return Array.from(seen.values()).filter(x => x.title !== null);
    `);
  }

  /** 翻下一页（多种分页组件兼容） */
  async _nextPage(win, currentPage, isGuest = false) {
    // 策略1: URL 带 begin/offset/sPage 等参数，直接改URL重载
    const curUrl = win.webContents.getURL();
    const u = new URL(curUrl);
    if (u.searchParams.has('begin')) {
      u.searchParams.set('begin', String((u.searchParams.get('begin') | 0) + 20));
      await this._navTo(win, u.toString(), { isGuest });
      return true;
    }
    if (u.searchParams.has('offset')) {
      u.searchParams.set('offset', String((u.searchParams.get('offset') | 0) + 20));
      await this._navTo(win, u.toString());
      return true;
    }
    // 策略2: 点"下一页"按钮
    const clicked = await DOM.evalInPage(win.webContents, `
      const cands = [];
      document.querySelectorAll('a,button,[class*="next"],[class*="page"]').forEach(el => {
        const t = (el.innerText || el.textContent || '').trim();
        if (t === '下一页' || t === '下页' || t === '>' || t === 'Next' || t.includes('下一页')) {
          if (t.length < 8) cands.push(el);
        }
      });
      if (!cands.length) return false;
      const el = cands[cands.length - 1];
      // 判断是否 disabled
      const cls = (el.className || '') + ' ' + (el.parentElement ? el.parentElement.className : '');
      if (/disabled|current|nouselect/.test(cls)) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    `);
    if (clicked) {
      await DOM.sleep(2000);
      await DOM.waitLoadStop(win.webContents, 20000);
      return true;
    }
    // 策略3: 搜索页 URL 迁移 (s.1688.com begin 参数)
    if (/s\.1688\.com/.test(curUrl) && u.searchParams.has('begin')) {
      u.searchParams.set('begin', String((u.searchParams.get('begin') | 0) + 20));
      await this._navTo(win, u.toString(), { isGuest });
      return true;
    }
    return false;
  }

  /**
   * 阶段2：抓取详情（选中商品）
   * @param params { offerIds: [], onProgress? }
   */
  async collectDetails({ offerIds, onProgress, downloadImages = true }) {
    const settings = this.store.settings;
    const results = { ok: 0, fail: 0, skipped: 0, items: [] };
    const { acc, win, isGuest } = await this._session();
    const progKey = 'collect-details';

    for (let i = 0; i < offerIds.length; i++) {
      const offerId = offerIds[i];
      const pct = Math.round(((i) / offerIds.length) * 100);
      // 跳过已存在的
      if (this.store.goodsByOffer(offerId)) {
        results.skipped++;
        onProgress && onProgress({ index: i, total: offerIds.length, offerId, status: 'skipped' });
        this._prog({ key: progKey, title: `链接采集 (${offerIds.length}条)`, detail: `[${i + 1}/${offerIds.length}] ${offerId} 已存在，跳过`, percent: Math.round(((i + 1) / offerIds.length) * 100) });
        continue;
      }
      const url = `https://detail.1688.com/offer/${offerId}.html`;
      try {
        this._prog({ key: progKey, title: `链接采集 (${offerIds.length}条)`, detail: `[${i + 1}/${offerIds.length}] 打开详情页 ${offerId}…`, percent: pct });
        await this._navTo(win, url, { isGuest });
        await this._scrollForLazy(win, 12);
        await DOM.sleep(settings.collect.detailScrollWait || 3000);

        this._prog({ key: progKey, title: `链接采集 (${offerIds.length}条)`, detail: `[${i + 1}/${offerIds.length}] 提取数据…`, percent: pct + 3 });
        const data = await this._extractDetail(win);
        if (!data || !data.title) throw new Error('提取不到标题');
        this.logger.info('collect', `采集 ${offerId}: ${data.title.slice(0, 20)} 发货地=${data.location || '未知'} 视频=${data.video ? '有' : '无'}`);

        // 详情图完整化：detailUrl 接口（主进程请求，绕过 CORS）> DOM 懒加载兜底
        if (data.detailUrl) {
          const apiImgs = await this._fetchDetailImages(data.detailUrl, data.mainImages);
          if (apiImgs.length > data.detailImages.length) {
            this.logger.info('collect', `详情图接口全量提取: ${apiImgs.length}张 (DOM仅${data.detailImages.length}张) ${offerId}`);
            data.detailImages = apiImgs;
          }
          delete data.detailUrl; // 不入库
        }

        // 分销判定已移除（用户以"起批量≤N"筛选替代，不再强制一件代发）

        // 下载图片（主图+详情图）到本地缓存
        if (downloadImages) {
          this._prog({ key: progKey, title: `链接采集 (${offerIds.length}条)`, detail: `[${i + 1}/${offerIds.length}] 下载图片: ${data.title.slice(0, 16)}…`, percent: pct + 6 });
          try {
            data.localMainImages = await this.media.downloadImages(offerId, 'main', data.mainImages.slice(0, 5));
            data.localDetailImages = await this.media.downloadImages(offerId, 'detail', data.detailImages.slice(0, 60));
          } catch (e) {
            this.logger.warn('collect', `图片下载失败(不影响入库): ${e.message}`);
          }
        }

        results.items.push(data);
        results.ok++;
        this.logger.success('collect', `详情采集成功 [${i + 1}/${offerIds.length}] ${offerId} - ${data.title.slice(0, 24)}`);
        this._prog({ key: progKey, title: `链接采集 (${offerIds.length}条)`, detail: `[${i + 1}/${offerIds.length}] ✓ ${data.title.slice(0, 20)}`, percent: Math.round(((i + 1) / offerIds.length) * 100) });
        onProgress && onProgress({ index: i, total: offerIds.length, offerId, status: 'ok', data });
      } catch (e) {
        results.fail++;
        this.logger.error('collect', `详情采集失败 [${i + 1}/${offerIds.length}] ${offerId}`, e.message);
        await DOM.captureSnapshot.call({ dir: this.store.dir }, win.webContents, 'collect-fail-' + offerId);
        this._prog({ key: progKey, title: `链接采集 (${offerIds.length}条)`, detail: `[${i + 1}/${offerIds.length}] ✘ ${offerId}: ${e.message.slice(0, 30)}`, percent: Math.round(((i + 1) / offerIds.length) * 100) });
        onProgress && onProgress({ index: i, total: offerIds.length, offerId, status: 'fail', error: e.message });
      }
      await DOM.sleep(...settings.collect.pageDelay);
    }

    // 入库
    if (results.items.length) this.store.addGoods(results.items);
    // 采集成功 → 标记粘性账号（下次优先用这个已过验证的窗口）
    if (results.ok > 0 && !isGuest && this.accounts.markSticky) {
      this.accounts.markSticky(acc.id);
    }
    this.logger.success('collect', `详情采集完成: 成功${results.ok} 失败${results.fail} 跳过${results.skipped}`);
    return results;
  }

  /**
   * 采集单个offer详情（不入库，仅返回数据）
   * 用于队列上传时补采缺失详情的轻量导入商品
   */
  async collectOne(offerId, { downloadImages = true } = {}) {
    const settings = this.store.settings;
    const { acc, win, isGuest } = await this._session();
    const url = `https://detail.1688.com/offer/${offerId}.html`;
    this._prog({ key: 'collect-one', title: `补采详情 ${offerId}`, detail: '打开详情页…', percent: 10 });
    await this._navTo(win, url, { isGuest });
    await this._scrollForLazy(win, 12);
    await DOM.sleep(settings.collect.detailScrollWait || 3000);
    this._prog({ key: 'collect-one', title: `补采详情 ${offerId}`, detail: '提取数据…', percent: 50 });
    const data = await this._extractDetail(win);
    if (!data || !data.title) throw new Error('提取不到标题');
    if (data.detailUrl) {
      const apiImgs = await this._fetchDetailImages(data.detailUrl, data.mainImages);
      if (apiImgs.length > data.detailImages.length) data.detailImages = apiImgs;
      delete data.detailUrl;
    }
    if (downloadImages) {
      try {
        data.localMainImages = await this.media.downloadImages(offerId, 'main', data.mainImages.slice(0, 5));
        data.localDetailImages = await this.media.downloadImages(offerId, 'detail', data.detailImages.slice(0, 60));
      } catch (e) {
        this.logger.warn('collect', `图片下载失败(不影响入库): ${e.message}`);
      }
    }
    this._prog({ key: 'collect-one', title: `补采详情 ${offerId}`, detail: `✓ ${data.title.slice(0, 20)}`, percent: 100, done: true });
    this.logger.success('collect', `补采详情成功 ${offerId} - ${data.title.slice(0, 24)}`);
    return data;
  }

  /** 详情页多策略提取（__INIT_DATA__ 优先，DOM 兜底） */
  async _extractDetail(win) {
    return DOM.evalInPage(win.webContents, `
      const out = { offerId: null, title: '', price: null, priceRange: null, mainImages: [],
                    skus: [], skuGroups: [], skuDefs: [], skuPriceScale: '', detailImages: [], companyName: '', location: '',
                    isFenxiao: null, categoryText: '', monthSales: null, attributes: {}, video: '', freeShipping: null, offSale: false,
                    detailUrl: '', supplierUserId: '' };

      // ---- offerId
      out.offerId = (location.pathname.match(/offer\\/(\\d{6,})/) || [])[1] || null;

      // ---- SKU 明细（1688新版 window.context：skuProps 规格定义 + skuInfoMap 组合价格库存，黑鲸鱼 AliToTaobao 同源数据）
      try {
        const sm = (window.context && window.context.result && window.context.result.data
          && window.context.result.data.Root && window.context.result.data.Root.fields
          && window.context.result.data.Root.fields.dataJson && window.context.result.data.Root.fields.dataJson.skuModel) || null;
        if (sm && Array.isArray(sm.skuProps) && sm.skuProps.length && sm.skuInfoMap) {
          // 规格定义：[{prop, value:[{name, imageUrl}]}]（保留原始结构，发布端转换）
          out.skuDefs = sm.skuProps.map(p => ({
            name: String(p.prop || '').trim(),
            values: (p.value || []).map(v => ({ name: String(v.name || '').trim(), imageUrl: v.imageUrl || '' })),
          }));
          // 组合明细：{"值1&gt;值2": {discountPrice/price/priceText, canBookCount, skuId}} → [{values:[...], price, stock, skuId}]
          const map = sm.skuInfoMap;
          out.skus = Object.keys(map).map(k => {
            const info = map[k] || {};
            // 价格多字段兜底（促销SKU有discountPrice；普通SKU可能只有price对象/priceText；都没有=0由发布端用商品价兜底）
            let pv = info.discountPrice;
            if (pv == null && info.price != null) pv = (typeof info.price === 'object') ? (info.price.priceText || info.price.price) : info.price;
            if (pv == null && info.priceText != null) pv = info.priceText;
            return {
              values: String(k).replace(/&gt;/g, '>').split('>').map(s => s.trim()).filter(Boolean),
              price: parseFloat(String(pv).replace(/[^0-9.]/g, '')) || 0,
              stock: parseInt(info.canBookCount || 0, 10) || 0,
              skuId: info.skuId || '',
            };
          }).filter(s => s.values.length);
          out.skuPriceScale = sm.skuPriceScale || '';
        }
      } catch (e) {}

      // ---- 策略A: __INIT_DATA__ (1688新版详情页全局数据)
      const D = () => window.__INIT_DATA__;
      if (D()) {
        try {
          const d = D();
          const str = JSON.stringify(d);
          // 标题
          const tMatch = str.match(/"subject":"([^"]{4,80})"/);
          if (tMatch) out.title = tMatch[1];
          // 价格
          const pMatch = str.match(/"priceRange":"?([0-9.]+\\s*-\\s*[0-9.]+|[0-9.]+)"?/);
          const pMatch2 = str.match(/"priceRange":\\{"begin":([0-9.]+)/);
          if (pMatch2) out.price = parseFloat(pMatch2[1]);
          else if (pMatch) {
            const pr = pMatch[1].includes('-') ? pMatch[1].split('-')[0].trim() : pMatch[1];
            out.price = parseFloat(pr);
            out.priceRange = pMatch[1];
          }
          // 一件代发/分销标志
          out.isFenxiao = (/"fenxiao"/.test(str) && /true|"1"/.test(str.match(/"fenxiao"[^,]{0,10}/)[0])) ||
                          str.includes('一件代发') || str.includes('可分销') || str.includes('"isFenxiao":true');
          // 发货地（黑鲸鱼 seller_addr：商品真实发货地）
          const loc = str.match(/"sendGoodsAddress":"([^"]{2,20})"/) || str.match(/"address":"([^"]{2,20})"/);
          if (loc) out.location = loc[1].split(' ').slice(0, 2).join(' ');
        } catch (e) {}
      }

      // ---- 发货地精确提取（2026新版：shippingServices.fields.freightInfo.location，实测"广东省揭阳市"）
      // 注意：必须在 __INIT_DATA__ 块外（新版页面无该全局，块内代码不会执行）
      if (!out.location && window.context) {
        try {
          const fi = (window.context.result && window.context.result.data
            && window.context.result.data.shippingServices
            && window.context.result.data.shippingServices.fields
            && window.context.result.data.shippingServices.fields.freightInfo) || null;
          const rawLoc = (fi && (fi.location || fi.recieveAddress)) || '';
          // 规范化为淘宝发布页格式："广东省揭阳市" → "广东省 揭阳市"
          if (rawLoc) {
            const m = rawLoc.match(/^(.+?(?:省|自治区|特别行政区|市))([\u4e00-\u9fa5]{1,8}?(?:市|地区|自治州|盟|区))?[\u4e00-\u9fa5]*$/);
            if (m) out.location = [m[1], m[2]].filter(Boolean).join(' ');
            else out.location = rawLoc;
          }
        } catch (e) {}
      }

      // ---- 主图视频（黑鲸鱼 offerDetail.wirelessVideo 同源；2026新版字段 gallery.fields.video / offerDetail.wirelessVideo.videoUrls）
      try {
        if (window.__INIT_DATA__) {
          const str = JSON.stringify(window.__INIT_DATA__);
          const vm = str.match(/"wirelessVideo":\\{[\\s\\S]{0,200}?"videoUrls":\\["([^"]+)"/);
          if (vm) out.video = vm[1];
        }
        // 2026新版精确路径：gallery.fields.video.videoUrl（商品自身视频，实测主图区+context 双确认）
        if (!out.video && window.context) {
          try {
            const gv = (window.context.result && window.context.result.data
              && window.context.result.data.gallery
              && window.context.result.data.gallery.fields
              && window.context.result.data.gallery.fields.video) || null;
            if (gv && gv.videoUrl) out.video = gv.videoUrl;
          } catch (e) {}
        }
        if (!out.video && window.context) {
          const cs = JSON.stringify(window.context);
          const vm2 = cs.match(/"wirelessVideo":\\{[\\s\\S]{0,200}?"videoUrls":\\["([^"]+)"/);
          if (vm2) out.video = vm2[1];
        }
        // DOM 兑底：仅限主图区容器（.detail-video/.lib-video），避免推荐/广告视频串商品
        if (!out.video) {
          const vEl = document.querySelector('.detail-video video source, .detail-video video, .lib-video video source, .lib-video video');
          if (vEl) out.video = vEl.getAttribute('src') || vEl.src || vEl.currentSrc || '';
        }
      } catch (e) {}

      // ---- 策略B: DOM 兜底/补充
      try {
        // 标题
        if (!out.title) {
          const h = document.querySelector('h1, [class*="title"]');
          out.title = (h && (h.innerText || '').trim()) || '';
        }
        // 价格
        if (out.price == null) {
          const pe = document.querySelector('[class*="price"], .od-price-range');
          if (pe) {
            const t = (pe.innerText || '').match(/([0-9][0-9.]*)/);
            if (t) out.price = parseFloat(t[1]);
            const r = (pe.innerText || '').match(/([0-9][0-9.]*)\\s*-\\s*([0-9][0-9.]*)/);
            if (r) out.priceRange = r[1] + '-' + r[2];
          }
        }
        // 主图: 详情大图轮播（cbu01.alicdn.com）
        const seen = new Set();
        document.querySelectorAll('[class*="gallery"] img, [class*="preview"] img, .od-gallery img, img[class*="main"]').forEach(img => {
          let src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
          src = src.replace(/_\\.webp|_.!.*?\\./g, '');
          if (/alicdn\\.com/.test(src) && !src.includes('x-oss-process') && seen.size < 8 && !seen.has(src)) {
            if (/[\\d_]+\\.jpg|\\.png|\\.webp/.test(src)) { seen.add(src); }
          }
        });
        if (!seen.size) {
          // 更宽的兜底：页面中前几张商品大图
          document.querySelectorAll('img').forEach(img => {
            const src = img.currentSrc || img.src || '';
            if (/alicdn\\.com\\/img\\/ibank/.test(src) && seen.size < 8) seen.add(src);
          });
        }
        out.mainImages = [...seen].slice(0, 5);

        // SKU 组 (颜色/尺码 规格名+值)
        try {
          const groups = [];
          document.querySelectorAll('[class*="sku-item"], [class*="obj-sku"] [class*="value"], [class*="specification"] li, [data-sku]').forEach(() => {});
          // 1688 常见: .sku-item-name (规格名) + 对应值容器
          const nameEls = document.querySelectorAll('[class*="sku-name"], [class*="prop-name"], .od-sku-item-name');
          nameEls.forEach(n => {
            const g = { name: (n.innerText || '').trim().replace(/[:：].*/, '').slice(0, 20), values: [] };
            let sib = n.nextElementSibling;
            let hops = 0;
            while (sib && hops < 5) {
              const vals = sib.querySelectorAll('[class*="sku-value"], li, span, a');
              if (vals.length) {
                vals.forEach(v => {
                  const t = (v.innerText || '').trim();
                  if (t && t.length < 30 && g.values.length < 60) g.values.push(t);
                });
                break;
              }
              sib = sib.nextElementSibling; hops++;
            }
            if (g.name && g.values.length) groups.push(g);
          });
          out.skuGroups = groups.slice(0, 3);
        } catch (e) {}

        // 详情图
        const dimgs = new Set();
        document.querySelectorAll('[class*="detail"] img, [class*="desc"] img, img[data-lazy-src*="alicdn"], img[src*="alicdn.com\\/img\\/ibank"]').forEach(img => {
          let src = img.currentSrc || img.getAttribute('data-lazy-src') || img.getAttribute('data-src') || img.src || '';
          if (/alicdn\\.com\\/img\\/ibank/.test(src)) {
            src = src.split('?')[0].replace(/_\\d+x\\d+[^.]*\\./g, '.');
            if (dimgs.size < 80) dimgs.add(src);
          }
        });
        // 懒加载占位图转真实图
        document.querySelectorAll('img').forEach(img => {
          const ds = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
          if (/alicdn\\.com\\/img\\/ibank/.test(ds) && dimgs.size < 80) dimgs.add(ds);
        });
        // 主图不应进详情，去掉
        out.detailImages = [...dimgs].filter(u => !out.mainImages.includes(u)).slice(0, 60);

        // 公司名
        const co = document.querySelector('[class*="company"] [class*="name"], [class*="shop-name"], .company-name');
        if (co) out.companyName = (co.innerText || '').trim().slice(0, 50);

        // 一件代发文字兜底
        if (out.isFenxiao == null) {
          const bodyText = document.body.innerText || '';
          out.isFenxiao = /一件代发|可分销|分销商品/.test(bodyText.slice(0, 6000)) ? true : false;
        }

        // 类目面包屑
        const crumb = document.querySelector('[class*="crumb"], [class*="breadcrumb"]');
        if (crumb) out.categoryText = (crumb.innerText || '').replace(/\\s+/g, '>').slice(0, 80);

        // ---- 属性参数表提取（优先 table 结构，次选文本正则）
        try {
          const attrs = {};
          // 策略1：表格结构（1688"商品参数"参数表，td 两列或四列成对）
          const tables = [...document.querySelectorAll('table')].filter(t => {
            const txt = t.innerText || '';
            return /面料|材质|风格|货号|成分|产地|裙型|款式/.test(txt) && txt.length < 5000;
          });
          for (const t of tables) {
            for (const tr of t.querySelectorAll('tr')) {
              const cells = [...tr.querySelectorAll('td,th')].map(c => (c.innerText || '').trim()).filter(Boolean);
              const setName = (n, v) => {
                n = String(n || '').trim(); v = String(v || '').trim();
                if (!n || !v) return;
                if (n.length > 16 || v.length > 40) return;
                if (/^[\\d\\s]+$/.test(n)) return;   // 纯数字跳过（非属性名）
                attrs[n] = v;
              };
              if (cells.length === 2) setName(cells[0], cells[1]);
              else if (cells.length === 4) { setName(cells[0], cells[1]); setName(cells[2], cells[3]); }
              else if (cells.length >= 2) {
                for (let i = 0; i + 1 < cells.length; i += 2) setName(cells[i], cells[i + 1]);
              }
            }
          }
          // 策略2：文本正则兜底（table 未抓到 / 老页面无 table）
          if (!Object.keys(attrs).length) {
            const bodyText = document.body.innerText || '';
            const attrNames = ['面料成分','面料名称','材质成分','主面料成分','主面料成分2','风格类型','风格',
                              '裙型','裙长','适用场景','适用人群','袖型','袖长','上市年份/季节','上市年份季节',
                              '领型','腰型','版型','流行元素','品牌','工艺','图案','货源类型','吊牌',
                              '颜色','货号','款式','成分含量','产地','廓形','门襟','组合形式','是否跨境货源'];
            for (const name of attrNames) {
              const re = new RegExp(name + '[\\t\\s]{1,5}([^\\t\\n\\r]{1,30})', '');
              const m = bodyText.match(re);
              if (m && m[1] && m[1].trim()) attrs[name] = m[1].trim();
            }
          }
          out.attributes = attrs;
        } catch (e) {}
      } catch (e) {}

      // ---- 策略C: 2025新版详情页（document.title + .price-comp）—— 最可靠，无条件优先
      try {
        // 标题：document.title 形如 "xxx商品名 - 阿里巴巴"（最可靠，优先级最高）
        {
          const t = (document.title || '').replace(/\\s*-\\s*阿里巴巴\\s*$/, '').trim();
          if (t && t.length > 3) out.title = t;
        }
        // 价格：.price-comp 文本 "¥|18|.00"（优先级最高）
        {
          const pc = document.querySelector('.price-comp, [class*="price-comp"]');
          if (pc) {
            const t = (pc.innerText || '').replace(/[\\n|]/g, '');
            // "¥18.00" 或 "¥18" 取整数+小数部分（"¥|18|.00" 拼接后形如 ¥18.00，正则取完整数字）
            const m = t.match(/¥\\s*(\\d+(?:\\.\\d+)?)/);
            if (m) { out.price = parseFloat(m[1]); out.priceRange = null; }
          }
          if (out.price == null) {
            const m2 = (document.body.innerText || '').match(/¥\\s*(\\d+(?:\\.\\d+)?)/);
            if (m2) out.price = parseFloat(m2[1]);
          }
        }
      } catch (e) {}

      // ---- DOM 图片与SKU兜底提取（独立 try，避免相互影响）
      try {
        // 主图：页面内前几张 ibank 图（新版详情页主图轮播，src 带 .jpg_.webp）
        if (!out.mainImages.length) {
          const seen = new Set();
          [...document.querySelectorAll('img')].slice(0, 60).forEach(img => {
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
            if (/alicdn\\.com\\/img\\/ibank/.test(src) && seen.size < 6 && !seen.has(src)) {
              seen.add(src);
            }
          });
          out.mainImages = [...seen];
        }
        // 详情图：所有 ibank 图去掉主图（需要滚动后）
        {
          const all = new Set();
          document.querySelectorAll('img').forEach(img => {
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazyload') || '';
            if (/alicdn\\.com\\/img\\/ibank/.test(src)) all.add(src);
          });
          out.detailImages = [...all].filter(u => !out.mainImages.includes(u)).slice(0, 60);
        }
        // SKU：文本解析（按行拆分，找"颜色/尺码/规格"等规格名行，后跟的短行是规格值）
        if (!out.skuGroups.length) {
          const skuEl = document.querySelector('[class*="sku"]');
          if (skuEl) {
            const text = skuEl.innerText || '';
            const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
            const groups = [];
            for (let li = 0; li < lines.length; li++) {
              // 规格名行（短、无数字价格）
              if (/^(颜色|尺码|规格|型号|尺寸|款式|图案|风格|材质)$/.test(lines[li])) {
                const g = { name: lines[li], values: [] };
                for (let lj = li + 1; lj < lines.length; lj++) {
                  const v = lines[lj];
                  if (/^(颜色|尺码|规格|型号|尺寸|款式|图案|风格|材质)$/.test(v)) break;
                  if (/^[¥¥]/.test(v) || /库存/.test(v)) break;
                  if (v.length > 0 && v.length < 40 && !/^\\d+件$/.test(v)) g.values.push(v);
                }
                if (g.values.length) groups.push(g);
              }
            }
            out.skuGroups = groups.slice(0, 3);
          }
        }
        // 一件代发判定（文本兜底）
        if (out.isFenxiao == null) {
          const bt = (document.body.innerText || '').slice(0, 8000);
          out.isFenxiao = /一件代发|可分销|分销商品|支持代发/.test(bt) ? true : false;
        }
        // 运费包邮检测（黑鲸鱼 chkFilterNoFreePost 数据源：页面含"包邮"字样；无运费栏则 null=不拦截）
        if (out.freeShipping == null) {
          const bt2 = (document.body.innerText || '').slice(0, 12000);
          if (/运费|快递|物流/.test(bt2)) out.freeShipping = /包邮|免运费|运费/.test(bt2) && !/不包邮|运费[\\s¥￥][1-9]/.test(bt2);
        }
        // 下架检测（黑鲸鱼 chkDownItem 数据源：详情页不可购买提示）
        if (/宝贝不存在|已下架|已失效|看看其他的吧|访问受限/.test((document.body.innerText || '').slice(0, 6000))) {
          out.offSale = true;
        }
      } catch (e) {}

      // ---- 详情描述接口地址（黑鲸鱼 detailUrl → offer_details.content → GetItemDescImg 同源）
      // 注意：fetch 必须在主进程做（浏览器页面内跨域被 CORS 拦截），这里只提取 URL
      try {
        const df = (window.context && window.context.result && window.context.result.data
          && window.context.result.data.description && window.context.result.data.description.fields) || {};
        const dUrl = df.detailUrl || df.descMburl || df.descUrl || '';
        if (dUrl && /^https?:/.test(dUrl)) out.detailUrl = dUrl;
      } catch (e) {}

      // ---- 供应商 userId（黑鲸鱼 RelationItem1688 supplierUserId：发布后建立分销关联用）
      try {
        const sm = (window.context && window.context.result && window.context.result.global
          && window.context.result.global.globalData && window.context.result.global.globalData.model
          && window.context.result.global.globalData.model.sellerModel) || null;
        if (sm && sm.userId) out.supplierUserId = String(sm.userId);
      } catch (e) {}

      out.title = (out.title || '').trim();
      return out;
    `);
  }

  /**
   * 主进程请求 detailUrl 提取完整详情图（绕过浏览器 CORS）
   * 黑鲸鱼：GET detailUrl → 响应 "var offer_details={"content":"<img...>"}" → 提取全部 img src
   * @returns {string[]} 详情图 URL 列表（可能为空）
   */
  async _fetchDetailImages(detailUrl, mainImages = []) {
    try {
      const resp = await fetch(detailUrl, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Referer': 'https://detail.1688.com/',
        },
      });
      const text = await resp.text();
      let html = text;
      try {
        const body = text.replace(/var offer_details=/, '').replace(/};\s*$/, '}');
        const j = JSON.parse(body);
        if (j && j.content) html = j.content;
      } catch (e) {}
      // 提取所有 img src（黑鲸鱼 GetItemDescImg 同款正则）
      const re = /<img\b[^<>]*?\bsrc[\s\t\r\n]*=[\s\t\r\n]*["']?[\s\t\r\n]*([^\s\t\r\n"'<>]*)/gi;
      const imgs = [];
      let m;
      const mainSet = new Set(mainImages.map(u => u.split('?')[0].replace(/_\d+x\d+[^.]*\./g, '.')));
      while ((m = re.exec(html)) && imgs.length < 80) {
        let u = m[1].replace(/&amp;/g, '&');
        if (/alicdn\.com\/img\/ibank/.test(u)) {
          u = u.split('?')[0].replace(/_\d+x\d+[^.]*\./g, '.');
          if (!mainSet.has(u) && !imgs.includes(u)) imgs.push(u);
        }
      }
      return imgs.slice(0, 60);
    } catch (e) {
      this.logger.warn('collect', `详情图接口请求失败(不影响DOM兜底): ${e.message}`);
      return [];
    }
  }
}

function rand600() { return 500 + Math.floor(Math.random() * 700); }

/**
 * 从 1688 接口响应 JSON 文本中解析商品列表
 * 兼容多种格式：winport unifiedRenderData / mtop offerlist / 任意含 offerId 的 JSON
 */
function parseOffersFromJson(text, url) {
  const items = [];
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }

  if (data) {
    // 结构化遍历：找到所有含 offerId 的对象节点
    const found = new Map();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 12) return;
      if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
      // 判定是否商品节点（offerId 是 12 位左右数字，排除卖家ID等）
      const oid = node.offerId || node.offer_id || (node.offer && node.offer.offerId);
      if (oid && /^\d{11,13}$/.test(String(oid)) && !/^\d{21}/.test(String(oid))) {
        const id = String(oid);
        if (!found.has(id)) {
          found.set(id, {
            offerId: id,
            title: String(node.subject || node.title || node.offerTitle || (node.offer && node.offer.subject) || '').slice(0, 60),
            price: extractPrice(node),
            isFenxiao: detectFenxiao(node),
            source: 'api',
          });
        }
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    };
    walk(data, 0);
    items.push(...found.values());
  }

  // 兜底：只认严格的 detail.1688.com/offer/xxx.html 链接形式（卖家ID等不会出现在这种路径里）
  if (!items.length) {
    const seen = new Set();
    const re1 = /detail\.1688\.com\/offer\/(\d{9,15})\.html/g;
    let m;
    while ((m = re1.exec(text)) !== null) {
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        items.push({ offerId: id, title: '', price: null, isFenxiao: null, source: 'regex' });
      }
    }
  }

  return items;
}

function extractPrice(node) {
  const p = node.priceRange || node.price || (node.offer && node.offer.price) ||
            node.priceInfo || node.tradeModel;
  if (p == null) return null;
  if (typeof p === 'number') return p;
  if (typeof p === 'object') {
    const b = p.begin || p.min || p.priceText || (typeof p.priceText === 'string' && parseFloat(p.priceText));
    if (b != null && !isNaN(parseFloat(b))) return parseFloat(b);
    const s = JSON.stringify(p);
    const m = s.match(/([0-9]+\.?[0-9]*)/);
    if (m) return parseFloat(m[1]);
  }
  const m2 = String(p).match(/([0-9]+\.?[0-9]*)/);
  return m2 ? parseFloat(m2[1]) : null;
}

function detectFenxiao(node) {
  const s = JSON.stringify(node).slice(0, 2000);
  if (/"fenxiao"\s*:\s*true|"isFenxiao"\s*:\s*true|一件代发|可分销/.test(s)) return true;
  return null; // null=未知
}

module.exports = Collector;
