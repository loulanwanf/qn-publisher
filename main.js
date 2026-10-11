/**
 * 千牛铺货助手 - Electron 主进程
 * 1688商品采集 → 自动转换 → 千牛(淘宝卖家中心)自动上架
 */
const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 防崩溃：EPIPE（stdout/调试管道被外部断开，如命令行重定向或调试工具中断）不应弹窗崩溃
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || /broken pipe/i.test(String(err.message || '')))) {
    // 管道断开属环境噪音，静默吞掉避免弹窗
    return;
  }
  try { console.error('[uncaughtException]', err && err.stack || err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[unhandledRejection]', reason && reason.stack || reason); } catch (_) {}
});

// CDP 调试端口：发布器主图上传需 WebSocket CDP 操作跨域 iframe（OOPIF），
// webContents.debugger 对跨域 iframe 支持不完整，必须走远程调试协议
app.commandLine.appendSwitch('remote-debugging-port', '9224');

const Store = require('./core/store');
const Accounts = require('./core/accounts');
const Collector = require('./core/collector');
const { AlibabaCollector } = require('./core/alibaba-collector');
const HotPick = require('./core/hotpick');
const Transform = require('./core/transform');
const Publisher = require('./core/publisher');
const Media = require('./core/media');
const Queue = require('./core/queue');
const Seller = require('./core/seller');
const { Logger } = require('./core/logger');

let mainWindow = null;
let isQuitting = false;
let store, logger, accounts, collector, transform, publisher, media, queue, seller, aliCollector, hotpick;

// 可选：--user-data-dir=xxx 指定独立数据目录（调试/多实例用，避免与已安装版互抢单实例锁）
const uddArg = process.argv.find(a => a.startsWith('--user-data-dir='));
if (uddArg) {
  const dir = uddArg.split('=').slice(1).join('=');
  try { require('fs').mkdirSync(dir, { recursive: true }); } catch (_) {}
  app.setPath('userData', dir);
}

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 旧实例窗口已销毁但进程残留：重建主窗口（双保险，正常情况下不会发生）
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.on('web-contents-created', (event, contents) => {
  // 自动化窗口不开新窗口，全部静默拒绝（夜间无人值守不弹系统浏览器；验证/扫码均在当前窗口内完成）
  contents.setWindowOpenHandler(({ url }) => ({ action: 'deny' }));
  // 渲染进程报错转发到日志（方便远程排查）
  contents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 && logger) {
      logger.log('CONSOLE', 'renderer', message, { line, sourceId });
    }
  });
  contents.on('render-process-gone', (_e, details) => {
    logger && logger.error('app', '渲染进程崩溃', details);
    // 崩溃自愈：主窗口渲染进程崩溃后自动重载（防止长时间白屏）
    if (contents === (mainWindow && mainWindow.webContents) && details && details.reason && details.reason !== 'clean-exit') {
      try { setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); }, 1500); } catch (_) {}
    }
  });
});

/** 崩溃自愈：启动时把上次运行遗留的 publishing（发布中）状态商品恢复为 failed，
 *  并把遗留的 queued（排队中）恢复为 pending——重启后运行标记已丢失，queued 会变成无主死状态 */
