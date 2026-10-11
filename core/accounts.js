/**
 * 账号管理
 * - shop:      千牛/淘宝商家账号（发布商品用）—— 扫码登录
 * - collect:   1688 采集账号（N个，轮换使用）—— 扫码 / 账密登录
 * 每个账号独立 session partition，登录态持久保存，互不串扰
 */
const { BrowserWindow, session } = require('electron');
const path = require('path');
const DOM = require('./dom');

const LOGIN_URL = {
  shop: 'https://login.taobao.com/member/login.jhtml',
  collect: 'https://login.1688.com/member/signin.htm',
};

/** 登录态判定 cookie（阿里系通用：lgc/tracknick/dnk/cookie17 等） */
const LOGIN_COOKIES = ['lgc', 'tracknick', 'dnk', 'cookie17', 'login_id', '_nk_'];

class Accounts {
  constructor(store, logger) {
    this.store = store;
    this.logger = logger;
    this.loginWindows = new Map(); // id -> BrowserWindow
  }

  list() {
    return this.store.accounts.map(a => ({
      ...a,
      isLoggingIn: this.loginWindows.has(a.id),
    }));
  }

  add(type, name) {
    const acc = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,                    // shop | collect
      name: name || (type === 'shop' ? '我的店铺' : '采集账号'),
      partition: `persist:qnp-${type}-${Date.now()}`,
      username: '',            // 账密（collect 可选）
      password: '',            // 账密（collect 可选）
      lastLoginAt: null,
      status: 'new',          // new | ok | expired
    };
    this.store.accounts.push(acc);
    this.store.saveAccounts();
    return acc;
  }

  remove(id) {
    const acc = this.store.accounts.find(a => a.id === id);
    this.store.accounts = this.store.accounts.filter(a => a.id !== id);
    this.store.saveAccounts();
    if (acc) this.clearSession(acc);
    return true;
  }

  byId(id) { return this.store.accounts.find(a => a.id === id); }

  /** 清除某账号的浏览器会话数据（cookie/cache/localStorage 等），用于登录态过期后"删除旧登录态"。
   *  账号条目保留（用户无需重新添加），仅清掉过期 token，下次扫码即为全新会话。 */
  clearSession(acc) {
    if (!acc) return;
    // 先关闭可能存在的工作窗口，避免占用 partition
    this.closeWorkWindow(acc.id);
    try {
      const sess = session.fromPartition(acc.partition);
      sess.clearStorageData().catch(() => {});
      sess.clearCache().catch(() => {});
      sess.clearHostResolverCache().catch(() => {});
      sess.clearAuthCache().catch(() => {});
    } catch (_) {}
  }

  /** 获取一个可用的1688采集账号（粘性优先 + 轮换兜底）
   *  1688 对新窗口有滑块验证，同一账号窗口过验证后保持可信——
   *  所以优先复用上次成功采集的账号，只有失败/无记录才轮换下一个
   */
  getWorking1688() {
    const ok = this.store.accounts.filter(a => a.type === 'collect' && a.status === 'ok');
    // 粘性：上次成功的账号优先
    if (this._stickyAcc) {
      const acc = ok.find(a => a.id === this._stickyAcc);
      if (acc) return acc;
    }
    const list = ok.length ? ok : this.store.accounts.filter(a => a.type === 'collect');
    if (!list.length) return null;
    if (!this._rrIndex) this._rrIndex = 0;
    const acc = list[this._rrIndex % list.length];
    this._rrIndex++;
    return acc;
  }

  /** 标记某账号为"粘性账号"（采集成功后调用，下次优先用它） */
  markSticky(accId) { this._stickyAcc = accId; }

  /** 打开该账号对应的采集工作窗口（自动化用），缓存复用
   *  默认静默（show=false）：窗口后台运行，滑块自动过，仅自动失败/扫码时弹出
   */
  async getWorkWindow(acc, { show = false } = {}) {
    const key = acc.id;
    let win = this.workWindows && this.workWindows.get(key);
    if (win && !win.isDestroyed()) {
      if (show && !win.isVisible()) win.show();
      else if (!show && win.isVisible()) win.hide();   // 后台模式：复用到的可见窗口立即隐藏
      return win;
    }
    // 静默修复：新建窗口也遵守 show 参数与 windowMode 设置（此前写死 show:true 导致每次必弹窗）
    const visibleMode = (this.store.settings.advanced || {}).windowMode === 'visible';
    const sess = session.fromPartition(acc.partition, { cache: true });
    sess.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'zh-CN,zh;q=0.9'
    );
    win = new BrowserWindow({
      width: 1200, height: 860,
      show: show || visibleMode,   // quiet 模式新建即后台隐藏；需人工验证时由调用方 win.show() 弹出
      title: `${acc.name} - 采集工作窗口（请勿关闭）`,
      webPreferences: {
        session: sess,
        nodeIntegration: false,
        contextIsolation: true,
        // 不加 preload，纯网页环境
        // 隐藏窗口禁用渲染节流：后台运行时页面仍正常渲染 DOM（否则 React 懒加载不触发）
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    // 自动化窗口忽略页面 beforeunload 拦截（表单页防误关保护会卡死 loadURL）
    win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
    if (!this.workWindows) this.workWindows = new Map();
    this.workWindows.set(key, win);
    win.on('closed', () => this.workWindows && this.workWindows.delete(key));
    return win;
  }

  closeWorkWindow(id) {
    const win = this.workWindows && this.workWindows.get(id);
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** 退出应用时销毁全部后台窗口（工作窗口+登录窗口），防止隐藏窗口导致进程残留 */
  destroyAllWindows() {
    if (this.workWindows) {
      for (const win of this.workWindows.values()) {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      }
      this.workWindows.clear();
    }
    if (this.loginWindows) {
      for (const win of this.loginWindows.values()) {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      }
      this.loginWindows.clear();
    }
  }

  /**
   * 打开可见登录窗口（扫码为主，采集账号可自动填账密）
   * 返回 {ok, message}
   */
  async openLogin(id, parentWindow) {
    const acc = this.byId(id);
    if (!acc) return { ok: false, message: '账号不存在' };
    if (this.loginWindows.has(id)) {
      const w = this.loginWindows.get(id);
      if (w && !w.isDestroyed()) { w.focus(); return { ok: false, message: '登录窗口已打开' }; }
      this.loginWindows.delete(id);
    }

    const sess = session.fromPartition(acc.partition, { cache: true });
    sess.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'zh-CN,zh;q=0.9'
    );

    const win = new BrowserWindow({
      width: 1100, height: 820,
      parent: parentWindow || undefined,
      title: `登录 - ${acc.name}（扫码登录，成功后自动关闭）`,
      webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
    });
    win.setMenuBarVisibility(false);
    this.loginWindows.set(id, win);
    win.on('closed', () => this.loginWindows.delete(id));

    await win.loadURL(LOGIN_URL[acc.type]);

    // 1688采集账号：若存了账密，自动切换到密码登录并填入（滑块/短信需人工过一次）
    if (acc.type === 'collect' && acc.username && acc.password) {
      try {
        await DOM.sleep(2000);
        // 切换到密码登录 tab（阿里登录页 tab 文案两种都兼容）
        await DOM.clickByText(win.webContents,
          '.login-tab, [class*="tab"], [role="tab"], li, span, a, button',
          '密码登录', { timeoutMs: 4000 }).catch(async () => {
          await DOM.clickByText(win.webContents,
            '.login-tab, [class*="tab"], [role="tab"], li, span, a, button',
            '账号登录', { timeoutMs: 4000 });
        });
        await DOM.sleep(800);
        await DOM.fillText(win.webContents, '#fm-login-id', acc.username);
        await DOM.humanPause(300, 900);
        await DOM.fillText(win.webContents, '#fm-login-password', acc.password);
        this.logger.info('accounts', `已自动填入账密(${acc.name})，滑块/验证请人工完成`);
        win.setTitle(`${acc.name} - 账密已自动填入，请完成滑块/短信验证`);
      } catch (e) {
        this.logger.warn('accounts', '账密自动填充失败，请手动登录', e.message);
      }
    }

    // 轮询登录结果，最长10分钟
    const ok = await this._pollLoginOk(win, acc, 10 * 60 * 1000);
    if (ok) {
      acc.lastLoginAt = Date.now();
      acc.status = 'ok';
      // 提取登录账号名（旺旺号/店铺名）：1688 cookie 的 tracknick/lid（URL编码）→ 解码
      const name = await this._extractNick(sess, acc);
      if (name) acc.name = name;
      this.store.saveAccounts();
      this.logger.success('accounts', `${acc.name} 登录成功`);
      // 登录窗口保留复用（不导航、不关闭——1688对每次导航独立验证，
      // 登录窗口停留在登录完成页即是最佳会话状态）
      win.setTitle(`${acc.name} - 登录成功，窗口转为采集工作窗口`);
      if (!this.workWindows) this.workWindows = new Map();
      const old = this.workWindows.get(acc.id);
      if (old && !old.isDestroyed() && old !== win) old.destroy();
      this.workWindows.set(acc.id, win);
      win.hide();
      return { ok: true, message: '登录成功' };
    }
    if (!win.isDestroyed()) {
      win.setTitle(`${acc.name} - 未检测到登录（窗口保留，可继续操作）`);
    }
    return { ok: false, message: '未检测到登录成功（窗口已保留，登录后可重新点“检测登录态”）' };
  }

  /** 轮询登录成功判定 */
  async _pollLoginOk(win, acc, timeoutMs) {
    const start = Date.now();
    const sess = session.fromPartition(acc.partition);
    while (Date.now() - start < timeoutMs) {
      if (win.isDestroyed()) return false;
      try {
        const url = win.webContents.getURL();
        // 已跳离登录页
        const leftLogin = !/login\.(taobao|1688)\.com/.test(url);
        if (leftLogin) {
          const hasCookie = await this._hasLoginCookie(sess);
          if (hasCookie) return true;
        }
        const hasCookie = await this._hasLoginCookie(sess);
        if (hasCookie && Date.now() - start > 5000) return true;
      } catch (_) {}
      await DOM.sleep(1500);
    }
    return false;
  }

  async _hasLoginCookie(sess) {
    try {
      const cookies = await sess.cookies.get({});
      const names = new Set(cookies.map(c => c.name));
      return LOGIN_COOKIES.some(n => names.has(n));
    } catch (_) { return false; }
  }

  /** 提取登录账号名（旺旺号/店铺名）：cookie tracknick/lid/__cn_logon_id__（URL编码）解码 */
  async _extractNick(sess, acc) {
    try {
      const cookies = await sess.cookies.get({});
      const m = new Map(cookies.map(c => [c.name, c.value]));
      // 1688: lid / __cn_logon_id__ / tracknick；淘宝: tracknick
      let v = m.get('lid') || m.get('__cn_logon_id__') || m.get('tracknick') || m.get('tracknicknew');
      if (!v) return '';
      v = decodeURIComponent(v).replace(/^[\s'"%]+|[\s'"%]+$/g, '');
      if (!v || /^(undefined|null|none)$/i.test(v)) return '';
      return v.slice(0, 40);
    } catch (_) { return ''; }
  }

  /**
   * 检测账号登录态（不弹窗，后台静默访问一次判断页）
   */
  async checkLogin(id) {
    const acc = this.byId(id);
    if (!acc) return { ok: false, message: '账号不存在' };
    const sess = session.fromPartition(acc.partition);
    const hasCookie = await this._hasLoginCookie(sess);
    if (!hasCookie) {
      acc.status = 'expired';
      this.store.saveAccounts();
      return { ok: false, message: '登录态已失效，请重新扫码' };
    }
    // 进一步验证页面可达
    try {
      const win = await this.getWorkWindow(acc, { show: false });
      const probeUrl = acc.type === 'shop'
        ? 'https://myseller.taobao.com'
        : 'https://www.1688.com';
      await win.loadURL(probeUrl);
      await DOM.waitLoadStop(win.webContents, 20000);
      const url = win.webContents.getURL();
      const kickedToLogin = /login\.(taobao|1688)\.com/.test(url);
      if (kickedToLogin) {
        acc.status = 'expired';
        this.store.saveAccounts();
        return { ok: false, message: '登录态已失效（被跳转到登录页），请重新扫码' };
      }
      acc.status = 'ok';
      acc.lastCheckAt = Date.now();
      this.store.saveAccounts();
      return { ok: true, message: '登录态正常' };
    } catch (e) {
      return { ok: false, message: '检测失败: ' + e.message };
    }
  }

  /** 更新账密（采集账号） */
  setCredential(id, username, password) {
    const acc = this.byId(id);
    if (acc) { acc.username = username || ''; acc.password = password || ''; this.store.saveAccounts(); }
    return true;
  }

  /** 轻量巡检：只查 cookie 判断登录态是否还存在（不导航页面，避免触发风控/浪费流量）。
   *  用于定时巡检；精确判定请用 checkLogin（会真实访问判断页） */
  async quickCheck(id) {
    const acc = this.byId(id);
    if (!acc) return { ok: false, message: '账号不存在' };
    const sess = session.fromPartition(acc.partition);
    const hasCookie = await this._hasLoginCookie(sess);
    if (!hasCookie) {
      acc.status = 'expired';
      this.store.saveAccounts();
      return { ok: false, message: '登录态已失效，请重新扫码' };
    }
    return { ok: true, message: '登录态正常' };
  }

  /** 巡检全部账号（快速 cookie 判定），返回 {shop, collect} 各一个摘要 */
  async patrol() {
    const out = { shop: null, collect: [] };
    for (const a of this.store.accounts) {
      const r = await this.quickCheck(a.id);
      const item = { id: a.id, name: a.name, status: r.ok ? 'ok' : 'expired', type: a.type };
      if (a.type === 'shop') out.shop = item;
      else out.collect.push(item);
    }
    return out;
  }

  /** 启动时彻底检测：对每个账号先做 cookie 判定，cookie 还在的再真实访问判断页验证。
   *  过期账号：清除浏览器会话（删除旧 token/cookie），标记 expired，引导重新扫码。
   *  - cookie 已消失 → 100% 过期，直接清除
   *  - cookie 还在 → 真实导航判断页（shop 走卖家中心会跳登录页；collect 走 1688 受保护页）
   *  - 导航被跳到登录页 → 服务端已过期，清除
   *  - 导航网络异常 → 不动状态（避免误杀）
   *  返回 { expired: [{id,name,type}], checked, cleared }
   */
  async startupCheckAll() {
    const expired = [];
    let cleared = 0;
    // 快照账号列表（检测期间不增删）
    const list = this.store.accounts.slice();
    for (const acc of list) {
      if (!acc) continue;
      // 第一步：cookie 判定
      const sess = session.fromPartition(acc.partition);
      const hasCookie = await this._hasLoginCookie(sess);
      if (!hasCookie) {
        this.clearSession(acc);
        acc.status = 'expired';
        expired.push({ id: acc.id, name: acc.name, type: acc.type });
        cleared++;
        this.logger.warn('accounts', `启动检测：${acc.name} 登录 cookie 已消失，已清除会话，需重新扫码`);
        continue;
      }
      // 第二步：cookie 还在，真实访问判断页验证服务端是否仍有效
      try {
        const r = await this.checkLogin(acc.id);
        if (!r.ok && /失效|过期|跳转/.test(r.message || '')) {
          // 服务端判定过期 → 清除旧会话
          this.clearSession(acc);
          acc.status = 'expired';
          expired.push({ id: acc.id, name: acc.name, type: acc.type });
          cleared++;
          this.logger.warn('accounts', `启动检测：${acc.name} 登录态已失效（${r.message}），已清除会话，需重新扫码`);
        } else if (r.ok) {
          this.logger.info('accounts', `启动检测：${acc.name} 登录态正常`);
        } else {
          // 检测异常（网络等），不改动状态，避免误杀
          this.logger.warn('accounts', `启动检测：${acc.name} 检测异常（${r.message}），保持原状态`);
        }
      } catch (e) {
        this.logger.warn('accounts', `启动检测：${acc.name} 检测出错（${e.message}），保持原状态`);
      }
    }
    if (expired.length) this.store.saveAccounts();
    return { expired, checked: list.length, cleared };
  }

  /** 打开商家工作台（可见），方便手动查看后台 */
  async openShopWorkbench(parentWindow) {
    const shop = this.store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先添加商家账号' };
    const win = await this.getWorkWindow(shop, { show: true });
    await win.loadURL('https://myseller.taobao.com');
    win.setTitle('千牛卖家工作台 - 手动操作窗口（自动上架也使用此登录态）');
    return { ok: true };
  }
}

module.exports = Accounts;
