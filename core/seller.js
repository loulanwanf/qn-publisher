/**
 * 千牛店铺后台信息同步
 * - 在商家账号登录态下，从千牛工作台进入发布页，自动抓取：
 *   ① 运费模板列表  ② 退货地址列表
 * - 抓取结果存 store.sellerInfo，上传配置页用下拉框选择（不再手动填写名字）
 */
const DOM = require('./dom');
const Publisher = require('./publisher');

const WORKBENCH_URL = 'https://myseller.taobao.com';   // 千牛卖家工作台
const PUBLISH_ENTRY_URL = 'https://upload.taobao.com/auction/sell.jhtml';  // 千牛2026新版发布入口
const LOGIN_HINT_RE = /login\.taobao\.com/;

class Seller {
  constructor({ accounts, store, logger }) {
    this.accounts = accounts;
    this.store = store;
    this.logger = logger;
  }

  /**
   * 同步店铺后台信息（运费模板/退货地址）
   * 千牛2026新版流程：入口 → 搜索发品 → 选类目 → 表单页抓取
   */
  async syncInfo(opts = {}) {
    const shop = this.store.accounts.find(a => a.type === 'shop');
    if (!shop) return { ok: false, message: '请先在「店铺管理」添加商家账号并扫码登录' };

    const win = await this.accounts.getWorkWindow(shop, { show: false });
    const log = (m) => this.logger.info('seller', m);
    const prog = (detail, percent) => {
      log(detail);
      if (this.onProgress) this.onProgress({ key: 'seller-sync', title: '同步店铺后台信息', detail, percent });
    };

    try {
      // 1. 千牛工作台确认登录态
      prog('打开千牛工作台确认店铺登录态…', 10);
      await win.loadURL(WORKBENCH_URL);
      await DOM.waitLoadStop(win.webContents, 30000);
      await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
      if (LOGIN_HINT_RE.test(win.webContents.getURL())) {
        return { ok: false, message: '商家账号登录态失效，请到「店铺管理」重新扫码登录' };
      }

      // 2. 新版发布入口 → 选类目进表单
      prog('进入新版发布页…', 30);
      await win.loadURL(PUBLISH_ENTRY_URL);
      await DOM.waitLoadStop(win.webContents, 30000);
      await win.webContents.executeJavaScript(DOM.STEALTH_JS, false).catch(() => {});
      if (LOGIN_HINT_RE.test(win.webContents.getURL())) {
        return { ok: false, message: '商家账号登录态失效，请到「店铺管理」重新扫码登录' };
      }

      // 3. 借用 publisher 的新版类目流程进表单页
      const cat = (opts.category || this.store.settings.template.category || '连衣裙').trim();
      prog('选择类目进入表单…', 50);
      const publisher = new Publisher({ accounts: this.accounts, store: this.store, logger: this.logger, media: { localPaths: () => ({ main: [], detail: [] }) } });
      const catResult = await publisher._stepCategory(win, cat, (m) => log(m));
      if (!catResult.ok) {
        return { ok: false, message: '进入表单页失败: ' + catResult.note };
      }

      // 4. 抓取运费模板（新版是自定义下拉：点击展开面板抓选项）— 20s 超时防 hang
      prog('抓取运费模板/退货地址列表…', 80);
      const picked = await Promise.race([
        DOM.evalInPage(win.webContents, `
        const out = { ship: [], address: [] };
        // 新版发布页：运费模板区块（child-block 含"运费模板"文本）
        const blocks = [...document.querySelectorAll('[class*="child-block"], [class*="logis-block"]')].filter(b => (b.innerText || '').includes('运费模板'));
        if (blocks.length) {
          const input = blocks[0].querySelector('input');
          if (input) {
            input.scrollIntoView({ block: 'center' });
            await new Promise(r => setTimeout(r, 600));
            // 点击前快照：当前所有可见 menu/option 元素集合（排除常驻导航）
            const before = new Set([...document.querySelectorAll('[class*="menu-item"], [class*="option"]')].filter(el => el.offsetParent !== null));
            input.click();
            await new Promise(r => setTimeout(r, 2000));
            // 点击后：只取新出现的选项（弹出的下拉面板）
            const after = [...document.querySelectorAll('[class*="menu-item"], [class*="option"], [class*="popup" i] li, [class*="overlay" i] li')]
              .filter(el => el.offsetParent !== null && !before.has(el))
              .map(el => (el.innerText || '').trim().split('\\n')[0])
              .filter(t => t && t.length >= 2 && t.length <= 40 && !/请选择|请输入|搜索|新建|刷新/.test(t));
            out.ship = [...new Set(after)];
            document.body.click();
            await new Promise(r => setTimeout(r, 400));
          }
        }
        // 退货地址：新版在售后区，找"退货地址"文本附近的下拉（若类目不支持7天退货则可能没有）
        const addrBlocks = [...document.querySelectorAll('[class*="block"], div')].filter(b => {
          const t = (b.innerText || '');
          return t.includes('退货地址') && t.length < 200;
        });
        if (addrBlocks.length) {
          const input = addrBlocks[0].querySelector('input');
          if (input) {
            input.scrollIntoView({ block: 'center' });
            await new Promise(r => setTimeout(r, 500));
            const before = new Set([...document.querySelectorAll('[class*="menu-item"], [class*="option"]')].filter(el => el.offsetParent !== null));
            input.click();
            await new Promise(r => setTimeout(r, 1500));
            const after = [...document.querySelectorAll('[class*="menu-item"], [class*="option"]')]
              .filter(el => el.offsetParent !== null && !before.has(el))
              .map(el => (el.innerText || '').trim().split('\\n')[0])
              .filter(t => t && t.length >= 4 && t.length <= 60 && /省|市|区|县|镇|路|街|号/.test(t));
            out.address = [...new Set(after)];
            document.body.click();
          }
        }
        return out;
      `),
        new Promise((_, rej) => setTimeout(() => rej(new Error('DOM抓取超时')), 20000)),
      ]).catch((e) => { log('DOM抓取失败: ' + (e.message || '')); return null; });

      const shipDom = (picked && picked.ship) || [];
      const address = (picked && picked.address) || [];
      if (!shipDom.length && !address.length) {
        log('未抓取到运费模板/退货地址（发布页可能未进入表单页）');
        return { ok: false, message: '未能自动识别运费模板/退货地址，请先在千牛后台建立运费模板，或点「试发布」调试一次后重试' };
      }

      // 4.5 运费模板带 ID：通过 DOM 切换下拉选项 + 读"编辑"链接 templateId（绕过被风控的 asyncOpt API）
      let ship = shipDom.map(name => ({ name, id: '' }));
      try {
        const tplResult = await DOM.evalInPage(win.webContents, `
          const out = [];
          // 找运费模板区块（含编辑链接的）
          const blocks = [...document.querySelectorAll('[class*="child-block"], [class*="logis-block"]')].filter(b => (b.innerText || '').includes('运费模板'));
          const shipBlock = blocks.find(b => b.querySelector('a[href*="templateId"]')) || blocks[0];
          if (!shipBlock) return JSON.stringify([]);

          // 读编辑链接中的 templateId
          const getTplId = () => {
            const a = shipBlock.querySelector('a[href*="templateId"]');
            if (!a) return '';
            const m = (a.href || '').match(/templateId=([0-9]+)/) || (a.getAttribute('href') || '').match(/templateId=([0-9]+)/);
            return m ? m[1] : '';
          };

          // 当前选中模板名 + ID
          const currentEm = shipBlock.querySelector('em');
          const currentName = currentEm ? currentEm.textContent.trim() : '';
          const currentId = getTplId();
          if (currentName && currentId) out.push({ name: currentName, id: currentId });

          // 展开下拉，切换每个选项读 ID
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
            // 恢复原始选中
            const orig = opts.find((o, i) => optNames[i] === currentName);
            if (orig) { orig.click(); await new Promise(r => setTimeout(r, 500)); }
            document.body.click();
          }
          return JSON.stringify(out);
        `).catch(() => '[]');
        const tpls = JSON.parse(tplResult || '[]');
        if (tpls.length) {
          ship = ship.map(s => {
            const hit = tpls.find(t => t.name === s.name || t.name.includes(s.name) || s.name.includes(t.name));
            return hit ? { name: s.name, id: hit.id } : s;
          });
          if (!ship.some(s => s.id)) ship = tpls;
          log('运费模板 ' + ship.length + ' 个（含ID，DOM提取）');
        } else {
          log('运费模板 ' + ship.length + ' 个（DOM未提取到ID，上传时自动获取）');
        }
      } catch (e) { log('运费模板ID提取失败: ' + e.message + '（上传时自动获取）'); }

      // 5. 保存
      this.store.sellerInfo = {
        ...this.store.sellerInfo,
        shipTemplates: ship,
        returnAddresses: address,
        shopName: shop.name,
        fetchedAt: Date.now(),
      };
      this.store._debounceSave();
      this.logger.success('seller', `同步成功：运费模板 ${ship.length} 个 / 退货地址 ${address.length} 个`);
      return { ok: true, ship: ship.length, address: address.length, message: `同步成功：运费模板 ${ship.length} 个，退货地址 ${address.length} 个` };
    } catch (e) {
      this.logger.error('seller', '同步失败: ' + e.message);
      return { ok: false, message: '同步失败: ' + e.message };
    }
  }
}

module.exports = Seller;