function recoverInterruptedPublishing() {
  try {
    const goods = store.goods || [];
    let nPub = 0, nQueued = 0;
    for (const g of goods) {
      if (g.status === 'publishing') {
        g.status = 'failed';
        g.error = '上次运行中断，发布状态未确认，请重试';
        nPub++;
      } else if (g.status === 'queued') {
        g.status = 'pending';
        nQueued++;
      }
    }
    if (nPub || nQueued) {
      store._debounceSave();
      if (nPub) logger.warn('app', `崩溃自愈：恢复 ${nPub} 条中断的发布中商品为失败待重试`);
      if (nQueued) logger.warn('app', `崩溃自愈：恢复 ${nQueued} 条卡在排队中的商品为待上传`);
    }
  } catch (e) {
    try { logger.warn('app', '崩溃自愈检查失败: ' + e.message); } catch (_) {}
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1200,
    minHeight: 760,
    title: '千牛铺货助手',
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 点关闭按钮：走统一退出流程（后台隐藏的采集/工作窗口不会自动关闭，
  // 不主动清理会导致进程残留、单实例锁被占、下次打不开）
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); gracefulShutdown(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** 统一退出：停队列 → 销毁全部后台窗口 → 数据立即落盘 → 退出 */
function gracefulShutdown() {
  if (isQuitting) return;
  isQuitting = true;
  try { queue && queue.shutdown(); } catch (_) {}
  try { accounts && accounts.destroyAllWindows(); } catch (_) {}
  try { collector && collector.destroyWindows(); } catch (_) {}
  try { store && store.flushSave(); } catch (_) {}
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch (_) {}
  app.quit();
}

function initModules() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  store = new Store(dataDir);
  logger = new Logger(path.join(dataDir, 'logs'));
  accounts = new Accounts(store, logger);
  media = new Media(store, logger);
  collector = new Collector({ accounts, store, logger, media });
  aliCollector = new AlibabaCollector({ collector, logger });
  hotpick = new HotPick({ aliCollector, store, logger });
  transform = new Transform(store);
  publisher = new Publisher({ accounts, store, logger, media });
  seller = new Seller({ accounts, store, logger });
  queue = new Queue({ store, logger, collector, transform, publisher, media, accounts });
  // 崩溃自愈：上次运行异常中断时（发布中状态卡死），恢复为失败待重试
  recoverInterruptedPublishing();
  // 发布步骤进度 → 前端进度卡片
  publisher.onProgress = (p) => sendProgress(p);
  // seller 同步步骤进度 → 前端进度卡片
  seller.onProgress = (p) => sendProgress(p);
  // 热点选品进度 → 前端进度卡片
  hotpick.on('progress', (p) => sendProgress(p));

  queue.on('progress', (info) => send('queue:progress', info));
  queue.on('log', (entry) => send('log:push', entry));
  queue.on('stats', (s) => send('queue:stats', s));

  // 定时启动上传（黑鲸鱼主壳 TimerTask 等价：每天到点自动启动队列，当天只触发一次）
  startAutoUploadTimer();
  // 登录态定时巡检：每 30 分钟轻量 cookie 判定，过期推送前端告警（不打断采集）
  startLoginPatrol();
  // 启动时彻底检测账号登录态：过期自动清除旧会话并醒目提示重新扫码
  startupAccountCheck();

  // 首启免责声明（商用合规：风险告知，同意一次后不再弹）
  if (!store.settings.agreedDisclaimer) {
    send('app:disclaimer-needed', { version: app.getVersion() || '1.0.0' });
  }

  registerIPC();
}

/** 登录态自动巡检：cookie 级轻量判定（不导航页面），结果推送 acc:patrol
 *  前端可据此变红提示"请重新扫码"。每 30 分钟跑一次（启动时的彻底检测由 startupAccountCheck 负责）。
 */
function startLoginPatrol() {
  let busy = false;
  const run = async () => {
    if (busy || !accounts || !store.accounts || !store.accounts.length) return;
    busy = true;
    try {
      const r = await accounts.patrol();
      send('acc:patrol', r);
      const expired = [];
      if (r.shop && r.shop.status !== 'ok') expired.push(r.shop.name);
      for (const c of r.collect || []) if (c.status !== 'ok') expired.push(c.name);
      if (expired.length) logger.warn('acc', '登录态巡检：以下账号已失效 → ' + expired.join(' / '));
    } catch (e) {
      try { logger.warn('acc', '登录态巡检失败: ' + e.message); } catch (_) {}
    } finally {
      busy = false;
    }
  };
  setInterval(run, 30 * 60 * 1000).unref();
}

/** 启动时彻底检测账号登录态：cookie 判定 + 真实页面探活，过期则清除旧会话并推送 acc:startup-expired
 *  延后 6 秒执行，等主窗口与免责声明就绪后再跑，避免与首启抢资源。
 */
function startupAccountCheck() {
  setTimeout(async () => {
    try {
      if (!accounts || !store.accounts || !store.accounts.length) return;
      logger.info('accounts', `启动检测：开始检测 ${store.accounts.length} 个账号登录态…`);
      const r = await accounts.startupCheckAll();
      // 刷新顶栏（patrol 摘要格式）
      const patrol = await accounts.patrol();
      send('acc:patrol', patrol);
      // 过期账号推醒目横幅
      if (r.expired && r.expired.length) {
        send('acc:startup-expired', { expired: r.expired, checked: r.checked, cleared: r.cleared });
        logger.warn('accounts', `启动检测完成：${r.expired.length} 个账号过期已清除会话 → ${r.expired.map(x => x.name).join(' / ')}`);
      } else {
        logger.success('accounts', `启动检测完成：${r.checked} 个账号登录态均正常`);
      }
    } catch (e) {
      try { logger.warn('accounts', '启动检测失败: ' + e.message); } catch (_) {}
    }
  }, 6 * 1000);
}

/** 每分钟检查 upset.autoStartTime（"HH:MM"），到点自动启动上传队列（当天已触发不重复） */
function startAutoUploadTimer() {
  let lastFiredDay = '';
  setInterval(async () => {
    try {
      const up = (store.settings && store.settings.upset) || {};
      const t = String(up.autoStartTime || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(t)) return;
      const [hh, mm] = t.split(':').map(Number);
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const isDue = now.getHours() === hh && now.getMinutes() >= mm && now.getMinutes() < mm + 2;
      if (!isDue || lastFiredDay === today) return;
      lastFiredDay = today;
      const running = await Promise.resolve(queue.status && queue.status().running);
      if (running) {
        logger.info('queue', `定时启动(${t})：队列已在运行，跳过`);
        return;
      }
      logger.success('queue', `定时启动上传：到达 ${t}，自动启动队列`);
      send('log:push', { level: 'ok', tag: '队列', time: Date.now(), message: `定时启动：到达 ${t}，自动开始上传` });
      const r = await queue.start();
      logger.info('queue', `定时启动结果: ${r && r.message}`);
    } catch (e) {
      try { logger.warn('queue', '定时启动检查失败: ' + e.message); } catch (_) {}
    }
  }, 60 * 1000).unref();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 广播采集类进度到前端进度卡片
 *  p: { key, title, detail, percent(0~100|null), done, error }
 */
function sendProgress(p) {
  send('collect:progress', p);
}

/** 包装长流程 IPC：自动发进度事件（开始/结束），内部阶段由模块 emitter 上报
 *  注意：第一个参数是 ipc event，必须剥掉后再传给 fn
 */
function withProgress(key, title, fn) {
  return async (_e, ...args) => {
    sendProgress({ key, title, detail: '准备中…', percent: 0 });
    try {
      const r = await fn(...args);
      const errMsg = r && r.ok === false ? (r.message || r.error || '失败') : null;
      sendProgress({
        key, title,
        detail: errMsg || (r && r.message) || '完成',
        percent: errMsg ? null : 100,
        done: true,
        error: !!errMsg,
      });
      return r;
    } catch (e) {
      sendProgress({ key, title, detail: e.message, done: true, error: true });
      throw e;
    }
  };
}

function registerIPC() {
  // ---------- 配置 ----------
  ipcMain.handle('config:get', () => store.getSettings());
  ipcMain.handle('config:save', (e, patch) => store.saveSettings(patch));
  // 手动立即备份数据 / 列出备份
  ipcMain.handle('app:backupNow', () => ({ ok: true, dir: store.backupNow() }));
  ipcMain.handle('app:listBackups', () => store.listBackups());

  // ---------- 账号 ----------
  ipcMain.handle('accounts:list', () => accounts.list());
  ipcMain.handle('accounts:add', (e, type, name) => accounts.add(type, name));
  ipcMain.handle('accounts:remove', (e, id) => accounts.remove(id));
  ipcMain.handle('accounts:patrol', () => accounts.patrol());
  ipcMain.handle('accounts:login', async (e, id) => {
    // 打开可见窗口扫码；返回 {ok, message}
    return accounts.openLogin(id, mainWindow);
  });
  ipcMain.handle('accounts:check', async (e, id) => accounts.checkLogin(id));
  ipcMain.handle('accounts:setCred', (e, id, u, p) => accounts.setCredential(id, u, p));

  // ---------- 采集 ----------
  ipcMain.handle('collect:preview', withProgress('preview-shop', '全店采集', async (params) => {
    // 预览：抓分类/店铺商品列表（仅ID+标题+价格），不抓详情
    const r = await collector.previewShop(params);
    // 记录店铺（全店采集场景）
    if (params && params.shopUrl) {
      store.recordShop({
        shopUrl: params.shopUrl,
        name: params.shopName || '',
        goodsCount: (r.items || []).length,
      });
    }
    return r;
  }));
  // 阶段进度转发（collector 发的细分进度）
  const fwd = (p) => sendProgress(p);
  collector.on && collector.on('progress', fwd);

  ipcMain.handle('collect:start', withProgress('collect-details', '链接采集', async (params) => {
    return collector.collectDetails(params);
  }));
  ipcMain.handle('collect:keyword', withProgress('collect-keyword', '关键词采集', async (params) => {
    return collector.collectByKeyword(params);
  }));
  ipcMain.handle('collect:verifyShop', withProgress('verify-shop', '验证店铺', async (url) => {
    return collector.verifyShop(url);
  }));

  // ---------- 阿里巴巴采集（黑鲸鱼 alibabasource 移植：一键代发/低价/优质P4P/全店mtop/工厂店） ----------
  ipcMain.handle('collect:daixiao', withProgress('ali-daixiao', '一键代发采集', async (params) => {
    return aliCollector.daixiaoList(params || {});
  }));
  ipcMain.handle('collect:premium', withProgress('ali-premium', '优质货源采集', async (params) => {
    return aliCollector.premiumList(params || {});
  }));
  ipcMain.handle('collect:shopMtop', withProgress('ali-shop', '全店采集', async (params) => {
    return aliCollector.shopItems(params || {});
  }));
  ipcMain.handle('collect:shopCate', withProgress('ali-shop-cate', '店铺分类', async (url) => {
    return aliCollector.shopCate(url);
  }));
  ipcMain.handle('collect:factoryTabs', withProgress('ali-factory', '工厂店分类', async (url) => {
    return aliCollector.factoryTabs(url);
  }));
  ipcMain.handle('collect:factoryItems', withProgress('ali-factory', '工厂店采集', async (params) => {
    return aliCollector.factoryItems(params || {});
  }));

  // ---------- 热点选品（关键词→1688月销排序→评分→Top N→用户勾选→采集上传） ----------
  ipcMain.handle('hotpick:search', withProgress('hotpick', '热点选品', async (params) => {
    return hotpick.search(params || {});
  }));

  // ---------- 全店采集配套（黑鲸鱼 Form全店采集 剩余功能：参谋/好评率/轻量详情/供应商搜索） ----------
  ipcMain.handle('collect:proxyAdvice', withProgress('ali-proxy', '代发参谋数据', async (offerId, memberId) => {
    return aliCollector.proxyAdvice(offerId, memberId);
  }));
  ipcMain.handle('collect:queryRate', withProgress('ali-rate', '好评率数据', async (params) => {
    return aliCollector.queryRate((params || {}).offerId, (params || {}).loginId, (params || {}).sellerMemberId);
  }));
  ipcMain.handle('collect:itemLite', withProgress('ali-itemlite', '详情信息', async (offerId) => {
    return aliCollector.itemDetailLite(offerId);
  }));
  ipcMain.handle('collect:searchCompany', withProgress('ali-company', '供应商搜索', async (name) => {
    return aliCollector.searchCompany(name);
  }));
  // 全店采集辅助文件（黑鲸鱼 fidderwords.txt 标题过滤词 / export\temp 已导出ID / searchcache 导出缓存）
  const AUX = {
    filterwords: { file: 'filterwords.txt', type: 'text' },
    exported: { file: 'exported-ids.txt', type: 'ids' },
    searchcache: { file: 'searchcache.json', type: 'cache' },
  };
  function auxPath(name) {
    const cfg = AUX[name];
    if (!cfg) throw new Error('未知辅助文件: ' + name);
    return require('path').join(store.dir, cfg.file);
  }
  ipcMain.handle('collect:auxFile', async (e, op, name, data) => {
    const fs = require('fs');
    const path = require('path');
    const p = auxPath(name);
    try {
      if (op === 'read') {
        if (!fs.existsSync(p)) return name === 'searchcache' ? [] : '';
        const txt = fs.readFileSync(p, 'utf8');
        if (name === 'exported') return txt.split(/[\s,]+/).filter(Boolean);
        if (name === 'searchcache') { try { return JSON.parse(txt) || []; } catch (_) { return []; } }
        return txt;
      }
      if (op === 'append') {
        if (name === 'exported') {
          fs.appendFileSync(p, (Array.isArray(data) ? data : [data]).map(x => String(x)).join(',') + ',');
        } else if (name === 'searchcache') {
          let arr = [];
          try { arr = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) || []) : []; } catch (_) {}
          arr.push({ time: Date.now(), data });
          fs.writeFileSync(p, JSON.stringify(arr), 'utf8');
        } else {
          fs.appendFileSync(p, String(data || ''));
        }
        return { ok: true };
      }
      if (op === 'write') { fs.writeFileSync(p, String(data || ''), 'utf8'); return { ok: true }; }
      if (op === 'clear') { fs.writeFileSync(p, name === 'searchcache' ? '[]' : '', 'utf8'); return { ok: true }; }
      if (op === 'open') {
        if (!fs.existsSync(p)) fs.writeFileSync(p, name === 'searchcache' ? '[]' : '', 'utf8');
        require('electron').shell.openPath(p);
        return { ok: true };
      }
      return { ok: false, message: '未知操作: ' + op };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // ---------- 商品库 ----------
  ipcMain.handle('goods:list', (e, filter) => store.listGoods(filter));
  ipcMain.handle('goods:update', (e, id, patch) => store.updateGoods(id, patch));
  ipcMain.handle('goods:remove', (e, id) => store.removeGoods(id));
  ipcMain.handle('goods:clear', (e, status) => store.clearGoods(status));
  // 轻量导入：仅存offerId到上传列表，不触发详情采集（上传时自动补采）
  ipcMain.handle('goods:addBatchLite', async (_e, items) => {
    const result = { added: 0, skipped: 0, message: '' };
    for (const it of (items || [])) {
      if (!it || !it.offerId) continue;
      if (store.goodsByOffer(String(it.offerId))) { result.skipped++; continue; }
      store.addGoods([{ offerId: String(it.offerId), title: '待采集 ' + it.offerId }]);
      result.added++;
    }
    result.message = result.added ? `已导入 ${result.added} 个链接${result.skipped ? `，跳过 ${result.skipped} 个已存在` : ''}（上传时自动采集详情）` : '全部已存在，无需导入';
    return result;
  });
  // 补下载宝贝图片：勾选商品本地无主图缓存时，补采详情并下载（黑鲸鱼"下载宝贝图片"）
  ipcMain.handle('goods:ensureImages', async (_e, ids) => {
    const out = { done: 0, skipped: 0, failed: [], fails: [] };
    for (const id of (ids || [])) {
      const g = store.goodsById(id);
      if (!g) { out.failed.push(String(id)); continue; }
      try {
        const imgs = media.localPaths(g.offerId);
        if (imgs.main && imgs.main.length) { out.skipped++; continue; }
        const data = await collector.collectOne(g.offerId, { downloadImages: true });
        g.raw = data;
        g.title = data.title || g.title;
        g.updatedAt = Date.now();
        store._debounceSave();
        out.done++;
      } catch (e) {
        out.failed.push(String(g.offerId));
        out.fails.push({ offerId: g.offerId, message: e.message });
      }
    }
    store.flushSave();
    return out;
  });
  ipcMain.handle('goods:addBatch', withProgress('add-upload-list', '添加到上传列表', async (items) => {
    // 添加到上传列表：未采集详情的先采详情，已采集的直接入库
    const result = { added: 0, message: '' };
    const needDetail = [];
    for (const it of (items || [])) {
      if (store.goodsByOffer(it.offerId)) continue;
      needDetail.push(it.offerId);
    }
    if (needDetail.length) {
      const r = await collector.collectDetails({ offerIds: needDetail, downloadImages: true });
      result.added = r.ok;
      result.message = `已采集并添加 ${r.ok} 个（失败${r.fail}）到上传列表`;
    } else {
      result.added = 0;
      result.message = '宝贝已在列表中';
    }
    return result;
  }));

  // ---------- 工具功能（黑鲸鱼同款控件对应实现） ----------
  // 类目查询（黑鲸鱼 btnFindCategoryClick：get_asyncOpt_categorySearch）
  ipcMain.handle('tao:categorySearch', async (e, keyword) => {
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先在店铺管理登录商家账号' };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    const cats = await api.categorySearch(String(keyword || '').trim());
    return { ok: true, cats };
  });
  // 店铺分类（黑鲸鱼 UploadItemApi.GetShopCat：manage.render → filter → queryShopCategoryId）
  ipcMain.handle('tao:shopCats', async () => {
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先在店铺管理登录商家账号', cats: [] };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    const cats = await api.getShopCats();
    return { ok: true, cats };
  });
  // 门店列表（黑鲸鱼 UploadItemApi.GetShopStore：place.taobao.com getStoreList.do，适用商户）
  ipcMain.handle('tao:shopStores', async () => {
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先在店铺管理登录商家账号', stores: [] };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    try {
      const stores = await api.getShopStores();
      return { ok: true, stores };
    } catch (e) {
      return { ok: false, message: e.message, stores: [] };
    }
  });
  // 宝贝批量删除（黑鲸鱼 ItemManage batchDeleteItem）
  ipcMain.handle('item:delete', async (e, itemIds) => {
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先在店铺管理登录商家账号' };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    return api.deleteItems(itemIds);
  });

  // ---------- 供应商管理（退货地址 / 失联下架） ----------
  ipcMain.handle('suppliers:list', () => store.listSuppliers());
  /** 从商品库扫描所有供应商（按 raw.supplierUserId 去重），自动创建条目（已存在的不覆盖退货地址） */
  ipcMain.handle('suppliers:syncFromGoods', () => {
    const seen = new Set(store.suppliers.map(s => s.supplierUserId));
    let added = 0;
    for (const g of store.goods) {
      const uid = g.raw && g.raw.supplierUserId;
      if (!uid || seen.has(String(uid))) continue;
      seen.add(String(uid));
      store.upsertSupplier({
        supplierUserId: uid,
        shopName: (g.raw && g.raw.companyName) || (g.raw && g.raw.shopName) || '',
        returnAddress: '',
        status: 'active',
      });
      added++;
    }
    if (added) send('suppliers:updated');
    return { ok: true, added, total: store.suppliers.length };
  });
  ipcMain.handle('suppliers:upsert', (e, data) => store.upsertSupplier(data));
  ipcMain.handle('suppliers:remove', (e, id) => store.removeSupplier(id));
  ipcMain.handle('suppliers:markGhost', (e, id) => {
    const r = store.markSupplierGhost(id);
    if (r) send('suppliers:updated');
    return r;
  });
  /** 失联供应商一键下架：查出该供应商所有已发布商品 numIid → 调 deleteItems 批量删除 */
  ipcMain.handle('suppliers:delistBySupplier', withProgress('delist-supplier', '下架失联供应商商品', async (supplierId) => {
    const supplier = store.suppliers.find(s => s.id === supplierId);
    if (!supplier) return { ok: false, message: '供应商不存在' };
    const itemIds = store.getItemIdsBySupplier(supplier.supplierUserId);
    if (!itemIds.length) return { ok: false, message: '该供应商暂无可下架商品（无发布记录或未关联供应商）' };
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先登录店铺账号' };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    const r = await api.deleteItems(itemIds);
    if (r && r.ok) {
      // 标记商品库中对应商品为已下架
      for (const g of store.goods) {
        if (g.raw && String(g.raw.supplierUserId) === String(supplier.supplierUserId)) {
          g.status = 'delisted';
          g.needDelist = false;
        }
      }
      store._debounceSave();
      send('suppliers:updated');
    }
    return { ...r, delistedCount: itemIds.length };
  }));
  // 导入商品数据包（JSON：[{offerId,title,price,mainImages,...}]，兼容本工具采集详情格式）
  ipcMain.handle('app:importGoods', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入商品数据包（JSON）',
      filters: [{ name: '数据包', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, message: '已取消' };
    try {
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
      if (!items) return { ok: false, message: '数据包格式不正确（需 JSON 数组）' };
      let added = 0, skipped = 0;
      const fresh = items.filter(it => it && it.offerId);
      for (const it of fresh) {
        if (store.goodsByOffer(String(it.offerId))) { skipped++; continue; }
        store.addGoods([{ ...it, offerId: String(it.offerId), title: it.title || ('宝贝' + it.offerId) }]);
        added++;
      }
      return { ok: true, message: `导入完成：新增 ${added} 个${skipped ? `，跳过已存在 ${skipped} 个` : ''}` };
    } catch (err) {
      return { ok: false, message: '导入失败：' + err.message };
    }
  });
  // 选择 txt 文件读文本（标题过滤词/清理词/自定义标题导入）
  ipcMain.handle('app:pickTextFile', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入词库文本（每行一个）',
      filters: [{ name: '文本文件', extensions: ['txt', 'csv'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, text: '' };
    const fs = require('fs');
    return { ok: true, text: fs.readFileSync(r.filePaths[0], 'utf8') };
  });
  // 清理图片缓存（store.imgDir 下的下载缓存）
  ipcMain.handle('app:clearImageCache', async () => {
    const fs = require('fs');
    const path = require('path');
    const imgDir = store.imgDir;
    let size = 0, count = 0;
    try {
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) walk(p);
          else { size += fs.statSync(p).size; count++; fs.unlinkSync(p); }
        }
      };
      walk(imgDir);
      return { ok: true, message: `缓存已清理：${count} 个文件（${(size / 1024 / 1024).toFixed(1)} MB）` };
    } catch (err) {
      return { ok: false, message: '清理失败：' + err.message };
    }
  });

  // ---------- 查重（数据源：卖家中心 1688铺货商品页；兜底：在售商品商家编码） ----------
  // 拉取店铺已铺货/在售商品列表，与本地商品库 offerId 比对，命中即打标 dupItemId/dupSource
  ipcMain.handle('check:dup', withProgress('dup-check', '查重（1688铺货）', async () => {
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先在店铺管理登录商家账号' };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);

    // 1. 主数据源：卖家中心 1688铺货商品列表（commodity-center-1688/offer，DOM 提取 offerId/itemId）
    let listed = [];
    let source = '1688铺货';
    let sourceMsg = '';
    try {
      listed = await api.getCommodity1688Products();
      sourceMsg = `1688铺货 ${listed.length} 件`;
    } catch (e) {
      logger.warn('dup', '1688铺货列表拉取失败: ' + e.message);
      // 2. 兜底数据源：在售商品列表（商家编码=offerId）
      try {
        const onsale = await api.getOnSaleItems();
        listed = onsale
          .filter(it => it.code)
          .map(it => ({ offerId: it.code, itemId: it.itemId, srcTitle: it.title, taobaoTitle: it.title, srcPrice: it.price, taobaoPrice: '', status: '在售' }));
        source = '在售';
        sourceMsg = `在售列表 ${listed.length} 件`;
      } catch (e2) {
        return { ok: false, message: '查重失败：1688铺货页(' + e.message + ')，在售列表也失败(' + e2.message + ')' };
      }
    }

    // 3. 与本地上传列表比对（offerId 精确匹配）
    const byOffer = new Map();
    for (const it of listed) if (it.offerId) byOffer.set(String(it.offerId), it);
    const goods = store.goods;
    const dup = [];
    for (const g of goods) {
      const hit = byOffer.get(String(g.offerId));
      if (hit) {
        dup.push({ id: g.id, offerId: g.offerId, title: g.title, itemId: hit.itemId, taobaoTitle: hit.taobaoTitle || hit.srcTitle, source });
      }
    }
    // 4. 打标（存到商品上，列表行显示"已铺货"；队列跳过逻辑也读这些字段）
    const now = Date.now();
    const dupMap = new Map(dup.map(d => [d.id, d]));
    for (const g of goods) {
      const d = dupMap.get(g.id);
      if (d) {
        store.updateGoods(g.id, { dupItemId: d.itemId, dupSource: source, dupCheckedAt: now });
      } else if (g.dupItemId) {
        // 之前标记过重复、现在列表里没有了 → 清除标记（比如商品已删除/取消代发）
        store.updateGoods(g.id, { dupItemId: null, dupSource: null, dupCheckedAt: null });
      }
    }
    logger.success('dup', `查重完成：本地 ${goods.length} 个，${sourceMsg}，命中重复 ${dup.length} 个`);
    return { ok: true, total: goods.length, dupCount: dup.length, source, sourceMsg, dup, checkedAt: now };
  }));
  // 清除本地商品重复标记（用户自行核对后重置）
  ipcMain.handle('check:dupReset', async () => {
    let n = 0;
    for (const g of store.goods) {
      if (g.dupItemId) { store.updateGoods(g.id, { dupItemId: undefined, dupSource: null, dupCheckedAt: null }); n++; }
    }
    return { ok: true, cleared: n };
  });

  // ---------- AI 整店运营（多服务商 OpenAI 兼容；无 Key 演示模式） ----------
  const AIEngineMod = require('./core/ai');
  const aiEngine = new AIEngineMod.AiEngine({ store, logger });
  ipcMain.handle('ai:configGet', () => aiEngine.getConfig());
  ipcMain.handle('ai:configSave', (_e, cfg) => aiEngine.saveConfig(cfg || {}));
  ipcMain.handle('ai:test', withProgress('ai-test', 'AI 连接测试', (cfg) => aiEngine.test(cfg || {})));
  // 一键整店运营：拉取店铺在售 + 本地商品 → 诊断/优化 → 报告
  ipcMain.handle('ai:operate', withProgress('ai-operate', 'AI 整店运营', async (opts = {}) => {
    const items = [];
    const seen = new Set();
    // 本地商品库（待上传/失败/已上传均含标题）
    for (const g of store.goods) {
      if (!g.title) continue;
      items.push({ id: g.id, offerId: g.offerId, title: g.title, price: (g.raw && g.raw.price) || g.sellPrice || 0, status: g.status, source: '本地' });
      seen.add(g.title);
    }
    // 店铺在售商品（getOnSaleItems 商家编码=offerId）
    const shop = store.accounts.find(a => a.type === 'shop');
    if (shop) {
      try {
        const win = await accounts.getWorkWindow(shop, { show: false });
        const { TaoApi } = require('./core/taobao-api');
        const api = new TaoApi(win.webContents.session, win);
        const onsale = await api.getOnSaleItems();
        for (const it of onsale) {
          if (!it.title || seen.has(it.title)) continue;
          items.push({ id: null, offerId: it.code || it.itemId, title: it.title, price: parseFloat(it.price) || 0, status: 'published', source: '在售' });
          seen.add(it.title);
        }
        if (onsale.length) logger.info('ai', `整店运营：并入在售商品 ${onsale.length} 件`);
      } catch (e) {
        logger.warn('ai', '在售列表并入失败（仅用本地商品）: ' + e.message);
      }
    }
    const cfg = aiEngine.getConfig();
    const mode = opts.mode || (cfg.apiKey ? 'auto' : 'demo');
    return await aiEngine.operate(items, { mode, batch: opts.batch || 20, onProgress: (d) => logger.info('ai', d) });
  }));
  // 应用 AI 优化标题到本地商品库（仅本地，不改线上）
  ipcMain.handle('ai:applyTitles', async (_e, list) => {
    let n = 0;
    for (const it of (list || [])) {
      if (!it.id || !it.optimizedTitle) continue;
      const g = store.goodsById(it.id);
      if (g) { g.title = String(it.optimizedTitle).trim(); n++; }
    }
    store._debounceSave();
    return { ok: true, applied: n };
  });
  // 导出报告（txt 落盘到用户数据目录）
  ipcMain.handle('ai:exportReport', (_e, report) => {
    try {
      const lines = [];
      lines.push('AI 整店运营报告 ' + new Date().toLocaleString('zh-CN', { hour12: false }));
      lines.push('模式: ' + (report && report.provider) + ' / ' + (report && report.model));
      lines.push('商品总数: ' + ((report && report.stats && report.stats.total) || 0) + '  违禁词: ' + ((report && report.stats && report.stats.forbidden) || 0) + '  标题过长: ' + ((report && report.stats && report.stats.longTitle) || 0) + '  价格异常: ' + ((report && report.stats && report.stats.priceIssue) || 0));
      lines.push('');
      for (const it of ((report && report.items) || [])) {
        lines.push('【' + it.title + '】');
        lines.push('  问题: ' + (it.issues || []).join('; '));
        if (it.forbiddenWords && it.forbiddenWords.length) lines.push('  违禁词: ' + it.forbiddenWords.join('/'));
        if (it.optimizedTitle) lines.push('  优化标题: ' + it.optimizedTitle);
        if (it.salesPoints) lines.push('  卖点: ' + it.salesPoints);
        if (it.descSuggestion) lines.push('  详情建议: ' + it.descSuggestion);
        if (it.demoNote) lines.push('  备注: ' + it.demoNote);
      }
      const dir = path.join(app.getPath('userData'), 'data');
      const file = path.join(dir, 'ai-report-' + Date.now() + '.txt');
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ---------- AI 推荐上传设置（根据商品库数据分析→推荐价格策略/标题/品牌/类目等参数） ----------
  ipcMain.handle('ai:recommendSettings', async () => {
    // 从商品库取样本（最多100条，只要有标题+价格的）
    const goods = store.goods || [];
    const items = goods.filter(g => g.title || (g.raw && g.raw.title)).slice(0, 100).map(g => ({
      title: g.title || (g.raw && g.raw.title) || '',
      price: g.cost != null ? g.cost : (g.raw && (g.raw.price || g.raw.consignPrice)) || g.price || null,
    }));
    return aiEngine.recommendSettings(items);
  });

  // ---------- AI 全店托管运营（自动闭环：盘点→诊断→自动执行→日报） ----------
  const AIEngineMod2 = require('./core/ai');
  const { HostedManager } = require('./core/hosted');
  const hosted = new HostedManager({ store, logger, accounts, aiEngine: new AIEngineMod2.AiEngine({ store, logger }) });
  ipcMain.handle('host:configGet', () => hosted.getConfig());
  ipcMain.handle('host:configSave', (_e, patch) => hosted.saveConfig(patch || {}));
  ipcMain.handle('host:status', () => hosted.status());
  ipcMain.handle('host:run', withProgress('host-run', 'AI 托管运营', async () => hosted.runCycle({ reason: 'manual' })));
  ipcMain.handle('host:records', async (_e, limit = 20) => {
    const list = store.records.filter(r => r.type === 'host').slice(-(limit || 20)).reverse();
    return list;
  });

  // ---------- 任务 ----------
  ipcMain.handle('queue:add', (e, goodsIds) => queue.add(goodsIds));
  ipcMain.handle('queue:start', () => queue.start());
  ipcMain.handle('queue:pause', () => queue.pause());
  ipcMain.handle('queue:status', () => queue.status());
  ipcMain.handle('queue:stats', () => queue.stats());
  ipcMain.handle('queue:remove', (e, id) => queue.remove(id));

  // ---------- 店铺管理（千牛商家账号后台信息） ----------
  ipcMain.handle('seller:sync', withProgress('seller-sync', '同步店铺后台信息', async (opts) => seller.syncInfo(opts || {})));
  ipcMain.handle('seller:info', () => store.sellerInfo);

  // ---------- 上传记录 ----------
  ipcMain.handle('records:get', (e, n) => ({ items: store.listRecords(n || 100) }));

  // ---------- 店铺管理（历史采集店铺，在全店采集页展示） ----------
  ipcMain.handle('shops:list', () => ({ items: store.listShops() }));
  ipcMain.handle('shops:remove', (e, id) => store.removeShop(id));

  // ---------- 日志 ----------
  ipcMain.handle('logs:recent', (e, n) => logger.recent(n));

  // ---------- 试运行/调试 ----------
  ipcMain.handle('debug:testPublish', async (e, goodsId) => {
    // 单品试发布（不点提交，填完暂停），用于首次联调
    return publisher.debugPublish(goodsId);
  });
  // API 诊断：直接调 TaoApi 各接口返回原始结果（联调用）
  ipcMain.handle('debug:apiDiag', async (e, cmd, arg) => {
    const { TaoApi } = require('./core/taobao-api');
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { error: 'no shop' };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const api = new TaoApi(win.webContents.session, win);
    if (cmd === 'init') {
      await api.init();
      return { token: api.cyToken.slice(0, 12) + '...', cookieLen: api.cyCookie.length };
    }
    if (cmd === 'shopCatsRaw') {
      // 店铺分类原始响应诊断（GetShopCat 移植联调）
      try {
        const data = await api._mtopTao('mtop.taobao.sell.pc.manage.render', '1.0', { tab: 'in_stock' }, { method: 'POST' });
        const str = JSON.stringify(data);
        // 输出完整结构 + 组件名清单（找商品列表组件）
        let compNames = [];
        let itemHead = '';
        let tableDump = '';
        let resultKeys = [];
        try {
          let result = (data || {}).result;
          if (typeof result === 'string') result = JSON.parse(result);
          const arr = (result && result.data) || [];
          compNames = arr.map(x => (x || {}).name).filter(Boolean);
          resultKeys = Object.keys(result || {});
          // table 组件（商品列表）完整 dump
          const t = arr.find(x => (x || {}).name === 'table');
          if (t) tableDump = JSON.stringify(t).slice(0, 6000);
          // 找含 title 的组件片段（标题字段名可能不叫 title）
          const i = str.indexOf('"title"');
          itemHead = i >= 0 ? str.slice(Math.max(0, i - 400), i + 800) : '';
        } catch (_) {}
        return { len: str.length, comps: compNames.slice(0, 60), itemHead, tableDump, resultKeys };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'manageAsync') {
      // 在售/全部商品列表诊断（黑鲸鱼 mtop.taobao.sell.pc.manage.async 移植：用于代发分销查重）
      try {
        const data = await api._mtopTao('mtop.taobao.sell.pc.manage.async', '1.0', {
          url: '/taobao/manager/table.htm',
          jsonBody: JSON.stringify({
            tab: 'in_stock',
            pagination: { current: 1, pageSize: 20 },
            filtertab: '',
            filter: {},
            table: { sort: { upShelfDate_m: 'desc' } }
          })
        }, { method: 'POST' });
        const str = JSON.stringify(data);
        let items = [];
        let resultKeys = [];
        let rowRaw = '';
        let pageInfo = '';
        try {
          let result = (data || {}).result;
          if (typeof result === 'string') result = JSON.parse(result);
          resultKeys = Object.keys(result || {});
          const t = (result || {}).data && (result.data.table || {});
          const ds = (t && t.dataSource) || [];
          rowRaw = JSON.stringify(ds[0] || {}).slice(0, 2000);
          pageInfo = JSON.stringify((result || {}).data && (result.data.pagination || {})).slice(0, 500);
          items = ds.slice(0, 30).map(d => ({
            itemId: d.itemId,
            desc: ((d.itemDesc || {}).value || '').slice(0, 60),
            upDate: ((d.upShelfDate_m || {}).value || '')
          }));
        } catch (e) { items = [{ parseError: e.message }]; }
        return { len: str.length, resultKeys, itemCount: items.length, pageInfo, rowRaw, items, rawHead: str.slice(0, 600) };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'getOnSaleItems') {
      // 验证正式方法 getOnSaleItems（代发分销查重数据源）
      try {
        const items = await api.getOnSaleItems();
        return { count: items.length, sample: items.slice(0, 5), all: items };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'pageComponentsDiag') {
      // 发布页组件诊断：找尺码表组件定义（render.json 失效后的替代数据源）
      try {
        const pd = await api.getPublishPageData(arg || '50010850');
        const comps = (pd.raw && pd.raw.components) || {};
        const keys = Object.keys(comps);
        const sizeRelated = {};
        for (const k of keys) {
          if (/size|Size|chart|Chart/.test(k)) sizeRelated[k] = JSON.stringify(comps[k]).slice(0, 1200);
        }
        return { total: keys.length, keys: keys.join(','), sizeRelated };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'sizeMapRaw') {
      // 尺码表 render.json 原始响应诊断（GetSizeMap 移植联调）
      try {
        let xsrf = '';
        try { xsrf = await api._cookie('XSRF-TOKEN'); } catch (_) {}
        const body = 'jsonBody=' + encodeURIComponent(JSON.stringify({
          sizeRecommend: { supportOneDim: true, disabled: false },
          sizeMapping: { disabled: false },
          sizeModelTryInfo: { disabled: false },
          brandId: 3246379, groupId: 'sizeGroup_136553091-men_tops', groupType: 'men_tops', selectedSizes: [],
        }));
        const r = await api._fetch(`https://item.upload.taobao.com/taobao/size/chart/v3/render.json?sizeType=sizeMappingV3&catId=${arg || 50010850}&recommend=true&mapping=true&model=true&itemId=0`, {
          method: 'POST', body, contentType: 'application/x-www-form-urlencoded',
          referer: `https://item.upload.taobao.com/sell/v2/publish.htm?catId=${arg || 50010850}`,
          headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://item.upload.taobao.com', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}) },
        });
        return { status: r.status, len: (r.html || '').length, head: (r.html || '').slice(0, 1800) };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'videoInitDiag') {
      // 视频上传 init 诊断（VideoApi1 移植联调）
      try {
        const fs = require('fs');
        const path = require('path');
        const vf = path.join(store.imgDir, '1083483848330', 'video.mp4');
        if (!fs.existsSync(vf)) return { error: '本地视频不存在: ' + vf };
        const size = fs.statSync(vf).size;
        const init = await api._mtopTao('mtop.video.upload.init.taobao', '1.0', {
          bizCode: 's_upload_tbs_vsucai', fileSize: size, mimeType: 'video/mp4',
          localFileName: 'video.mp4', netSpeed: 3000, sdkVersion: '0.6.0-beta.12',
        });
        const model = (init && init.model) || init || {};
        return {
          ret: 'ok', fileSize: size,
          uploadId: model.uploadId ? String(model.uploadId).slice(0, 20) : '',
          urlCount: (model.uploadUrlList || []).length,
          firstUrl: model.uploadUrlList && model.uploadUrlList[0] ? String(model.uploadUrlList[0].url || '').slice(0, 120) : '',
          partNumber: model.uploadUrlList && model.uploadUrlList[0] ? model.uploadUrlList[0].partNumber : '',
        };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'videoPutDiag') {
      // 视频分片 PUT 诊断：分别测无 session / 带 session 两种方式
      try {
        const fs = require('fs');
        const path = require('path');
        const { net } = require('electron');
        const vf = path.join(store.imgDir, '1083483848330', 'video.mp4');
        if (!fs.existsSync(vf)) return { error: '本地视频不存在' };
        const size = fs.statSync(vf).size;
        const init = await api._mtopTao('mtop.video.upload.init.taobao', '1.0', {
          bizCode: 's_upload_tbs_vsucai', fileSize: size, mimeType: 'video/mp4',
          localFileName: 'video.mp4', netSpeed: 3000, sdkVersion: '0.6.0-beta.12',
        });
        const model = (init && init.model) || init || {};
        const u = (model.uploadUrlList || [])[0];
        if (!u || !u.url) return { error: '无分片地址' };
        const chunk = fs.readFileSync(vf).slice(0, 1024); // 1KB 试传
        const putOnce = (useSession) => new Promise((resolve) => {
          const opts = { url: u.url, method: 'PUT' };
          if (useSession) { opts.session = win.webContents.session; opts.useSessionCookies = true; }
          const req = net.request(opts);
          req.setHeader('User-Agent', 'Mozilla/5.0');
          req.setHeader('Referer', 'https://myseller.taobao.com/');
          req.setHeader('Origin', 'https://myseller.taobao.com');
          const to = setTimeout(() => { req.abort(); resolve({ useSession, err: 'timeout' }); }, 20000);
          req.on('response', (res) => {
            const etag = res.headers['etag'] || '';
            res.on('data', () => {});
            res.on('end', () => { clearTimeout(to); resolve({ useSession, status: res.statusCode, etag: String(etag).slice(0, 30) }); });
          });
          req.on('error', (e) => { clearTimeout(to); resolve({ useSession, err: String(e.message) }); });
          req.write(chunk);
          req.end();
        });
        const r1 = await putOnce(false);
        const r2 = await putOnce(true);
        return { urlHead: String(u.url).slice(0, 100), noSession: r1, withSession: r2 };
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'videoChainDiag') {
      // 完整视频链诊断：init→PUT→complete→submit→query 打印每步原始响应
      try {
        const fs = require('fs');
        const path = require('path');
        const vf = path.join(store.imgDir, '1083483848330', 'video.mp4');
        if (!fs.existsSync(vf)) return { error: '本地视频不存在' };
        const buf = fs.readFileSync(vf);
        const out = {};
        const init = await api._mtopTao('mtop.video.upload.init.taobao', '1.0', {
          bizCode: 's_upload_tbs_vsucai', fileSize: buf.length, mimeType: 'video/mp4',
          localFileName: 'video.mp4', netSpeed: 3000, sdkVersion: '0.6.0-beta.12',
        });
        const model = (init && init.model) || init || {};
        out.init = { uploadId: !!model.uploadId, urls: (model.uploadUrlList || []).length };
        const CHUNK = 2097152;
        const parts = [];
        for (let i = 0; i < (model.uploadUrlList || []).length; i++) {
          const chunk = buf.slice(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
          const etag = await api._putBinary(model.uploadUrlList[i].url, chunk);
          parts.push(JSON.stringify({ partNumber: model.uploadUrlList[i].partNumber, md5: etag }));
        }
        out.put = { parts: parts.length, firstEtag: parts[0] ? parts[0].slice(0, 60) : '' };
        const comp = await api._mtopTao('mtop.video.upload.complete.taobao', '1.0', {
          bizCode: 's_upload_tbs_vsucai', uploadId: model.uploadId, partList: JSON.stringify(parts), netSpeed: 3000, sdkVersion: '0.6.0-beta.12',
        }, { method: 'POST' });
        const cModel = (comp && comp.model) || comp || {};
        out.complete = { fileId: String(cModel.fileId || '').slice(0, 24) };
        const sub = await api._mtopTao('mtop.taobao.cp.aiprocess.api.job.submit', '1.0', JSON.stringify({
          bizLine: 'tbs_vsucai', fileId: cModel.fileId, mediaType: 'VIDEO',
          functions: '[{"code":"intelligent_cover_rec","extraInput":{"selectNum":1,"algoMode":"light"}}]',
          sdkVersion: '1.7.0',
        }), { method: 'POST' });
        out.submit = { head: JSON.stringify(sub).slice(0, 250) };
        const jobId = (sub || {}).jobId;
        out.jobId = String(jobId || '').slice(0, 24);
        let q = null;
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 3000));
          q = await api._mtopTao('mtop.taobao.cp.aiprocess.api.job.query', '1.0', { jobId, fileId: cModel.fileId, bizLine: 'tbs_vsucai' });
          out['query' + i] = { head: JSON.stringify(q).slice(0, 300) };
          if (q && (q.success === true || String(q.success) === 'true')) break;
        }
        return out;
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'dumpSaleProp') {
      // 发布页销售属性结构（SKU功能：颜色/尺码 pid + dataSource + isCustom）
      try {
        await win.loadURL('https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + (arg || '50010850') + '&force=true&keyProps=%7B%7D&fromSmart=true&newRouter=1');
        for (let i = 0; i < 15; i++) {
          const ready = await win.webContents.executeJavaScript('!!window.Json', false).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        return await win.webContents.executeJavaScript(`(function(){
          try {
            const m = (window.Json || {}).models || {};
            const out = { modelKeys: Object.keys(m).slice(0, 40) };
            const fields = m.__fields__ || {};
            out.fieldKeys = Object.keys(fields).slice(0, 40);
            // components.saleProp.props.subItems 销售属性定义（颜色/尺码）
            try {
              const sub = (((window.Json || {}).components || {}).saleProp || {}).props || {};
              out.salePropPropsKeys = Object.keys(sub).slice(0, 25);
              out.subItemsKeys = Object.keys(sub.subItems || {}).slice(0, 10);
              out.subItems = Object.keys(sub.subItems || {}).slice(0, 5).map(k => {
                const f = sub.subItems[k] || {};
                return {
                  key: k,
                  defKeys: Object.keys(f).slice(0, 25),
                  name: f.name, label: f.label, uiType: f.uiType, required: f.required,
                  isCustom: f.isCustom, maxCustomItems: f.maxCustomItems, showRemark: f.showRemark, hasAlias: f.hasAlias,
                  dsCount: (f.dataSource || []).length,
                  dsSample: (f.dataSource || []).slice(0, 5).map(d => ({ text: (d.text || '').slice(0, 15), value: d.value })),
                };
              });
              // sku 组件的 subItems（sku 结构字段）
              try {
                const skuProps = (((window.Json || {}).components || {}).sku || {}).props || {};
                out.skuPropsKeys = Object.keys(skuProps).slice(0, 20);
              } catch (e) {}
            } catch (e) { out.subItemsErr = String(e).slice(0, 100); }
            // formValues 里的销售属性默认值
            const fv = m.formValues || {};
            out.fvSaleProp = JSON.stringify(fv.saleProp).slice(0, 300);
            out.fvKeys = Object.keys(fv).slice(0, 40);
            return out;
          } catch (e) { return { fatal: String(e).slice(0, 200) }; }
        })()`, false);
      } catch (e) { return { error: e.message }; }
    }
    if (cmd === 'dumpJson') {
      // 加载发布页 dump window.Json 顶层结构（找属性定义真实路径）
      try {
        await win.loadURL('https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + (arg || '50010850'));
        for (let i = 0; i < 15; i++) {
          const ready = await win.webContents.executeJavaScript('!!window.Json', false).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        const dump = await win.webContents.executeJavaScript(`(function(){
          const j = window.Json || {};
          const out = { topKeys: Object.keys(j).slice(0, 40) };
          // 找 models 里的表单模型（catProp 属性定义应该在里面）
          try {
            const m = j.models || {};
            out.modelKeys = Object.keys(m).slice(0, 30);
            if (m.catProp) {
              out.catPropType = Array.isArray(m.catProp) ? 'array[' + m.catProp.length + ']' : typeof m.catProp;
              if (Array.isArray(m.catProp) && m.catProp.length) {
                out.catProp0 = { keys: Object.keys(m.catProp[0] || {}).slice(0, 15) };
                const c0 = m.catProp[0];
                if (c0 && c0.label) out.catProp0.label = c0.label;
                if (c0 && c0.uiType) out.catProp0.uiType = c0.uiType;
                if (c0 && c0.name) out.catProp0.name = c0.name;
                if (c0 && c0.dataSource) out.catProp0.dsLen = c0.dataSource.length;
              } else if (typeof m.catProp === 'object') {
                const cpKeys = Object.keys(m.catProp);
                out.catPropKeys = cpKeys.slice(0, 15);
                // 尝试常见子结构
                for (const sk of ['props', 'dataSource', 'fields', '__fields__']) {
                  if (m.catProp[sk]) {
                    const sv = m.catProp[sk];
                    out['catProp.' + sk] = Array.isArray(sv) ? 'array[' + sv.length + ']' : typeof sv;
                    if (Array.isArray(sv) && sv.length) {
                      const s0 = sv[0] || {};
                      out['catProp.' + sk + '0'] = { keys: Object.keys(s0).slice(0, 12), label: s0.label, uiType: s0.uiType, name: s0.name, required: s0.required, dsLen: (s0.dataSource || []).length };
                    }
                  }
                }
              }
            }
          } catch(e) { out.modelsErr = e.message; }
          return out;
        })()`, false);
        return dump;
      } catch (e) { return { error: e.message }; }
    }
    try {
      if (cmd === 'catSearch') {
        const cats = await api.categorySearch(arg || '连衣裙');
        const raw = await api._fetch('https://item.upload.taobao.com/router/asyncOpt.htm?optType=categorySearch&fromSmart=true&keyword=' + encodeURIComponent(arg || '连衣裙'), {
          method: 'POST', referer: 'https://item.upload.taobao.com/sell/v2/publish.htm', origin: 'https://item.upload.taobao.com',
        });
        return { cats: cats.slice(0, 5), rawStatus: raw.status, rawHead: raw.html.slice(0, 300) };
      }
      if (cmd === 'warmup') {
        const t0 = Date.now();
        const r = await api._fetch('https://item.upload.taobao.com/sell/v2/publish.htm?catId=50010850', { referer: 'https://upload.taobao.com/', timeoutMs: 25000 });
        return {
          ms: Date.now() - t0, status: r.status, len: r.html.length,
          hasJson: r.html.includes('window.Json'),
          isLogin: r.html.includes('login.taobao.com'),
          title: (r.html.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
        };
      }
      if (cmd === 'uploadImg') {
        const r = await api.uploadImage(arg || 'C:\\Users\\Administrator\\AppData\\Roaming\\千牛铺货助手\\data\\images\\1048945592852\\main\\1.jpg');
        return r;
      }
      if (cmd === 'findLocDom') {
        // 在发布页 DOM 里找发货地/所在地组件（新版必填项）
        const { TaoApi } = require('./core/taobao-api');
        const shop = store.accounts.find(a => a.type === 'shop');
        if (!shop) return { error: 'no shop' };
        const win = await accounts.getWorkWindow(shop, { show: false });
        await win.loadURL('https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + (arg || '50010850') + '&force=true&keyProps=%7B%7D&fromSmart=true&newRouter=1');
        for (let i = 0; i < 20; i++) {
          const ready = await win.webContents.executeJavaScript('!!window.Json', false).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        return await win.webContents.executeJavaScript(`(function(){
          try {
            const out = {};
            // __fields__.shippingArea 完整定义（提交格式）
            try {
              const f = window.Json.models.__fields__.shippingArea;
              out.fieldDef = JSON.stringify(f).slice(0, 1500);
            } catch (e) { out.fieldDefErr = String(e).slice(0, 100); }
            // formValues 里有无 shippingArea
            try {
              const fv = window.Json.models.formValues || {};
              out.fvShippingArea = JSON.stringify(fv.shippingArea).slice(0, 500);
            } catch (e) {}
            // 组件 props 里再看 value 之外的（type/uiType/格式提示）
            const labels = [...document.querySelectorAll('label,span,div')].filter(el => {
              const t = (el.textContent || '').trim();
              return t === '发货地' || t === '发货地*';
            });
            if (labels[0]) {
              let node = labels[0];
              for (let i = 0; i < 10 && node; i++) {
                const fk = Object.keys(node).find(k => k.indexOf('__reactFiber$') === 0);
                if (fk) {
                  let fiber = node[fk];
                  for (let j = 0; j < 15 && fiber; j++) {
                    const p = fiber.memoizedProps || {};
                    if (p.name === 'shippingArea') {
                      out.propKeys = Object.keys(p);
                      out.uiType = p.uiType || '';
                      out.required = p.required;
                      out.defaultValue = JSON.stringify(p.defaultValue).slice(0, 400);
                      break;
                    }
                    fiber = fiber.return;
                  }
                  break;
                }
                node = node.parentElement;
              }
            }
            return out;
          } catch (e) { return { fatal: String(e).slice(0, 200) }; }
        })()`, false);
      }
      if (cmd === 'dumpLocation') {
        // 搜 window.Json 里所有含 location 的字段（发货地必填的解法）
        const data = await api.getPublishPageData(arg || '50010850');
        const raw = data.raw || {};
        const out = {};
        const m = raw.models || {};
        if (m.formValues) {
          out.formValueKeys = Object.keys(m.formValues);
          const fv = m.formValues;
          for (const [k, v] of Object.entries(fv)) {
            if (/loc|address|城市|省份|province/i.test(k)) out['fv:' + k] = JSON.stringify(v).slice(0, 500);
          }
        }
        if (m.__fields__) {
          const ff = m.__fields__;
          out.fieldKeys = Object.keys(ff).slice(0, 60);
          for (const k of Object.keys(ff)) {
            if (/loc/i.test(k)) out['field:' + k] = JSON.stringify(ff[k]).slice(0, 800);
          }
        }
        // 深搜 location 键（一层 components + models）
        const found = [];
        const scan = (obj, path, depth) => {
          if (!obj || typeof obj !== 'object' || depth > 2) return;
          for (const [k, v] of Object.entries(obj)) {
            if (/^location$/i.test(k)) found.push(path + '.' + k);
          }
        };
        scan(raw, 'root', 1);
        if (raw.components) scan(raw.components, 'components', 1);
        if (raw.models) scan(raw.models, 'models', 1);
        out.locationKeys = found;
        // dump logisticsMode / deliver-card 表单值（新版发货地）
        if (m.formValues) {
          if (m.formValues.logisticsMode) out.fvLogisticsMode = JSON.stringify(m.formValues.logisticsMode).slice(0, 900);
          if (m.formValues['deliver-card']) out.fvDeliverCard = JSON.stringify(m.formValues['deliver-card']).slice(0, 900);
          if (m.formValues['base-card']) out.fvBaseCard = JSON.stringify(m.formValues['base-card']).slice(0, 900);
        }
        return out;
      }
      if (cmd === 'pubPage') {
        const r = await api._fetch('https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + (arg || '50010850') + '&force=true&keyProps=%7B%7D&fromSmart=true&newRouter=1');
        return { status: r.status, len: r.html.length, hasJson: r.html.includes('window.Json'), html: r.html.slice(0, 800) };
      }
      if (cmd === 'csrf') {
        const cookies = await win.webContents.session.cookies.get({ domain: '.taobao.com' });
        return { tbToken: (cookies.find(c => c.name === '_tb_token_') || {}).value || '', count: cookies.length };
      }
      if (cmd === 'templates') {
        const r = await api._fetch('https://item.upload.taobao.com/sell/asyncOpt.htm?optType=refreshTemplates', {
          method: 'POST', referer: 'https://item.upload.taobao.com/sell/v2/publish.htm', origin: 'https://item.upload.taobao.com',
        });
        return { status: r.status, html: r.html.slice(0, 1500) };
      }
      return { error: 'unknown cmd' };
    } catch (e) { return { error: e.message }; }
  });

  // chuangyi 素材中心 token 抓取（黑鲸鱼同款机制：拦截浏览器请求头）
  // 返回 { token, cookie }，成功后 TaoApi 直接复用
  ipcMain.handle('debug:chuangyiDiag', async () => {
    const shop = store.accounts.find(a => a.type === 'shop');
    if (!shop) return { error: 'no shop' };
    const win = await accounts.getWorkWindow(shop, { show: false });
    const sess = win.webContents.session;
    return await new Promise((resolve) => {
      let token = '', cookie = '', done = false;
      const finish = (extra = {}) => {
        if (done) return; done = true;
        try { sess.webRequest.onBeforeSendHeaders(null); } catch (_) {}
        resolve({ token, cookie: cookie.slice(0, 300), len: cookie.length, ...extra });
      };
      // 拦截 chuangyi 域请求头
      sess.webRequest.onBeforeSendHeaders(
        { urls: ['*://*.chuangyi.taobao.com/*'] },
        (details, cb) => {
          const h = details.requestHeaders || {};
          if (h['X-Csrf-Token'] || h['X-CSRF-Token'] || h['x-csrf-token']) {
            token = h['X-Csrf-Token'] || h['X-CSRF-Token'] || h['x-csrf-token'];
          }
          if (h['Cookie'] || h['cookie']) cookie = h['Cookie'] || h['cookie'];
          cb({ requestHeaders: h });
        }
      );
      // 加载素材中心页
      win.loadURL('https://chuangyi.taobao.com/external/console').catch(() => {});
      // 12秒兜底
      setTimeout(() => finish({ timeout: true }), 12000);
      // 页面加载完成后轮询检查是否已抓到
      const t = setInterval(() => {
        if (token && cookie) { clearInterval(t); setTimeout(() => finish({ ok: true }), 2000); }
      }, 500);
    });
  });
  ipcMain.handle('debug:openPage', (e, type) => accounts.openShopWorkbench(mainWindow));

  // 分销关联单测（补关联已发布商品：publisher._relation1688 完整链路）
  // 参数 { offerId, itemId }：goods 库里取采集数据（supplierUserId），用淘宝发布 ID 补调 linkConsignSellItem
  ipcMain.handle('debug:relation', async (e, { offerId, itemId, skipSkuMap } = {}) => {
    try {
      const goods = store.goodsByOffer(offerId);
      if (!goods) return { error: 'goods not found: ' + offerId };
      const shop = store.accounts.find(a => a.type === 'shop');
      const win = await accounts.getWorkWindow(shop, { show: false });
      const logs = [];
      const r = await publisher._relation1688(
        skipSkuMap === false ? goods : { ...goods, raw: { ...goods.raw } },
        itemId,
        win,
        (m) => { logs.push(m); }
      );
      return { ok: r, logs };
    } catch (e2) { return { error: e2.message }; }
  });

  // ---------- 其他 ----------
  ipcMain.handle('app:openUserData', () => { shell.openPath(path.join(app.getPath('userData'), 'data')); return true; });
  ipcMain.handle('app:exportGoods', async (e) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出商品库',
      defaultPath: 'goods-export.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return store.exportGoodsCsv(r.filePath);
  });
}

app.whenReady().then(() => {
  initModules();
  createMainWindow();
  // UA 固定为常见 Chrome，降低自动化特征
  session.defaultSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'zh-CN,zh;q=0.9'
  );
});

app.on('window-all-closed', () => {
  // macOS 除外（Dock 激活时重建窗口）；Windows 下所有窗口关闭即退出
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 统一兜底：从任何路径退出（菜单/任务栏/Alt+F4）都完成清理
  if (isQuitting) return;
  isQuitting = true;
  try { queue && queue.shutdown(); } catch (_) {}
  try { accounts && accounts.destroyAllWindows(); } catch (_) {}
  try { collector && collector.destroyWindows(); } catch (_) {}
  try { store && store.flushSave(); } catch (_) {}
});

app.on('will-quit', () => {
  // 强兜底：远程调试端口CDP连接、net socket 等句柄可能让事件循环不空，
  // 500ms 后强制退出（数据已在 before-quit/close 阶段同步落盘）
  setTimeout(() => {
    try { app.exit(0); } catch (_) { process.exit(0); }
  }, 500).unref();
});
