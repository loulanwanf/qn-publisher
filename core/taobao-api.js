/**
 * 淘宝发布 API 引擎 v3（黑鲸鱼 ItemCopy 机制完整移植）
 *
 * 关键机制（与黑鲸鱼一致）：
 *  - 发布页数据（window.Json 属性定义 + csrfToken）：隐藏窗口真实加载发布页提取
 *    （直接 net 请求会被风控返回错误页，浏览器环境才有完整 cookie/指纹）
 *  - chuangyi 素材上传：隐藏窗口加载 chuangyi 拦截 X-CSRF-Token，
 *    上传走 net（signature→OSS直传→callback→pushMediaCenter，黑鲸鱼 Upload8 复刻）
 *  - 类目/品牌/模板：发布页加载后的域内 XHR（net + session cookie）
 *  - 提交：POST sell/v2/submit.htm jsonBody（黑鲸鱼 PubItemRequest 复刻）
 */
const { net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 卖家中心页面加载后注入的轻量反自动化脚本（弱化 webdriver 标记，降低被风控概率）
const DOM_STEALTH = `
(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false } };
  } catch (e) {}
})();
`;

// 「1688铺货商品」页商品行提取脚本（getCommodity1688Products 使用）
// 每行结构：tr.group-content；1688货源链接 commodity-center-1688-assistant/od/{offerId}；淘宝商品链接 item.taobao.com/item.htm?id={itemId}
// 行文本：1688标题 / 价格¥xx(铺货专属价) / 库存xxx / 在售 / 淘宝标题 / 价格¥xx / 库存xxx / 在售 / 已匹配 / 合作中 / 操作…
const EXTRACT_COMMODITY_JS = `(function(){
  const rows = [...document.querySelectorAll('tr.group-content')];
  const out = [];
  for (const tr of rows) {
    const text = tr.innerText || '';
    const srcA = tr.querySelector('a[href*="commodity-center-1688-assistant/od/"]');
    const od = srcA ? ((srcA.getAttribute('href') || '').match(/od\\/(\\d+)/) || [])[1] : '';
    const tbA = tr.querySelector('a[href*="item.taobao.com/item.htm?id="]');
    const itemId = tbA ? ((tbA.href || '').match(/id=(\\d+)/) || [])[1] : '';
    const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
    const priceIdxs = [];
    lines.forEach((l, i) => { if (/^价格¥/.test(l)) priceIdxs.push(i); });
    const prices = [...text.matchAll(/¥\\s*([\\d.]+)/g)].map(m => m[1]);
    out.push({
      offerId: od,
      itemId: itemId,
      srcTitle: lines[0] || '',
      srcPrice: prices[0] || '',
      taobaoTitle: priceIdxs[1] != null ? (lines[priceIdxs[1] - 1] || '') : '',
      taobaoPrice: prices[1] || '',
      status: lines.find(l => l === '在售' || l === '下架' || l === '仓库中') || '',
    });
  }
  return JSON.stringify(out);
})()`;

// 省市区编码表（发货地 shippingArea 级联，淘宝行政区划码）
const PROVINCE_CODE = {
  '北京': '110000', '天津': '120000', '河北': '130000', '山西': '140000', '内蒙古': '150000',
  '辽宁': '210000', '吉林': '220000', '黑龙江': '230000', '上海': '310000', '江苏': '320000',
  '浙江': '330000', '安徽': '340000', '福建': '350000', '江西': '360000', '山东': '370000',
  '河南': '410000', '湖北': '420000', '湖南': '430000', '广东': '440000', '广西': '450000',
  '海南': '460000', '重庆': '500000', '四川': '510000', '贵州': '520000', '云南': '530000',
  '西藏': '540000', '陕西': '610000', '甘肃': '620000', '青海': '630000', '宁夏': '640000',
  '新疆': '650000', '台湾': '710000', '香港': '810000', '澳门': '820000',
};
const CITY_CODE = {
  // 直辖市
  '北京': '110100', '上海': '310100', '天津': '120100', '重庆': '500100',
  // 广东
  '广州': '440100', '深圳': '440300', '珠海': '440400', '汕头': '440500', '佛山': '440600',
  '韶关': '440200', '湛江': '440800', '肇庆': '441200', '江门': '440700', '茂名': '440900',
  '惠州': '441300', '梅州': '441400', '汕尾': '441500', '河源': '441600', '阳江': '441700',
  '清远': '441800', '东莞': '441900', '中山': '442000', '潮州': '445100', '揭阳': '445200',
  '云浮': '445300',
  // 浙江
  '杭州': '330100', '宁波': '330200', '温州': '330300', '嘉兴': '330400', '湖州': '330500',
  '绍兴': '330600', '金华': '330700', '衢州': '330800', '舟山': '330900', '台州': '331000',
  '丽水': '331100', '义乌': '330782',
  // 江苏
  '南京': '320100', '无锡': '320200', '徐州': '320300', '常州': '320400', '苏州': '320500',
  '南通': '320600', '连云港': '320700', '淮安': '320800', '盐城': '320900', '扬州': '321000',
  '镇江': '321100', '泰州': '321200', '宿迁': '321300',
  // 福建
  '福州': '350100', '厦门': '350200', '莆田': '350300', '三明': '350400', '泉州': '350500',
  '漳州': '350600', '南平': '350700', '龙岩': '350800', '宁德': '350900',
  // 山东
  '济南': '370100', '青岛': '370200', '淄博': '370300', '枣庄': '370400', '东营': '370500',
  '烟台': '370600', '潍坊': '370700', '济宁': '370800', '泰安': '370900', '威海': '371000',
  '日照': '371100', '莱芜': '371200', '临沂': '371300', '德州': '371400', '聊城': '371500',
  '滨州': '371600', '菏泽': '371700',
  // 河北
  '石家庄': '130100', '唐山': '130200', '秦皇岛': '130300', '邯郸': '130400', '邢台': '130500',
  '保定': '130600', '张家口': '130700', '承德': '130800', '沧州': '130900', '廊坊': '131000',
  '衡水': '131100',
  // 河南
  '郑州': '410100', '开封': '410200', '洛阳': '410300', '平顶山': '410400', '安阳': '410500',
  '鹤壁': '410600', '新乡': '410700', '焦作': '410800', '许昌': '410900', '漯河': '411000',
  '三门峡': '411200', '南阳': '411300', '商丘': '411400', '信阳': '411500', '周口': '411600',
  '驻马店': '411700',
  // 四川
  '成都': '510100', '自贡': '510300', '攀枝花': '510400', '泸州': '510500', '德阳': '510600',
  '绵阳': '510700', '广元': '510800', '遂宁': '510900', '内江': '511000', '乐山': '511100',
  '南充': '511300', '眉山': '511400', '宜宾': '511500', '广安': '511600', '达州': '511700',
  '雅安': '511800', '巴中': '511900', '资阳': '512000',
  // 湖北
  '武汉': '420100', '黄石': '420200', '十堰': '420300', '宜昌': '420500', '襄阳': '420600',
  '鄂州': '420700', '荆门': '420800', '孝感': '420900', '荆州': '421000', '黄冈': '421100',
  '咸宁': '421200', '随州': '421300', '恩施': '422800',
  // 湖南
  '长沙': '430100', '株洲': '430200', '湘潭': '430300', '衡阳': '430400', '邵阳': '430500',
  '岳阳': '430600', '常德': '430700', '张家界': '430800', '益阳': '430900', '郴州': '431000',
  '永州': '431100', '怀化': '431200', '娄底': '431300', '湘西': '433100',
  // 安徽
  '合肥': '340100', '芜湖': '340200', '蚌埠': '340300', '淮南': '340400', '马鞍山': '340500',
  '淮北': '340600', '铜陵': '340700', '安庆': '340800', '黄山': '341000', '滁州': '341100',
  '阜阳': '341200', '宿州': '341300', '六安': '341500', '亳州': '341600', '池州': '341700',
  '宣城': '341800',
  // 江西
  '南昌': '360100', '景德镇': '360200', '萍乡': '360300', '九江': '360400', '新余': '360500',
  '鹰潭': '360600', '赣州': '360700', '吉安': '360800', '宜春': '360900', '抚州': '361000',
  '上饶': '361100',
  // 广西
  '南宁': '450100', '柳州': '450200', '桂林': '450300', '梧州': '450400', '北海': '450500',
  '防城港': '450600', '钦州': '450700', '贵港': '450800', '玉林': '450900', '百色': '451000',
  '贺州': '451100', '河池': '451200', '来宾': '451300', '崇左': '451400',
  // 辽宁
  '沈阳': '210100', '大连': '210200', '鞍山': '210300', '抚顺': '210400', '本溪': '210500',
  '丹东': '210600', '锦州': '210700', '营口': '210800', '阜新': '210900', '辽阳': '211000',
  '盘锦': '211100', '铁岭': '211200', '朝阳': '211300', '葫芦岛': '211400',
  // 吉林
  '长春': '220100', '吉林': '220200', '四平': '220300', '辽源': '220400', '通化': '220500',
  '白山': '220600', '松原': '220700', '白城': '220800', '延边': '222400',
  // 黑龙江
  '哈尔滨': '230100', '齐齐哈尔': '230200', '鸡西': '230300', '鹤岗': '230400', '双鸭山': '230500',
  '大庆': '230600', '伊春': '230700', '佳木斯': '230800', '七台河': '230900', '牡丹江': '231000',
  '黑河': '231100', '绥化': '231200',
  // 海南
  '海口': '460100', '三亚': '460200', '三沙': '460300', '儋州': '460400',
  // 贵州
  '贵阳': '520100', '六盘水': '520200', '遵义': '520300', '安顺': '520400', '毕节': '520500',
  '铜仁': '520600',
  // 云南
  '昆明': '530100', '曲靖': '530300', '玉溪': '530400', '保山': '530500', '昭通': '530600',
  '丽江': '530700', '普洱': '530800', '临沧': '530900',
  // 陕西
  '西安': '610100', '铜川': '610200', '宝鸡': '610300', '咸阳': '610400', '渭南': '610500',
  '延安': '610600', '汉中': '610700', '榆林': '610800', '安康': '610900', '商洛': '611000',
  // 甘肃
  '兰州': '620100', '嘉峪关': '620200', '金昌': '620300', '白银': '620400', '天水': '620500',
  '武威': '620600', '张掖': '620700', '平凉': '620800', '酒泉': '620900', '庆阳': '621000',
  '定西': '621100', '陇南': '621200',
  // 青海
  '西宁': '630100', '海东': '630200',
  // 宁夏
  '银川': '640100', '石嘴山': '640200', '吴忠': '640300', '固原': '640400', '中卫': '640500',
  // 新疆
  '乌鲁木齐': '650100', '克拉玛依': '650200', '吐鲁番': '650400', '哈密': '650500',
  // 内蒙古
  '呼和浩特': '150100', '包头': '150200', '乌海': '150300', '赤峰': '150400', '通辽': '150500',
  '鄂尔多斯': '150600', '呼伦贝尔': '150700', '巴彦淖尔': '150800', '乌兰察布': '150900',
  // 山西
  '太原': '140100', '大同': '140200', '阳泉': '140300', '长治': '140400', '晋城': '140500',
  '朔州': '140600', '晋中': '140700', '运城': '140800', '忻州': '140900', '临汾': '141000',
  '吕梁': '141100',
  // 西藏
  '拉萨': '540100', '日喀则': '540200', '昌都': '540300', '林芝': '540400', '山南': '540500',
  '那曲': '540600',
};

class TaoApi {
  constructor(session, win) {
    this.session = session;
    this.win = win;               // 店铺工作窗口（可选，仅用于复用）
    this.cyToken = '';
    this.cyCookie = '';
    this.xsrfToken = '';
    this.groupId = 0;
    this._pageCache = new Map();  // catId → { props, raw }
  }

  // ==================== 工具窗口 ====================

  /**
   * 主图 1:1 处理（黑鲸鱼 VerSquareImage800 复刻：等比缩放 + 白底居中，不裁剪）
   * @returns 处理后文件路径（同目录 sq-*.jpg），或原路径（已正方形/处理失败时回退原图）
   */
  async toSquareImage(filePath, size = 800) {
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const buf = fs.readFileSync(filePath).toString('base64');
      const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
      const win2 = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      win = win2;
      await win2.loadURL('data:text/html,<html><body></body></html>');
      const js = `
        (async () => {
          const img = new Image();
          img.src = 'data:${mime};base64,' + ${JSON.stringify(buf)};
          await new Promise((r, j) => { img.onload = r; img.onerror = j; });
          const iw = img.naturalWidth, ih = img.naturalHeight;
          if (!iw || !ih) return { skip: true };
          const size = ${Number(size) || 800};
          if (iw === ih && iw >= 700) return { skip: true }; // 已正方形且够大
          const scale = Math.max(size / iw, size / ih);
          const nw = Math.round(iw * scale), nh = Math.round(ih * scale);
          const c = document.createElement('canvas');
          c.width = size; c.height = size;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, Math.round((size - nw) / 2), Math.round((size - nh) / 2), nw, nh);
          return { b64: c.toDataURL('image/jpeg', 0.95).split(',')[1] };
        })()`;
      const r = await win2.webContents.executeJavaScript(js);
      try { win2.destroy(); } catch (_) {} win = null;
      if (!r || r.skip || !r.b64) return filePath;
      const outPath = path.join(path.dirname(filePath), `sq-${path.basename(filePath).replace(/\.[^.]+$/, '')}-${Date.now()}.jpg`);
      fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
      return outPath;
    } catch (e) {
      try { if (win) win.destroy(); } catch (_) {}
      return filePath;
    }
  }

  /**
   * 文字水印（黑鲸鱼 ImageWater 同款思路：canvas 右下角半透明文字）
   * @returns 处理后文件路径，或原路径（无文字/失败回退）
   */
  async addWatermark(filePath, text) {
    if (!text || !String(text).trim()) return filePath;
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const buf = fs.readFileSync(filePath).toString('base64');
      const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
      const win2 = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      win = win2;
      await win2.loadURL('data:text/html,<html><body></body></html>');
      const js = `
        (async () => {
          const img = new Image();
          img.src = 'data:${mime};base64,' + ${JSON.stringify(buf)};
          await new Promise((r, j) => { img.onload = r; img.onerror = j; });
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const fs = Math.max(14, Math.round(Math.min(c.width, c.height) / 22));
          ctx.font = 'bold ' + fs + 'px "Microsoft YaHei", sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.strokeStyle = 'rgba(0,0,0,0.25)';
          ctx.lineWidth = Math.max(1, fs / 14);
          ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
          const t = ${JSON.stringify(String(text).slice(0, 20))};
          const x = c.width - fs, y = c.height - fs;
          ctx.strokeText(t, x, y);
          ctx.fillText(t, x, y);
          return { b64: c.toDataURL('image/jpeg', 0.95).split(',')[1] };
        })()`;
      const r = await win2.webContents.executeJavaScript(js);
      try { win2.destroy(); } catch (_) {} win = null;
      if (!r || !r.b64) return filePath;
      const outPath = path.join(path.dirname(filePath), `wm-${path.basename(filePath).replace(/\.[^.]+$/, '')}-${Date.now()}.jpg`);
      fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
      return outPath;
    } catch (e) {
      try { if (win) win.destroy(); } catch (_) {}
      return filePath;
    }
  }

  /**
   * 3:4 竖图处理（黑鲸鱼 ToVerticalImg 复刻：等比缩放至≥800x1200 后中心裁剪 800x1200）
   * @returns 处理后文件路径，或 null（失败）
   */
  async toVerticalImage(filePath) {
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const buf = fs.readFileSync(filePath).toString('base64');
      const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
      const win2 = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      win = win2;
      await win2.loadURL('data:text/html,<html><body></body></html>');
      const js = `
        (async () => {
          const img = new Image();
          img.src = 'data:${mime};base64,' + ${JSON.stringify(buf)};
          await new Promise((r, j) => { img.onload = r; img.onerror = j; });
          const iw = img.naturalWidth, ih = img.naturalHeight;
          if (!iw || !ih) return null;
          // 等比缩放：高至少1200，宽至少800
          let scale = Math.max(1200 / ih, 800 / iw);
          const c1 = document.createElement('canvas');
          c1.width = Math.round(iw * scale); c1.height = Math.round(ih * scale);
          c1.getContext('2d').drawImage(img, 0, 0, c1.width, c1.height);
          // 中心裁剪 800x1200
          const c = document.createElement('canvas');
          c.width = 800; c.height = 1200;
          const ctx = c.getContext('2d');
          const sx = Math.max(0, Math.round((c1.width - 800) / 2));
          const sy = Math.max(0, Math.round((c1.height - 1200) / 2));
          ctx.drawImage(c1, sx, sy, 800, 1200, 0, 0, 800, 1200);
          return { b64: c.toDataURL('image/jpeg', 0.95).split(',')[1] };
        })()`;
      const r = await win2.webContents.executeJavaScript(js);
      try { win2.destroy(); } catch (_) {} win = null;
      if (!r || !r.b64) return null;
      const outPath = path.join(path.dirname(filePath), `ver-${path.basename(filePath).replace(/\.[^.]+$/, '')}-${Date.now()}.jpg`);
      fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
      return outPath;
    } catch (e) {
      try { if (win) win.destroy(); } catch (_) {}
      return null;
    }
  }

  /** 开一个共享 session 的隐藏窗口 */
  _hiddenWindow(url, { timeoutMs = 30000, waitSec = 0 } = {}) {
    const { BrowserWindow } = require('electron');
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1000, height: 700, show: false,
        webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
      });
      let settled = false;
      const finish = (ok) => {
        if (settled) return; settled = true;
        if (waitSec > 0) setTimeout(() => { try { win.destroy(); } catch (_) {} resolve(ok); }, waitSec * 1000);
        else { try { win.destroy(); } catch (_) {} resolve(ok); }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      win.webContents.on('did-finish-load', () => {
        clearTimeout(timer);
        finish(true);
      });
      win.webContents.on('did-fail-load', () => { clearTimeout(timer); finish(false); });
      win.loadURL(url).catch(() => finish(false));
    });
  }

  // ==================== 初始化 ====================

  /**
   * 初始化素材中心 token：隐藏窗口加载 chuangyi + webRequest 拦截请求头
   */
  async init() {
    if (this.cyToken) return;
    const { BrowserWindow } = require('electron');
    const sess = this.session;
    const win = new BrowserWindow({
      width: 900, height: 640, show: false,
      webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    });
    try {
      await new Promise((resolve) => {
        let token = '', done = false;
        const finish = () => {
          if (done) return; done = true;
          try { sess.webRequest.onBeforeSendHeaders(null); } catch (_) {}
          this.cyToken = token;
          resolve();
        };
        sess.webRequest.onBeforeSendHeaders(
          { urls: ['*://*.chuangyi.taobao.com/*'] },
          (details, cb) => {
            const h = details.requestHeaders || {};
            const t = h['X-Csrf-Token'] || h['X-CSRF-Token'] || h['x-csrf-token'];
            if (t) { token = t; this.cyCookie = h['Cookie'] || h['cookie'] || this.cyCookie; }
            cb({ requestHeaders: h });
          }
        );
        win.loadURL('https://chuangyi.taobao.com/external/console').catch(() => {});
        const t0 = Date.now();
        const t = setInterval(() => {
          if (token) { clearInterval(t); setTimeout(finish, 1500); }
          else if (Date.now() - t0 > 20000) { clearInterval(t); finish(); }
        }, 500);
      });
    } finally {
      try { win.destroy(); } catch (_) {}
    }
    if (!this.cyToken) throw new Error('素材中心 Token 获取失败（店铺登录态可能过期）');
    return this;
  }

  // ==================== 基础请求 ====================

  async _fetch(url, { method = 'GET', body = null, contentType = null, referer = null, origin = null, headers = {}, timeoutMs = 30000 } = {}) {
    const h = { 'User-Agent': UA, Accept: 'text/html,application/json,*/*', ...headers };
    if (contentType) h['Content-Type'] = contentType;
    if (referer) h['Referer'] = referer;
    if (origin) h['Origin'] = origin;
    if (/asyncOpt|submit\.htm|batchFastEdit/.test(url)) {
      h['X-Requested-With'] = 'XMLHttpRequest';
      h['Accept'] = 'application/json, text/javascript, */*; q=0.01';
      if (this.xsrfToken) h['X-XSRF-TOKEN'] = this.xsrfToken;
    }
    if (/chuangyi\.taobao\.com/.test(url)) {
      if (this.cyToken) h['X-CSRF-Token'] = this.cyToken;
      h['Referer'] = h['Referer'] || 'https://chuangyi.taobao.com/external/sucai?types=image&entry=main';
      h['Origin'] = 'https://chuangyi.taobao.com';
      h['Accept'] = 'application/json, text/plain, */*';
      h['X-Requested-With'] = 'XMLHttpRequest';
      // 黑鲸鱼 Upload8 同款完整请求指纹头
      h['Sec-Fetch-Dest'] = 'empty';
      h['Sec-Fetch-Mode'] = 'cors';
      h['Sec-Fetch-Site'] = 'same-origin';
      h['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    }

    return new Promise((resolve, reject) => {
      const opts = { url, method, useSessionCookies: true, redirect: 'follow' };
      if (this.session) opts.session = this.session;
      const req = net.request(opts);
      Object.entries(h).forEach(([k, v]) => req.setHeader(k, v));
      const timer = setTimeout(() => { req.abort(); reject(new Error('请求超时')); }, timeoutMs);
      let chunks = [];
      req.on('response', (res) => {
        chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, html: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  }

  static _form(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ==================== 发布页数据（复用店铺工作窗口，黑鲸鱼同款单一浏览器思路） ====================

  /**
   * 用店铺工作窗口加载发布页（与 DOM 模式同源，havana 登录态完整）
   * → 页面内提取 window.Json + csrfToken
   */
  async _loadPublishPage(catId) {
    const win = this.win; // 店铺工作窗口
    if (!win) throw new Error('TaoApi 需要 win（店铺工作窗口）');
    const url = `https://item.upload.taobao.com/sell/v2/publish.htm?catId=${catId}&force=true&keyProps=%7B%7D&fromSmart=true&newRouter=1`;
    const prevUrl = win.webContents.getURL();
    await win.loadURL(url);
    // 等页面渲染完（window.Json 由页面脚本注入）
    for (let i = 0; i < 20; i++) {
      const ready = await win.webContents.executeJavaScript(`!!(window.Json || document.body.innerText.includes('类目已被冻结') || location.href.includes('login.taobao.com'))`, false).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const data = await win.webContents.executeJavaScript(`(function(){
      try {
        if (location.href.includes('login.taobao.com') || location.href.includes('passport.taobao.com')) return { error: '登录失效，请到店铺管理重新扫码' };
        const body = document.body.innerText || '';
        if (body.includes('类目已被冻结')) return { error: '类目已被冻结' };
        if (body.includes('需要申请准入')) return { error: '该类目需要准入申请' };
        const j = window.Json;
        if (!j) return { error: 'window.Json 不存在' };
        let token = '';
        try { token = (window.csrfToken && window.csrfToken.tokenValue) || ''; } catch(e) {}
        return { json: j, token };
      } catch (e) { return { error: e.message }; }
    })()`, false);
    if (!data || data.error) throw new Error(data ? data.error : '发布页数据提取失败');
    if (data.token) this.xsrfToken = data.token;
    return data.json;
  }

  /** 获取类目属性定义（带缓存）。真实路径: window.Json.models.catProp.dataSource */
  async getPublishPageData(catId) {
    const key = String(catId);
    if (this._pageCache.has(key)) return this._pageCache.get(key);
    const data = await this._loadPublishPage(catId);
    const props = [];
    try {
      const ds = (((data.models || {}).catProp || {}).dataSource) || (data.props && data.props.dataSource) || [];
      for (const p of ds) {
        props.push({
          label: (p.label || '').trim(),
          uiType: p.uiType || 'input',
          name: p.name || '',
          required: !!p.required,
          dataSource: (p.dataSource || []).map(d => ({ text: (d.text || '').trim(), value: d.value })),
        });
      }
    } catch (_) {}
    // 提取发布页表单默认值（黑鲸鱼靠页面JS提交自动带上；API直提需自带：logisticsMode物流模式等）
    const formDefaults = {};
    try {
      const fv = (data.models || {}).formValues || {};
      for (const k of ['logisticsMode', 'subStock', 'globalStock', 'startTime', 'regionLimitSale', 'tbExtractWay']) {
        if (fv[k] != null) formDefaults[k] = fv[k];
      }
    } catch (_) {}
    // 销售属性定义（components.saleProp.props.subItems：颜色 p-1627207 / 尺码 p-20509 的 isCustom/dataSource）
    const saleFields = [];
    const specSkuMap = {}; // pid → selectedSizeGroupId 默认对象（尺码组属性，黑鲸鱼 specSkuList）
    try {
      const sub = (((data.components || {}).saleProp || {}).props || {}).subItems || {};
      for (const k of Object.keys(sub)) {
        const f = sub[k] || {};
        saleFields.push({
          key: k,                         // 'p-1627207'
          label: (f.label || '').trim(),  // '颜色分类' / '尺码'
          uiType: f.uiType || '',
          isCustom: !!f.isCustom,
          required: !!f.required,
          maxCustomItems: f.maxCustomItems || 0,
          dataSource: (f.dataSource || []).map(d => ({ text: (d.text || '').trim(), value: d.value })),
        });
        // 尺码组属性：subItems[0].name == selectedSizeGroupId（黑鲸鱼 44172 specSkuList）
        const sub0 = (f.subItems || [])[0];
        if (sub0 && sub0.name === 'selectedSizeGroupId' && (sub0.dataSource || []).length) {
          specSkuMap[k] = sub0.dataSource[0];
        }
      }
      // formValues.saleProp 里的已选尺码组优先（页面默认选中项）
      const fvsp = ((data.models || {}).formValues || {}).saleProp || {};
      for (const k of Object.keys(fvsp)) {
        const sel = fvsp[k] && fvsp[k].selectedSizeGroupId;
        if (sel && sel.value) specSkuMap[k] = sel;
      }
    } catch (_) {}
    // SKU 参数定义（2026新版 components.sku.props.attributes 中 skuParam_* 字段：裙长/是否加绒/适用体型等，
    // 后台"SKU参数面板"必填校验用；required 的如"适用体型"不填会报错）
    const skuParams = [];
    try {
      const attrs = (((data.components || {}).sku || {}).props || {}).attributes || {};
      for (const k of Object.keys(attrs)) {
        if (!String(k).startsWith('skuParam_')) continue;
        const f = attrs[k] || {};
        skuParams.push({
          key: k,
          label: (f.label || '').trim(),
          uiType: f.uiType || '',
          required: !!f.required,
          multiple: !!f.multiple,
          dataSource: (f.dataSource || []).map(d => ({ text: (d.text || '').trim(), value: d.value })),
        });
      }
    } catch (_) {}
    const result = { props, formDefaults, saleFields, specSkuMap, skuParams, raw: data };
    this._pageCache.set(key, result);
    return result;
  }

  // ==================== 类目 / 品牌 / 模板 ====================

  /**
   * 类目搜索：工作窗口加载发布页 → 页面内 fetch XHR（黑鲸鱼 PubBrowser 同源做法）
   */
  async categorySearch(keyword) {
    const win = this.win;
    if (!win) throw new Error('TaoApi 需要 win');
    await win.loadURL('https://item.upload.taobao.com/sell/v2/publish.htm?catId=50010850');
    for (let i = 0; i < 15; i++) {
      const ready = await win.webContents.executeJavaScript(`!!(window.csrfToken || window.Json)`, false).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      try {
        const token = (window.csrfToken && window.csrfToken.tokenValue) || '';
        const r = await fetch('https://item.upload.taobao.com/router/asyncOpt.htm?optType=categorySearch&fromSmart=true&keyword=' + encodeURIComponent('${String(keyword).replace(/'/g, "\\'")}'), {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            ...(token ? { 'X-XSRF-TOKEN': token } : {}),
          },
          credentials: 'include',
        });
        const text = await r.text();
        return { status: r.status, text: text.slice(0, 20000) };
      } catch (e) { return { status: 0, text: 'ERR: ' + e.message }; }
    })()`, false);
    if (!result || !result.text.startsWith('{')) return [];
    try {
      const j = JSON.parse(result.text);
      const data = j.data || j.result || j;
      const arr = Array.isArray(data) ? data : (data.categorys || data.categories || []);
      return arr.map(c => ({
        catId: c.catId || c.id || c.categoryId,
        name: (c.name || '').trim(),
        fullName: (c.path || []).join('/'),
        publish: c.publish !== false,
      })).filter(c => c.catId && c.name);
    } catch (e) { return []; }
  }

  /**
   * 宝贝批量删除（黑鲸鱼 ItemManage batchDeleteItem 完整移植）
   * POST item.manager.taobao.com/taobao/manager/batchFastEdit.htm?optType=batchDeleteItem&action=submit
   * body: jsonBody={"auctionids":["id",...]}；需 X-XSRF-TOKEN
   * @returns {ok, message}
   */
  async deleteItems(itemIds) {
    const win = this.win;
    if (!win) throw new Error('TaoApi 需要 win');
    if (!this.xsrfToken) {
      // 先确保有 xsrfToken（进一次发布页/后台拿 token）
      try {
        await win.loadURL('https://item.upload.taobao.com/sell/v2/publish.htm?catId=50010850&fromSmart=true&newRouter=1');
        for (let i = 0; i < 15; i++) {
          const ready = await win.webContents.executeJavaScript(`!!(window.csrfToken || window.Json)`, false).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        const token = await win.webContents.executeJavaScript(`(window.csrfToken && window.csrfToken.tokenValue) || ''`, false).catch(() => '');
        if (token) this.xsrfToken = token;
      } catch (_) {}
    }
    const ids = (itemIds || []).map(String).filter(Boolean);
    if (!ids.length) return { ok: false, message: '未提供宝贝ID' };
    const jsonBody = JSON.stringify({ auctionids: ids });
    const body = 'jsonBody=' + encodeURIComponent(jsonBody);
    const r = await this._fetch('https://item.manager.taobao.com/taobao/manager/batchFastEdit.htm?optType=batchDeleteItem&action=submit', {
      method: 'POST',
      body,
      contentType: 'application/x-www-form-urlencoded',
      referer: 'https://item.manager.taobao.com/taobao/manager/render.htm?pagination.current=1&pagination.pageSize=20&tab=on_sale',
    });
    try {
      const j = JSON.parse(r.html || '{}');
      if (j.success === true || j.success === 'True') return { ok: true, message: `已删除 ${ids.length} 个宝贝` };
      return { ok: false, message: j.msg || '删除失败（返回无 success）' };
    } catch (e) {
      return { ok: false, message: '删除失败：返回解析错误（' + (r.html || '').slice(0, 60) + '）' };
    }
  }

  /* ==================== mtop 淘宝直连（黑鲸鱼 TbH5Sign 移植：cookie + md5 签名，无弹窗） ==================== */

  /** 读会话 _m_h5_tk token（mtop 签名用） */
  async _taoToken() {
    try {
      const cs = await this.session.cookies.get({ url: 'https://h5api.m.taobao.com/' });
      const tk = (cs.find(c => c.name === '_m_h5_tk') || {}).value || '';
      return tk ? tk.split('_')[0] : 'undefined';
    } catch (_) { return 'undefined'; }
  }

  /**
   * 直连淘宝 mtop 接口（黑鲸鱼 TbH5Sign.Request/Post 同款）
   * @param {string} api 如 mtop.video.upload.init.taobao
   * @param {string} v 版本
   * @param {object|string} data 请求数据（对象自动序列化；字符串原样）
   * @param {object} opts { method: 'GET'|'POST', referer }
   * @returns 接口 data 字段
   */
  async _mtopTao(api, v, data, { method = 'GET', referer = 'https://myseller.taobao.com/' } = {}) {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = Date.now().toString();
      const token = await this._taoToken();
      const sign = crypto.createHash('md5').update(`${token}&${t}&12574478&${dataStr}`, 'utf8').digest('hex');
      let url, body = null, contentType = null;
      if (method === 'POST') {
        url = `https://h5api.m.taobao.com/h5/${api}/${v}/?jsv=2.6.1&appKey=12574478&t=${t}&sign=${sign}&api=${api}&v=${v}&type=originaljson&dataType=json`;
        body = 'data=' + encodeURIComponent(dataStr);
        contentType = 'application/x-www-form-urlencoded';
      } else {
        url = `https://h5api.m.taobao.com/h5/${api}/${v}/?jsv=2.6.1&appKey=12574478&t=${t}&sign=${sign}&api=${api}&v=${v}&type=jsonp&isSec=0&timeout=10000&dataType=jsonp&callback=mtopjsonp1&data=${encodeURIComponent(dataStr)}`;
      }
      const r = await this._fetch(url, { method, body, contentType, referer });
      let txt = String(r.html || '');
      const s = txt.indexOf('{');
      const e = txt.lastIndexOf(')');
      if (s >= 0 && e > s) txt = txt.slice(s, e);
      let j = null;
      try { j = JSON.parse(txt); } catch (_) {}
      if (!j) throw new Error('mtop响应解析失败: ' + String(r.html || '').slice(0, 100));
      const ret = (j.ret && j.ret[0]) || '';
      if (/SUCCESS/i.test(ret)) return j.data;
      if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(ret)) {
        // 首次调用会种新 _m_h5_tk cookie（useSessionCookies 自动入库），重读重试
        await this._sleep(300 + attempt * 400);
        continue;
      }
      const err = new Error('mtop: ' + ret);
      err.code = ret;
      throw err;
    }
    throw new Error('mtop token 校验失败（重试3次）');
  }

  /**
   * 卖家中心商品管理动作（托管引擎执行通道）
   * fastEdit：upShelf/downShelf 已实测可用；其他 optType 由调用方指定
   * @param {string} optType 如 'upShelf' | 'downShelf'
   * @param {object} body 如 {itemId}
   */
  async manageTao(optType, body = {}) {
    const r = await this._mtopTao('mtop.taobao.sell.pc.manage.async', '1.0', {
      url: '/taobao/manager/fastEdit.htm?optType=' + optType + '&action=submit',
      jsonBody: JSON.stringify(body),
    }, { method: 'POST' });
    let result = (r || {}).result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch (_) { result = null; } }
    return result || { success: false, msg: { text: '无返回' } };
  }

  /** 店铺分类（黑鲸鱼 UploadItemApi.GetShopCat 移植：manage.render → filter → queryShopCategoryId） */
  async getShopCats() {
    const data = await this._mtopTao('mtop.taobao.sell.pc.manage.render', '1.0', { tab: 'in_stock' }, { method: 'POST' });
    const list = [];
    try {
      // 新版 mtop 的 result 是 JSON 字符串，需二次解析（黑鲸鱼时代为对象）
      let result = (data || {}).result;
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch (_) { result = null; } }
      const arr = (result && result.data) || [];
      const filter = arr.find(x => x && x.name === 'filter');
      if (!filter) return list;
      const q = (filter.subItems || []).find(x => x && x.name === 'queryShopCategoryId');
      if (!q) return list;
      for (const d of (q.dataSource || [])) {
        if (Array.isArray(d.dataSource) && d.dataSource.length) {
          for (const c of d.dataSource) {
            list.push({ value: String(c.value), text: String(d.text || '') + '->' + String(c.text || '') });
          }
          continue;
        }
        list.push({ value: String(d.value || ''), text: String(d.text || '') });
      }
    } catch (_) {}
    return list;
  }

  /** 在售商品列表（黑鲸鱼 mtop.taobao.sell.pc.manage.async 移植：用于代发分销查重）
   * 返回 [{itemId, title, code, price, upDate}]，含全部页商品（自动分页）
   */
  async getOnSaleItems() {
    const items = [];
    let current = 1;
    const pageSize = 50;
    for (let guard = 0; guard < 20; guard++) {
      let data;
      try {
        data = await this._mtopTao('mtop.taobao.sell.pc.manage.async', '1.0', {
          url: '/taobao/manager/table.htm',
          jsonBody: JSON.stringify({
            tab: 'in_stock',
            pagination: { current, pageSize },
            filtertab: '',
            filter: {},
            table: { sort: { upShelfDate_m: 'desc' } }
          })
        }, { method: 'POST' });
      } catch (e) {
        if (items.length) break;
        throw e;
      }
      let result = (data || {}).result;
      if (typeof result === 'string') result = JSON.parse(result);
      const d = (result || {}).data || {};
      const table = d.table || {};
      const ds = table.dataSource || [];
      for (const it of ds) {
        const descs = (it.itemDesc && it.itemDesc.desc) || [];
        const linkEl = descs.find(x => x && x.uiType === 'link');
        const title = String((linkEl || {}).text || '').trim();
        // 商家编码：desc 中含"编码:XXX"的元素
        let code = '';
        for (const x of descs) {
          if (x && typeof x.text === 'string' && /编码[:：]/.test(x.text)) {
            code = (x.text.split(/编码[:：]/)[1] || '').trim();
            break;
          }
        }
        items.push({
          itemId: String(it.itemId || ''),
          title,
          code,
          price: String(((it.managerPrice || {}).currentPrice || '')).replace(/[¥￥\s]/g, ''),
          upDate: String(((it.upShelfDate_m || {}).value || ''))
        });
      }
      const total = (d.pagination || {}).total || ds.length;
      if (ds.length < pageSize || items.length >= total) break;
      current++;
      await this._sleep(400);
    }
    return items;
  }

  /** 卖家中心「1688铺货商品」列表（查重数据源主通道）
   *  页面：https://myseller.taobao.com/home.htm/commodity-center-1688/offer（淘分销·工厂货源·已铺货商品）
   *  数据一次性全量下发（前端本地分页），翻页不发新请求，故直接 DOM 提取 + 翻页兜底。
   *  每行结构：1688货源链接 commodity-center-1688-assistant/od/{offerId} + 淘宝商品链接 item.taobao.com/item.htm?id={itemId}
   * @returns [{offerId, itemId, srcTitle, taobaoTitle, srcPrice, taobaoPrice, status}]
   */
  async getCommodity1688Products({ timeoutMs = 60000 } = {}) {
    const URL_OFFER = 'https://myseller.taobao.com/home.htm/commodity-center-1688/offer';
    const win = this.win;
    if (!win || win.isDestroyed()) throw new Error('店铺工作窗口不可用');

    // 1. 导航（目标页已在则直接复用，避免重复加载卡顿）
    const cur = String(win.getURL() || '');
    if (!cur.includes('commodity-center-1688')) {
      await win.loadURL(URL_OFFER);
      try { await win.webContents.executeJavaScript(DOM_STEALTH, false); } catch (_) {}
    }
    // 2. 等待商品行出现（最长 timeoutMs），期间识别登录失效
    const waitStart = Date.now();
    let rowCount = 0;
    for (;;) {
      try {
        rowCount = await win.webContents.executeJavaScript(`document.querySelectorAll('tr.group-content').length`, false);
      } catch (_) { rowCount = 0; }
      if (rowCount > 0) break;
      if (Date.now() - waitStart > timeoutMs) break;
      // 登录失效快速失败（页面跳到登录/提示）
      try {
        const href = win.getURL();
        if (/login\.taobao\.com|login\.alicdn|passport/.test(href)) throw new Error('商家账号登录态失效，请重新扫码');
        const body = await win.webContents.executeJavaScript(`(document.body?document.body.innerText:'').slice(0,120)`, false);
        if (/登录|扫码/.test(body) && !/commodity/.test(href)) throw new Error('商家账号登录态失效，请重新扫码');
      } catch (e) {
        if (e instanceof Error && /登录态失效/.test(e.message)) throw e;
      }
      await this._sleep(800);
    }
    if (rowCount <= 0) {
      const u = win.getURL();
      if (/login\.taobao\.com|passport/i.test(u)) throw new Error('商家账号登录态失效，请重新扫码');
      throw new Error('1688铺货页加载超时（页面无商品行），当前URL: ' + u.slice(0, 80));
    }
    await this._sleep(1500);

    // 3. 提取 + 翻页兜底（页面上数据可能分页展示；前端本地分页则翻页不产生新请求，行数不变即停）
    const all = [];
    const seenKey = new Set();
    for (let guard = 0; guard < 30; guard++) {
      let rows = [];
      try {
        const raw = await win.webContents.executeJavaScript(EXTRACT_COMMODITY_JS, false);
        rows = JSON.parse(raw || '[]');
      } catch (e) {
        throw new Error('1688铺货商品行解析失败: ' + e.message);
      }
      let added = 0;
      for (const r of rows) {
        const key = r.offerId + '|' + r.itemId;
        if (r.offerId && !seenKey.has(key)) {
          seenKey.add(key);
          all.push(r);
          added++;
        }
      }
      // 翻页判断：下一页按钮存在且未禁用
      let nextState = 'none';
      try {
        nextState = await win.webContents.executeJavaScript(`(function(){
          const b=[...document.querySelectorAll('button')].find(el=>{const t=(el.innerText||'').trim();return /下一页/.test(t)});
          if(!b)return 'none';
          return b.disabled?'disabled':'enabled';
        })()`, false);
      } catch (_) {}
      if (nextState !== 'enabled') break;
      try {
        await win.webContents.executeJavaScript(`(function(){
          const b=[...document.querySelectorAll('button')].find(el=>{const t=(el.innerText||'').trim();return /下一页/.test(t)});
          if(b)b.click();
          return 1;
        })()`, false);
      } catch (_) {}
      await this._sleep(3500);
      let after = 0;
      try { after = await win.webContents.executeJavaScript(`document.querySelectorAll('tr.group-content').length`, false); } catch (_) {}
      if (after <= rows.length || added === 0) break; // 无新增内容（最后一页）
    }
    return all;
  }

  /** 门店列表（黑鲸鱼 GetShopStore 移植：place.taobao.com getStoreList.do JSONP，适用商户） */
  async getShopStores() {
    const url = 'https://place.taobao.com/json/getStoreList.do?pageNo=1&query=&itemId=&pageSize=200&prov=-1&city=-1&district=-1&bizType=300&_input_charset=utf-8&callback=reqwest_' + Date.now() + '353';
    const r = await this._fetch(url, {
      headers: {
        Accept: '*/*',
        Referer: 'https://item.upload.taobao.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Sec-Fetch-Dest': 'script',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    let txt = String(r.html || '');
    const out = [];
    try {
      if (!txt.startsWith('{')) txt = txt.slice(txt.indexOf('{'));
      if (!txt.endsWith('}')) txt = txt.slice(0, txt.lastIndexOf(')'));
      txt = txt.replace(/&quot;/g, '\\"');
      const j = JSON.parse(txt);
      for (const s of (j.list || [])) {
        if (s.name && s.storeId) out.push({ name: String(s.name), storeId: String(s.storeId) });
      }
    } catch (e) {
      throw new Error('门店列表解析失败（需商家账号登录，且店铺已开通线下门店）');
    }
    return out;
  }

  /* ==================== 主图视频上传（黑鲸鱼 VideoApi1 完整移植） ==================== */

  /** OSS 直传 PUT（分片，返回 ETag）
   *  注意：OSS 上传域主机名含下划线（wantu-xxx-...aliyuncs.com），
   *  Chromium 网络栈（Electron net）会拒绝下划线主机（ERR_BLOCKED_BY_CLIENT，黑鲸鱼用 .NET 无此限制），
   *  因此改用 Node 原生 http/https 模块直发（签名在 URL query，无需 cookie） */
  _putBinary(url, chunk) {
    const nodeHttp = require('http');
    const nodeHttps = require('https');
    const { URL: NodeURL } = require('url');
    return new Promise((resolve, reject) => {
      let u;
      try { u = new NodeURL(url); } catch (e) { return reject(new Error('无效上传地址')); }
      const mod = u.protocol === 'https:' ? nodeHttps : nodeHttp;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'PUT',
        headers: {
          'User-Agent': UA,
          'Referer': 'https://myseller.taobao.com/',
          'Origin': 'https://myseller.taobao.com',
          'Content-Length': chunk.length,
        },
      }, (res) => {
        const etag = res.headers['etag'] || res.headers['ETag'] || '';
        res.on('data', () => {});
        res.on('end', () => resolve(String(etag).replace(/"/g, '')));
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      const timer = setTimeout(() => { req.destroy(); reject(new Error('视频分片上传超时')); }, 180000);
      req.write(chunk);
      req.end();
    });
  }

  /** 视频发布请求体（黑鲸鱼 UploadPub 同款嵌套结构） */
  _buildVideoPubBody(fileId, title, covurl, wid, hei) {
    const rid = () => String(Math.floor(1000000 + Math.random() * 9000000));
    const uuid = Number(rid() + rid());
    const ses = Number(rid() + rid());
    const media = [{ fileId, title, mediaType: 'video' }];
    if (wid > 0) media.push({ height: hei, url: covurl, width: wid, mediaType: 'cover' });
    else media.push({ url: covurl, mediaType: 'cover' });
    return JSON.stringify({
      request: JSON.stringify({
        triggerName: 'submit', formName: 'tb_seller_vsucai_publish', from: 'sucai_video',
        serverData: { __native_uuid__: uuid },
        data: { userRole: 'seller', publishType: 'video', title, media, item: [] },
      }),
      params: JSON.stringify({ ugc_scene: 'pcWe', umi_pub_session: ses }),
    });
  }

  /**
   * 主图视频上传完整链（黑鲸鱼 VideoApi1.Upload 同款）：
   * init → 分片PUT → complete → job.submit → aiprocess.execuate(同步封面兜底) → job.query 轮询 → video.publish → material.list 查询
   * @param {string} videoPath 本地 mp4 路径
   * @param {string} itemKey 视频标题标识（黑鲸鱼 "a"+itemId）
   * @param {string} coverFallback 封面兜底图 URL（AI 封面失败时用，推荐传第一张主图）
   * @returns {videoId, mainPicUrl, width, height, videoUrl, duration} 或抛错
   */
  async uploadVideoItem(videoPath, itemKey, coverFallback = '') {
    const buf = fs.readFileSync(videoPath);
    const filename = path.basename(videoPath);
    // 1. init
    const init = await this._mtopTao('mtop.video.upload.init.taobao', '1.0', {
      bizCode: 's_upload_tbs_vsucai', fileSize: buf.length, mimeType: 'video/mp4',
      localFileName: filename, netSpeed: 3000, sdkVersion: '0.6.0-beta.12',
    });
    const model = (init && init.model) || init || {};
    const uploadUrls = model.uploadUrlList || [];
    const uploadId = model.uploadId;
    if (!uploadUrls.length || !uploadId) throw new Error('视频init失败（无上传地址）');
    // 2. 分片 PUT（2MB/片）
    const CHUNK = 2097152;
    const parts = [];
    for (let i = 0; i < uploadUrls.length; i++) {
      const chunk = buf.slice(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
      const etag = await this._putBinary(uploadUrls[i].url, chunk);
      parts.push(JSON.stringify({ partNumber: uploadUrls[i].partNumber, md5: etag }));
      await this._sleep(200);
    }
    // 3. complete
    const comp = await this._mtopTao('mtop.video.upload.complete.taobao', '1.0', {
      bizCode: 's_upload_tbs_vsucai', uploadId, partList: JSON.stringify(parts), netSpeed: 3000, sdkVersion: '0.6.0-beta.12',
    }, { method: 'POST' });
    const cModel = (comp && comp.model) || comp || {};
    const fileId = cModel.fileId;
    if (!fileId) throw new Error('视频complete失败（无fileId）');
    // 4. job.submit（智能封面）
    const sub = await this._mtopTao('mtop.taobao.cp.aiprocess.api.job.submit', '1.0', JSON.stringify({
      bizLine: 'tbs_vsucai', fileId, mediaType: 'VIDEO',
      functions: '[{"code":"intelligent_cover_rec","extraInput":{"selectNum":1,"algoMode":"light"}}]',
      sdkVersion: '1.7.0',
    }), { method: 'POST' });
    const jobId = (sub || {}).jobId;
    // 5. execuate 同步兜底（黑鲸鱼 UploadExecute：sync_query_first_frame 拿封面）
    let cover = '', wid = 0, hei = 0;
    try {
      const exe = await this._mtopTao('mtop.taobao.cp.aiprocess.api.execuate', '1.0', JSON.stringify({
        bizLine: 'tbs_vsucai', fileId, mediaType: 'VIDEO',
        functions: '[{"code":"sync_query_first_frame","extraInput":{"pictureUrls":[],"selectNum":1}}]',
        sdkVersion: '1.7.0',
      }), { method: 'POST' });
      const exRes = (exe && (exe.results || [])[0]) || {};
      if (exRes.value) cover = String(exRes.value);
    } catch (_) {}
    // 6. job.query 轮询（AI 封面可能慢，8 次×3s）
    for (let i = 0; i < 8; i++) {
      await this._sleep(3000);
      try {
        const q = await this._mtopTao('mtop.taobao.cp.aiprocess.api.job.query', '1.0', { jobId, fileId, bizLine: 'tbs_vsucai' });
        const res0 = (q && (q.results || [])[0]) || {};
        const ok = q && (q.success === true || String(q.success) === 'true') || String(res0.success) === 'true';
        if (ok) {
          const val = (q && q.value) || {};
          const imgs = val.images || [];
          if (imgs.length) cover = imgs[0];
          wid = parseInt(val.width, 10) || wid;
          hei = parseInt(val.height, 10) || hei;
          break;
        }
      } catch (_) {}
    }
    // 封面兜底链：AI封面 → execute同步 → 主图（比黑鲸鱼更稳，AI 封面失败也不至于整体失败）
    if (!cover && coverFallback) cover = coverFallback;
    // 7. video.publish
    const pub = await this._mtopTao('mtop.taobao.seller.content.video.publish', '1.0',
      this._buildVideoPubBody(String(fileId), 'a' + itemKey, cover, wid, hei), { method: 'POST' });
    const pubOk = pub && pub.result && (pub.result.success === true || String(pub.result.success) === 'true');
    const videoId = pub && pub.contentId;
    if (!pubOk || !videoId) throw new Error('视频发布失败');
    // 8. material.list 查询最终视频信息（黑鲸鱼 UploadQueryKey）
    try {
      const mat = await this._mtopTao('mtop.taobao.seller.content.material.list', '1.0', {
        keyWord: String(videoId), pageNum: 1, pageSize: 80, recycle: false, orderBy: 'publishTime',
        sort: 1, appKey: 42, type: 'mobile', hideInvalidVideo: false,
      });
      const mdata = (((mat || {}).model || {}).data) || [];
      const hit = mdata.find(x => String(x.contentId) === String(videoId)) || mdata[0] || null;
      if (hit) {
        return {
          videoId: String(hit.contentId || videoId),
          mainPicUrl: hit.snapshot || cover,
          width: parseInt(hit.width, 10) || wid,
          height: parseInt(hit.height, 10) || hei,
          videoUrl: hit.playUrl || '',
          duration: hit.length || 0,
          videoRadio: hit.aspectRatio || '',
        };
      }
    } catch (_) {}
    return { videoId: String(videoId), mainPicUrl: cover, width: wid, height: hei, videoUrl: '', duration: 0, videoRadio: '' };
  }

  /* ==================== 图片处理（翻转/压缩，黑鲸图图处理同款思路） ==================== */

  /** 图片水平翻转（黑鲸鱼 SkuImgDeal/ItemCopyAutoDeal 翻转） */
  async flipImage(filePath) {
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const buf = fs.readFileSync(filePath).toString('base64');
      const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
      const win2 = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      win = win2;
      await win2.loadURL('data:text/html,<html><body></body></html>');
      const js = `
        (async () => {
          const img = new Image();
          img.src = 'data:${mime};base64,' + ${JSON.stringify(buf)};
          await new Promise((r, j) => { img.onload = r; img.onerror = j; });
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          ctx.translate(c.width, 0); ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0);
          return { b64: c.toDataURL('image/jpeg', 0.95).split(',')[1] };
        })()`;
      const r = await win2.webContents.executeJavaScript(js);
      try { win2.destroy(); } catch (_) {} win = null;
      if (!r || !r.b64) return filePath;
      const outPath = path.join(path.dirname(filePath), `fp-${path.basename(filePath).replace(/\.[^.]+$/, '')}-${Date.now()}.jpg`);
      fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
      return outPath;
    } catch (e) {
      try { if (win) win.destroy(); } catch (_) {}
      return filePath;
    }
  }

  /** 图片压缩重编码（黑鲸鱼 IsCompress + CompressRate） */
  async compressImage(filePath, quality) {
    const q = Math.min(0.95, Math.max(0.5, (Number(quality) || 80) / 100));
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const buf = fs.readFileSync(filePath).toString('base64');
      const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
      const win2 = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      win = win2;
      await win2.loadURL('data:text/html,<html><body></body></html>');
      const js = `
        (async () => {
          const img = new Image();
          img.src = 'data:${mime};base64,' + ${JSON.stringify(buf)};
          await new Promise((r, j) => { img.onload = r; img.onerror = j; });
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return { b64: c.toDataURL('image/jpeg', ${q}).split(',')[1] };
        })()`;
      const r = await win2.webContents.executeJavaScript(js);
      try { win2.destroy(); } catch (_) {} win = null;
      if (!r || !r.b64) return filePath;
      const outPath = path.join(path.dirname(filePath), `cp-${path.basename(filePath).replace(/\.[^.]+$/, '')}-${Date.now()}.jpg`);
      fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
      return outPath;
    } catch (e) {
      try { if (win) win.destroy(); } catch (_) {}
      return filePath;
    }
  }

  /** 品牌查询（同窗口内 fetch） */
  async brandQuery(catId, keyword) {    const r = await this._pageFetch('https://item.upload.taobao.com/sell/ai/asyncOpt.htm?optType=taobaoBrandQuery&queryType=query&catId=' + catId, {
      method: 'POST',
      body: 'keyword=' + encodeURIComponent(keyword) + '&pid=p-20000&queryType=query',
      contentType: 'application/x-www-form-urlencoded',
      catId,
    });
    try {
      const j = JSON.parse(r);
      const data = j.data || j.result || j;
      const arr = Array.isArray(data) ? data : (data.dataSource || data.brands || []);
      return arr.map(b => ({ id: b.brandId || b.id || b.value, name: b.brandName || b.name || b.text })).filter(b => b.id);
    } catch (e) { return []; }
  }

  /** 运费模板（窗口内 fetch；黑鲸鱼同款：POST form catId=xxx，响应 data.dataSource[].{value,text}） */
  async refreshTemplates(catId) {
    const cid = String(catId || '50010850');
    const r = await this._pageFetch('https://item.upload.taobao.com/sell/asyncOpt.htm?optType=refreshTemplates', {
      method: 'POST',
      body: 'catId=' + cid,
      contentType: 'application/x-www-form-urlencoded',
      catId: cid,
    });
    try {
      const j = JSON.parse(r);
      const data = j.data || j.result || j;
      const arr = Array.isArray(data) ? data : (data.dataSource || data.templates || []);
      return arr.map(t => ({ id: t.value || t.templateId || t.id, name: t.text || t.templateName || t.name })).filter(t => t.id);
    } catch (e) { return []; }
  }

  /** 通用：工作窗口内 fetch（页面上下文，cookie全） */
  async _pageFetch(url, { method = 'POST', body = null, contentType = null, catId = '50010850' } = {}) {
    const win = this.win;
    if (!win) throw new Error('TaoApi 需要 win');
    await win.loadURL('https://item.upload.taobao.com/sell/v2/publish.htm?catId=' + catId);
    for (let i = 0; i < 15; i++) {
      const ready = await win.webContents.executeJavaScript(`!!(window.csrfToken || window.Json)`, false).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      try {
        const token = (window.csrfToken && window.csrfToken.tokenValue) || '';
        const r = await fetch('${url}', {
          method: '${method}',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            ...(token ? { 'X-XSRF-TOKEN': token } : {}),
            ${contentType ? `'Content-Type': '${contentType}',` : ''}
          },
          ${body ? `body: ${JSON.stringify(body)},` : ''}
          credentials: 'include',
        });
        return await r.text();
      } catch (e) { return 'ERR: ' + e.message; }
    })()`, false);
    return result || '';
  }

  // ==================== 图片上传（黑鲸鱼 Upload8 复刻） ====================

  async _ensureGroupId() {
    if (this.groupId) return this.groupId;
    const r = await this._fetch('https://chuangyi.taobao.com/external/sucai?types=image&entry=main', { referer: 'https://chuangyi.taobao.com/' });
    const m = r.html.match(/defaultGroupId&quot;:(\d+)/) || r.html.match(/defaultGroupId"?\s*:\s*(\d+)/);
    if (m) this.groupId = parseInt(m[1], 10);
    return this.groupId;
  }

  /** 从 session 读取 cookie（黑鲸鱼 GetCookieValue 等价） */
  async _cookie(name) {
    try {
      const cookies = await this.session.cookies.get({});
      const c = cookies.find(x => x.name === name);
      return c ? c.value : '';
    } catch (_) { return ''; }
  }

  /**
   * 图片空间目录（黑鲸鱼 ItemCopySpace.GetItemCatalog 复刻）
   * 根目录名默认 "DXR软件"，找不到则创建；子目录用当天日期
   */
  async _spaceFolderId(picName) {
    const wantName = String(picName || '').trim() || 'DXR软件';
    const cacheKey = 'fld:' + wantName;
    if (this._spaceFolder && this._spaceFolderName === wantName) return this._spaceFolder;
    const tb = await this._cookie('_tb_token_');
    if (!tb) throw new Error('缺 _tb_token_ cookie（店铺登录态失效）');
    const listUrl = `https://tadget.taobao.com/redaction/redaction/json.json?cmd=json_dirTree_query&count=true&_input_charset=utf-8&_tb_token_=${encodeURIComponent(tb)}`;
    const r = await this._fetch(listUrl, { referer: 'https://myseller.taobao.com/', origin: 'https://tadget.taobao.com' });
    if (!r.html.trim().startsWith('{')) {
      try { fs.writeFileSync(path.join(__dirname, '..', '.temp', `space-${Date.now()}.html`), r.html.slice(0, 2000), 'utf8'); } catch (_) {}
      // 黑鲸鱼同款：tadget 失败时回退 H5 接口（GetCataLog1）
      throw new Error('tadget目录接口被拦，走H5');
    }
    let root = null;
    try {
      const j = JSON.parse(r.html);
      const children = (((j.module || {}).dirs || {}).children) || [];
      // 图片空间文件夹名（黑鲸鱼 PicDirName，默认 DXR软件；UI 可自定义 txtPicDirName）
      root = children.find(d => d.name === wantName) || children.find(d => d.name === 'DXR软件') || children.find(d => d.name === '千牛铺货助手') || null;
      if (!root) {
        // 创建根目录
        const addUrl = `https://tadget.taobao.com/redaction/redaction/json.json?cmd=json_add_dir&_input_charset=utf-8&dir_id=0&name=${encodeURIComponent(wantName)}&_tb_token_=${encodeURIComponent(tb)}&callback=reqwest_1546670412970`;
        const addR = await this._fetch(addUrl, { referer: 'https://myseller.taobao.com/', origin: 'https://tadget.taobao.com' });
        let txt = addR.html;
        const m = txt.match(/reqwest_\d+\((.*)\)\s*;?\s*$/s) || txt.match(/(\{[\s\S]*\})/);
        if (m) txt = m[1];
        const aj = JSON.parse(txt);
        const jd = aj.jsonData || aj.data || {};
        root = { id: String(jd.id || jd.dirId || ''), name: wantName, children: [] };
      }
      // 今天日期子目录
      const today = new Date().toISOString().slice(0, 10);
      const sub = (root.children || []).find(c => c.name === today);
      let folderId;
      if (sub) { folderId = String(sub.id); }
      else {
        const addUrl2 = `https://tadget.taobao.com/redaction/redaction/json.json?cmd=json_add_dir&_input_charset=utf-8&dir_id=${encodeURIComponent(root.id || 0)}&name=${encodeURIComponent(today)}&_tb_token_=${encodeURIComponent(tb)}&callback=reqwest_0`;
        const addR2 = await this._fetch(addUrl2, { referer: 'https://myseller.taobao.com/', origin: 'https://tadget.taobao.com' });
        let txt2 = addR2.html;
        const m2 = txt2.match(/^reqwest_\d+\((.*)\)\s*;?\s*$/) || txt2.match(/(\{[\s\S]*\})/);
        if (m2) txt2 = m2[1];
        const aj2 = JSON.parse(txt2);
        const jd2 = aj2.jsonData || aj2.data || {};
        folderId = String(jd2.id || jd2.dirId || '0');
      }
      if (!folderId || folderId === '0') throw new Error('图片空间目录创建失败');
      this._spaceFolder = folderId;
      this._spaceFolderName = wantName;
      return folderId;
    } catch (e) {
      if (e.message !== '缺 _tb_token_ cookie（店铺登录态失效）' && e.message !== '图片空间目录创建失败') {
        throw new Error('图片空间初始化失败: ' + (e.message || r.html.slice(0, 100)));
      }
      throw e;
    }
  }

  /**
   * 通道1：图片空间直传（黑鲸鱼 stream-upload 主通道，不依赖素材中心 token）
   * POST multipart → {success, object:{url}}；folderId 为图片空间目录
   */
  async uploadImageStream(filePath, fileName0, { retries = 2, folderId } = {}) {
    const fileName = fileName0 || path.basename(filePath);
    const fileBuf = fs.readFileSync(filePath);
    if (folderId == null) {
      try { folderId = await this._spaceFolderId(this.picDirName); } catch (_) { folderId = 0; }
    }
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${fileName}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ];
    const body = Buffer.concat([Buffer.from(parts.join(''), 'utf8'), fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
    const url = `https://stream-upload.taobao.com/api/upload.api?_input_charset=utf-8&antiLeech=true&appkey=tu&autoCompress=false&folderId=${folderId}&hideUserId=false&picCompress=true&resizeWidth=false&watermark=false&width=0`;
    const r = await this._fetch(url, {
      method: 'POST', body, contentType: `multipart/form-data; boundary=${boundary}`,
      referer: 'https://myseller.taobao.com/', origin: 'https://myseller.taobao.com',
    });
    if (r.html.includes('punish')) {
      if (retries > 0) { await this._sleep(2000); return this._uploadImageStream(filePath, fileName, { retries: retries - 1, folderId }); }
      throw new Error('图片空间风控');
    }
    let j;
    try { j = JSON.parse(r.html); } catch (e) { throw new Error('图片空间响应异常: ' + r.html.slice(0, 100)); }
    if (j.success === true && j.object && j.object.url) {
      let u = j.object.url;
      if (u.startsWith('//')) u = 'https:' + u;
      return { url: u, id: j.object.fileId || '', name: j.object.fileName || fileName };
    }
    if (retries > 0) { await this._sleep(1500); return this._uploadStream(filePath, fileName, { retries: retries - 1, folderId }); }
    throw new Error('图片空间上传失败: ' + (j.message || r.html.slice(0, 120)));
  }

  /** 别名（内部重试引用） */
  async _uploadStream(filePath, fileName, opts) {
    return this.uploadImageStream(filePath, fileName, opts);
  }

  /** 上传入口：多通道自动切换（黑鲸鱼 Upload 状态机：图片空间直传 → 素材中心） */
  async uploadImage(filePath, fileName, opts = {}) {
    const { forceChannel, retries = 2 } = opts;
    // 默认通道：图片空间直传（黑鲸鱼主通道，不触发素材中心滑块风控）
    if (forceChannel !== 'sucai') {
      try {
        return await this.uploadImageStream(filePath, fileName, { retries });
      } catch (e) {
        // 图片空间失败 → 切素材中心兜底
        if (forceChannel === 'stream') throw e;
        try { return await this._uploadSucai(filePath, fileName, { retries }); } catch (e2) { throw e2; }
      }
    }
    return this._uploadSucai(filePath, fileName, { retries });
  }

  /** ==================== 扩展功能（黑鲸鱼移植二期） ==================== */

  /**
   * 类目尺码表定义（黑鲸鱼 GetSizeMap：render.json → required 列 → {字段key: label}）
   * render.json 是发布页异步组件接口（直连 net 返回错误页），必须页面上下文同源 fetch（categorySearch 同款）
   * 返回如 {shengao:'身高（cm）', tizhong:'体重（公斤）'}，空对象=该类目无必填尺码列
   */
  /** 尺码表定义（黑鲸鱼同款：sizeMappingV3 必填列；group 为发布页 selectedSizeGroupId 的 {subName,value,sizeGroupType}，不传时用默认男装组） */
  async getSizeMap(catId, group) {
    const key = 'sz:' + catId + ':' + ((group && (group.subName || group.value)) || 'default');
    if (this._pageCache.has(key)) return this._pageCache.get(key);
    const win = this.win;
    if (!win) throw new Error('TaoApi 需要 win');
    // 页面需在发布域（同源 fetch）
    if (!/item\.upload\.taobao\.com/.test(win.webContents.getURL())) {
      await win.loadURL(`https://item.upload.taobao.com/sell/v2/publish.htm?catId=${catId}`);
      for (let i = 0; i < 15; i++) {
        const ready = await win.webContents.executeJavaScript(`!!(window.csrfToken || window.Json)`, false).catch(() => false);
        if (ready) break;
        await this._sleep(1000);
      }
    }
    // 尺码组：优先发布页 selectedSizeGroupId（如 中国号型A → sizeGroup_136553091-women_tops），缺省男装上装
    let gid = String((group && (group.subName || group.value)) || 'sizeGroup_136553091-men_tops');
    if (gid && !gid.startsWith('sizeGroup_')) gid = 'sizeGroup_' + gid;
    let gtype = (group && group.sizeGroupType) || '';
    if (!gtype && gid.includes('-')) gtype = gid.split('-').pop();
    const result = await win.webContents.executeJavaScript(`(async () => {
      try {
        const token = (window.csrfToken && window.csrfToken.tokenValue) || '';
        const r = await fetch('/taobao/size/chart/v3/render.json?sizeType=sizeMappingV3&catId=${catId}&recommend=true&mapping=true&model=true&sizeSellerRecommend=true&itemId=0', {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(token ? { 'X-XSRF-TOKEN': token } : {}),
          },
          credentials: 'include',
          body: 'jsonBody=' + encodeURIComponent(JSON.stringify({
            sizeRecommend: { supportOneDim: true, disabled: false },
            sizeMapping: { disabled: false },
            sizeModelTryInfo: { disabled: false },
            brandId: 3246379, groupId: '${gid}', groupType: '${gtype}', selectedSizes: [],
          })),
        });
        return { status: r.status, text: (await r.text()).slice(0, 60000) };
      } catch (e) { return { status: 0, text: 'ERR: ' + e.message }; }
    })()`, false);
    const out = {};
    try {
      const txt = String(result && result.text || '');
      if (!txt.trim().startsWith('{')) throw new Error('非JSON响应(status=' + (result && result.status) + '): ' + txt.slice(0, 80));
      const j = JSON.parse(txt);
      const cols = ((((((j.data || {}).subItems || {}).sizeMapping || {}).subItems || {}).sizeTable || {}).column) || [];
      // 收集所有列（required=false 的"尺寸"也要，否则尺码表跳过）；身高/体重/胸围由 buildSizeMappingV3 用尺码文本推算
      for (const c of cols) {
        if (c && c.name) out[String(c.name)] = String(c.label || c.name);
      }
      // 无数值列（shengao/tizhong/xiongwei）时兜底固定列，保证 sizeMappingIpt 有可映射字段
      if (!out.shengao && !out.tizhong && !out.xiongwei) {
        out.shengao = '身高(cm)';
        out.tizhong = '体重(kg)';
        out.xiongwei = '胸围(cm)';
      }
    } catch (e) { throw new Error('尺码表定义获取失败: ' + (e.message || '').slice(0, 120)); }
    this._pageCache.set(key, out);
    return out;
  }

  /** 保存草稿（黑鲸鱼 UploadItemApi.SaveDraft：POST draftOp/add.json，name=时间戳&jsonBody=） */
  async saveDraft(upItem) {
    let xsrf = '';
    try { xsrf = await this._cookie('XSRF-TOKEN'); } catch (_) {}
    const name = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const body = 'name=' + encodeURIComponent(name) + '&jsonBody=' + encodeURIComponent(JSON.stringify(upItem));
    const r = await this._fetch(`https://item.upload.taobao.com/sell/draftOp/add.json?catId=${upItem.catId}`, {
      method: 'POST', body, contentType: 'application/x-www-form-urlencoded',
      referer: `https://item.upload.taobao.com/sell/smart/publish.htm`,
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*', Origin: 'https://item.upload.taobao.com', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}) },
    });
    try {
      const j = JSON.parse(r.html);
      if (j && (j.success || (j.jsonData && j.jsonData.id))) return { ok: true, id: String((j.jsonData || {}).id || ''), name };
      return { ok: false, error: (j && (j.message || j.errorMsg)) || r.html.slice(0, 120) };
    } catch (e) { return { ok: false, error: '草稿响应异常: ' + r.html.slice(0, 120) }; }
  }

  /** 草稿列表（黑鲸鱼 GetDraftList：draftList.json → [{id,name}]） */
  async getDraftList(catId) {
    let xsrf = '';
    try { xsrf = await this._cookie('XSRF-TOKEN'); } catch (_) {}
    const r = await this._fetch(`https://item.upload.taobao.com/sell/draftList.json?catId=${catId}`, {
      referer: 'https://item.upload.taobao.com/sell/smart/publish.htm',
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}) },
    });
    try {
      const j = JSON.parse(r.html);
      const list = (j.jsonData || j.data || j.drafts || []);
      return (Array.isArray(list) ? list : []).map(d => ({ id: String(d.id || d.dbDraftId || ''), name: String(d.name || '') })).filter(x => x.id);
    } catch (e) { return []; }
  }

  /** 删除草稿（黑鲸鱼 draftOp/delete.json?dbDraftId=） */
  async deleteDraft(catId, draftId) {
    let xsrf = '';
    try { xsrf = await this._cookie('XSRF-TOKEN'); } catch (_) {}
    const r = await this._fetch(`https://item.upload.taobao.com/sell/draftOp/delete.json?dbDraftId=${draftId}&catId=${catId}`, {
      method: 'POST', body: '', contentType: 'application/x-www-form-urlencoded',
      referer: 'https://item.upload.taobao.com/sell/smart/publish.htm',
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}) },
    });
    try { const j = JSON.parse(r.html); return !!(j.success || j.jsonData); } catch (e) { return false; }
  }

  /** 标题分词（黑鲸鱼 GetSplitWord 同款外部接口；失败返回 null=跳过重组） */
  async getSplitWord(title) {
    try {
      const enc = encodeURIComponent(String(title));
      const key = crypto.createHash('md5').update(enc + '&fc').digest('hex');
      const r = await this._fetch(`http://api.pojunxing.com/nlpir/split?title=${enc}&key=${key}`, { timeoutMs: 8000 });
      const j = JSON.parse(r.html);
      if (j && Array.isArray(j.data)) return String(j.data).split(' ').map(s => s.trim()).filter(Boolean);
      return null;
    } catch (e) { return null; }
  }

  /** 标题翻译成英文（黑鲸鱼 TranslateApi：百度翻译通用 API） */
  async translateTitle(title) {
    try {
      const appid = '20260508002609246', key = 'xccj7sqa9eAe_BN7T70i';
      const salt = String(Math.floor(Math.random() * 100000));
      const sign = crypto.createHash('md5').update(appid + title + salt + key).digest('hex');
      const r = await this._fetch(`http://api.fanyi.baidu.com/api/trans/vip/translate?q=${encodeURIComponent(title)}&from=zh&to=en&appid=${appid}&salt=${salt}&sign=${sign}`, { timeoutMs: 8000 });
      const j = JSON.parse(r.html);
      const dst = j && j.trans_result && j.trans_result[0] && j.trans_result[0].dst;
      return dst ? String(dst) : title;
    } catch (e) { return title; }
  }

  /**
   * 拼接详情长图（黑鲸鱼 chkMegerImage/拼接详情页：多张图垂直拼接成一张）
   * @returns 拼接后文件路径，失败返回 null（调用方退回逐张模式）
   */
  async megerImages(filePaths, maxWidth = 750) {
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const imgs = [];
      for (const p of filePaths) {
        const buf = fs.readFileSync(p).toString('base64');
        const mime = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
        imgs.push({ buf, mime });
      }
      if (!imgs.length) return null;
      const win2 = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      win = win2;
      await win2.loadURL('data:text/html,<html><body></body></html>');
      const js = `
        (async () => {
          const imgs = ${JSON.stringify(imgs)};
          const loaded = [];
          for (const it of imgs) {
            const img = new Image();
            img.src = 'data:' + it.mime + ';base64,' + it.buf;
            await new Promise((r, j) => { img.onload = r; img.onerror = r; });
            loaded.push(img);
          }
          if (!loaded.length || !loaded.some(i => i.naturalWidth)) return { fail: true };
          const W = ${Number(maxWidth) || 750};
          let H = 0;
          const scaled = loaded.map(img => {
            const iw = img.naturalWidth || W, ih = img.naturalHeight || 0;
            const s = W / iw;
            const h = Math.round(ih * s);
            H += h;
            return { img, h };
          });
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, W, H);
          let y = 0;
          for (const s of scaled) { ctx.drawImage(s.img, 0, y, W, s.h); y += s.h; }
          return { b64: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
        })()`;
      const r = await win2.webContents.executeJavaScript(js);
      try { win2.destroy(); } catch (_) {} win = null;
      if (!r || r.fail || !r.b64) return null;
      const outPath = path.join(path.dirname(filePaths[0]), `merged-${Date.now()}.jpg`);
      fs.writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
      return outPath;
    } catch (e) {
      try { if (win) win.destroy(); } catch (_) {}
      return null;
    }
  }

  /** 素材中心上传（原 uploadImage 本体，改名） */
  async _uploadSucai(filePath, fileName, { retries = 2 } = {}) {
    fileName = fileName || path.basename(filePath);
    if (!/\.(jpg|jpeg|png|webp)$/i.test(fileName)) fileName = fileName.replace(/\.[^.]+$/, '') + '.jpg';
    const fileBuf = fs.readFileSync(filePath);
    await this._ensureGroupId().catch(() => {});

    // 1. signature（黑鲸鱼同款：失败自动重试，token 失效重新 init）
    let sigR;
    try {
      sigR = await this._fetch('https://chuangyi.taobao.com/sucai/api_v2/resources/signature', {
        method: 'POST', body: JSON.stringify({ fileName, saveToMts: true }), contentType: 'application/json',
      });
    } catch (e) {
      if (retries > 0) { await this._sleep(1500); return this.uploadImage(filePath, fileName, { retries: retries - 1 }); }
      throw e;
    }
    // 风控/punish：重置 token 重新 init（黑鲸鱼 u8err≥20 时重新加载素材中心换 token），等 2s 后重试
    if (sigR.html.includes('punish')) {
      try { fs.writeFileSync(path.join(__dirname, '..', '.temp', `punish-${Date.now()}.html`), sigR.html.slice(0, 3000), 'utf8'); } catch (_) {}
      if (retries > 0) {
        this.cyToken = ''; this.groupId = 0;
        await this._sleep(2000);
        try { await this.init(); } catch (_) {}
        return this.uploadImage(filePath, fileName, { retries: retries - 1 });
      }
      throw new Error('素材中心风控拦截');
    }
    if (sigR.html.includes('invalid csrf token')) {
      if (retries > 0) { this.cyToken = ''; await this.init(); return this.uploadImage(filePath, fileName, { retries: retries - 1 }); }
      throw new Error('Token过期已重置，请重试');
    }
    let sig;
    try { sig = JSON.parse(sigR.html); } catch (e) { throw new Error('签名响应异常: ' + sigR.html.slice(0, 100)); }
    // 响应结构: { params: { key, policy, ...oss表单字段 }, ... } 或直接平铺。黑鲸鱼直接遍历整个对象当表单字段
    const ossParams = (sig && sig.params && sig.params.key) ? sig.params : ((sig && sig.data && sig.data.key) ? sig.data : (sig && sig.key ? sig : null));
    if (!ossParams || !ossParams.key) throw new Error('签名缺key: ' + JSON.stringify(sig).slice(0, 200));

    // 2. OSS 直传
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(ossParams)) {
      if (typeof v !== 'string') continue;
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`);
    const body = Buffer.concat([Buffer.from(parts.join(''), 'utf8'), fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
    const ossRes = await this._fetch('https://creatives-assets.oss-accelerate.aliyuncs.com', {
      method: 'POST', body, contentType: `multipart/form-data; boundary=${boundary}`,
    });
    if (ossRes.status !== 200 && ossRes.status !== 204) {
      if (retries > 0) { await this._sleep(1500); return this.uploadImage(filePath, fileName, { retries: retries - 1 }); }
      throw new Error(`OSS直传失败 ${ossRes.status}`);
    }

    // 3. callback
    const cbR = await this._fetch('https://chuangyi.taobao.com/sucai/api_v2/resources/signatureCallback', {
      method: 'POST',
      body: JSON.stringify({
        objectName: ossParams.key, fileName, groupId: this.groupId || 0,
        mr: null, format: null, mediaId: null, bizFlow: '', dsp: 'EXTERNAL', withItems: true,
        bizCode: 'algo_mama_search_white', isLoose: true,
      }),
      contentType: 'application/json',
    });
    if (cbR.html.includes('punish')) {
      if (retries > 0) { this.cyToken = ''; this.groupId = 0; await this._sleep(2000); try { await this.init(); } catch (_) {} return this.uploadImage(filePath, fileName, { retries: retries - 1 }); }
      throw new Error('素材中心风控（回调）');
    }
    let cb;
    try { cb = JSON.parse(cbR.html); } catch (e) { throw new Error('回调响应异常: ' + cbR.html.slice(0, 100)); }
    const item = cb && cb.data && cb.data.items && cb.data.items[0];
    if (!item || !item.url) throw new Error('回调无URL: ' + cbR.html.slice(0, 150));

    // 4. push（失败不影响）
    await this._fetch('https://chuangyi.taobao.com/sucai/api_v2/resources/pushMediaCenter', {
      method: 'POST', body: JSON.stringify({ resources: [item] }), contentType: 'application/json',
    }).catch(() => {});

    return { url: item.url, id: item.id, name: item.name };
  }

  // ==================== 属性映射（黑鲸鱼 GetPropData 复刻） ====================

  /** 1688 属性名 → 淘宝属性 label 默认映射（黑鲸鱼 propsChange 同款，内置免手写） */
  static _ATTR_ALIAS() {
    return {
      // 面料/材质
      '面料名称': '面料', '主面料': '面料', '材质': '面料',
      '主面料成分': '材质成分', '主面料成分2': '材质成分', '成分含量': '材质成分', '材质成分': '材质成分',
      // 风格/款式
      '风格类型': '风格', '风格': '风格',
      '工艺': '面料工艺', '面料工艺': '面料工艺',
      '门襟': '衣门襟', '衣门襟': '衣门襟',
      // 版型/裙型（去空格差异）
      '裙长': '裙长', '裙摆': '裙型', '裙型': '裙型',
      // 其他常用
      '吊牌': '吊牌价', '适用年龄': '适用年龄', '适用人群': '适用人群', '适用场景': '适用场景',
      '流行元素': '款式细节', '款式': '款式', '廓形': '廓形', '版型': '版型',
      '领型': '领型', '领子': '领型', '袖型': '袖型', '袖长': '袖长', '腰型': '腰型',
      '产地': '产地', '货号': '货号', '组合形式': '组合形式', '里料': '里料', '柔软指数': '柔软指数',
      '弹性指数': '弹性指数', '厚薄': '厚薄', '系列': '系列', '穿着方式': '穿着方式', '功能': '功能',
      '适用季节': '适用季节', '是否商场同款': '是否商场同款',
    };
  }

  /** 属性名归一化：去 斜杠/空格/横线/括号 后统一匹配（"上市年份/季节"="上市年份季节"） */
  static _normProp(s) {
    return String(s || '').replace(/[\/\s_\-（）()]/g, '').toLowerCase();
  }

  static mapProps(itemProps, pageProps) {
    const out = [];
    // 内置别名：把 1688 属性名映射到淘宝属性 label（黑鲸鱼 propsChange 同款，用户无需手写）
    const src = { ...(itemProps || {}) };
    const alias = TaoApi._ATTR_ALIAS();
    for (const k of Object.keys(alias)) {
      if (src[k] != null && src[k] !== '') {
        const to = alias[k];
        // 不覆盖已存在的更精确值（如 1688 同时有"面料"与"面料名称"时优先"面料"）
        if (src[to] == null || src[to] === '') src[to] = src[k];
      }
    }
    // 归一化索引（"上市年份/季节" 匹配 "上市年份季节" 等）
    const normIndex = {};
    for (const k of Object.keys(src)) normIndex[TaoApi._normProp(k)] = src[k];
    const getVal = (label) => {
      if (src[label] != null && String(src[label]).trim() !== '') return String(src[label]).trim();
      const hit = normIndex[TaoApi._normProp(label)];
      return (hit != null && String(hit).trim() !== '') ? String(hit).trim() : '';
    };
    for (const p of pageProps) {
      if (!p.name || p.name === 'p-20000' || p.label === '保质期') continue;
      const srcVal = getVal(p.label);
      if (p.uiType === 'input') {
        if (srcVal) out.push({ name: p.name, value: srcVal });
        // 必填输入框：有候选取候选首项，无候选（自由文本，如型号/货号）兜底"其他"过必填校验（与DOM路径一致）
        else if (p.required) out.push({ name: p.name, value: p.dataSource.length ? p.dataSource[0].text : '其他' });
      } else if (p.uiType === 'select' || p.uiType === 'singleSelect') {
        if (!srcVal) { if (p.required && p.dataSource.length) out.push({ name: p.name, value: { text: p.dataSource[0].text, value: p.dataSource[0].value } }); continue; }
        const hit = p.dataSource.find(d => d.text === srcVal)
          || p.dataSource.find(d => d.text && (d.text.includes(srcVal) || srcVal.includes(d.text)));
        if (hit) out.push({ name: p.name, value: { text: hit.text, value: hit.value } });
        else if (p.required && p.dataSource.length) {
          // 兜底：先用 1688 其他属性值尝试匹配候选（如"主面料成分=涤纶"补"面料"），找不到再用候选第一个
          let fb = p.dataSource[0];
          for (const v of Object.values(src)) {
            const vs = String(v == null ? '' : v).trim();
            if (!vs || vs === srcVal) continue;
            const h2 = p.dataSource.find(d => d.text === vs) || p.dataSource.find(d => d.text && (d.text.includes(vs) || vs.includes(d.text)));
            if (h2) { fb = h2; break; }
          }
          out.push({ name: p.name, value: { text: fb.text, value: fb.value } });
        }
      } else if (p.uiType === 'checkbox' || p.uiType === 'multiSelect') {
        if (!srcVal) {
          // 必填多选项：1688无该属性时兜底勾第一个候选（如"适用场景"）
          if (p.required && p.dataSource.length) out.push({ name: p.name, value: [{ text: p.dataSource[0].text, value: p.dataSource[0].value }] });
          continue;
        }
        const list = srcVal.split(/[,，、\s]+/).filter(Boolean)
          .map(v => p.dataSource.find(d => d.text === v || (d.text && d.text.includes(v))))
          .filter(Boolean).map(d => ({ text: d.text, value: d.value }));
        if (list.length) out.push({ name: p.name, value: list });
      } else if (p.uiType === 'material') {
        if (!srcVal) { if (p.required && p.dataSource.length) out.push({ name: p.name, value: [{ text: p.dataSource[0].text, value: p.dataSource[0].value, content: '100' }] }); continue; }
        const list = [];
        for (const part of srcVal.split(/\s+/)) {
          const m = part.match(/^(.+?)(\d+(?:\.\d+)?)%?$/);
          if (m && m[1] && m[2]) {
            const hit = p.dataSource.find(d => d.text === m[1] || (d.text && d.text.includes(m[1])));
            list.push({ text: hit ? hit.text : m[1], value: hit ? hit.value : m[1], content: m[2] });
          } else if (part) {
            const hit = p.dataSource.find(d => d.text === part || (d.text && d.text.includes(part)));
            if (hit) list.push({ text: hit.text, value: hit.value, content: '100' });
          }
        }
        if (list.length) out.push({ name: p.name, value: list });
      } else {
        if (srcVal) out.push({ name: p.name, value: srcVal });
        else if (p.required && p.dataSource.length) out.push({ name: p.name, value: p.dataSource[0].text });
      }
    }
    return out;
  }

  // ==================== SKU 构造（黑鲸鱼 GetSaleCat + UpSku 复刻） ====================

  /**
   * 1688 SKU 数据 → 淘宝 saleProp + sku 数组
   * @param skuDefs 1688 规格定义 [{name:'颜色', values:[{name, imageUrl}]}]
   * @param skuInfos 1688 组合明细 [{values:['红色','S'], price, stock}]
   * @param saleFields 发布页销售属性 [{key:'p-1627207', label:'颜色分类', isCustom, dataSource}]
   * @param calcPrice (cost) => 售价（加价规则）
   * @param opts {stock, uploadSkuImg}
   * @returns {saleProp, sku, price}（sku 为空数组 = 一口价模式）
   */
  static buildSku(skuDefs, skuInfos, saleFields, calcPrice, opts = {}) {
    const stock = opts.stock || 99;
    const fallbackCost = opts.fallbackCost || 0; // 单SKU无价格时用商品价兜底
    const specSkuMap = opts.specSkuMap || {};    // 尺码组属性（黑鲸鱼 specSkuList）
    const addCfg = opts.addSku || {};            // {addNoSku, addNoSku1, addSkuText}（黑鲸鱼 IsAddNoSku/IsAddNoSku1/AddSku）

    // 黑鲸鱼"原宝贝无SKU自动加SKU"（chkAddNoSku1）：无规格商品 → 用补齐规则造单规格 SKU
    if (!skuDefs.length || !skuInfos.length) {
      if (addCfg.addNoSku1 && saleFields.length) {
        const field = saleFields.find(f => /颜色/.test(f.label)) || saleFields[0];
        const vals = TaoApi._pickSkuValue(field, addCfg.addSkuText || '');
        if (field && vals && field.dataSource.length) {
          const cost = opts.fallbackCost || 0;
          const sell = calcPrice(cost);
          if (sell != null && sell > 0) {
            return {
              saleProp: specSkuMap[field.key] ? { [field.key]: { selectedSizeGroupId: specSkuMap[field.key], value: [vals] } } : { [field.key]: [vals] },
              sku: [{ skuStatus: 1, skuStock: String(stock), skuPrice: String(sell), props: [{ name: field.key, value: vals.value, text: vals.text, label: field.label }] }],
              price: sell,
            };
          }
        }
      }
      return { saleProp: {}, sku: [], price: null };
    }

    // 1688 规格名 → 淘宝销售属性字段
    const matchField = (defName) => {
      const n = String(defName || '').trim();
      // 黑鲸鱼同款映射：颜色→颜色分类(1627207)，尺码/尺寸→尺码(20509)
      let f = saleFields.find(x => n.includes(x.label) || x.label.includes(n));
      if (!f && /颜色|色号/.test(n)) f = saleFields.find(x => x.label.includes('颜色'));
      if (!f && /尺码|尺寸|码数/.test(n)) f = saleFields.find(x => x.label.includes('尺码'));
      return f || null;
    };
    const matchedFieldKeys = new Set(skuDefs.map(d => (matchField(d.name) || {}).key).filter(Boolean));

    // ---- 缺失销售属性补齐（黑鲸鱼 L54229：required 比已映射多时补默认值）----
    // 修复：必填销售字段无条件补齐（否则淘宝后台报"销售规格/适用项必填未填"）；
    //       非必填仅在用户开启 addNoSku1（无SKU自动加SKU）时补
    const addedProps = []; // 补齐的 {name, value, text, label}
    for (const field of saleFields) {
      if (matchedFieldKeys.has(field.key)) continue;
      const isRequired = !!field.required;
      if (!isRequired && !addCfg.addNoSku1) continue;      // 非必填且未开 chkAddNoSku1 → 跳过
      if (!isRequired && addCfg.addNoSku1 && !addCfg.addNoSku) continue;
      // 必填字段：无需开关，直接补齐（防止"必填项未填"导致后台体检错误）
      if (field.isCustom && !(field.dataSource || []).length) continue; // 自定义值规格无候选，黑鲸鱼同款跳过
      const vals = TaoApi._pickSkuValue(field, addCfg.addSkuText || '');
      if (vals) addedProps.push({ name: field.key, value: vals.value, text: vals.text, label: field.label, _vals: vals, _field: field });
    }

    // 每个规格：值 → {vid, text, field}（vid 淘宝真实值数字 或 负数伪造 自定义值，黑鲸鱼 value 统一 long）
    const fakeBase = Number(String(Date.now()).slice(-9));
    let fakeSeq = 0;
    const defValueMap = new Map(); // defName → Map(值文本 → {vid, text, field})
    const usedByField = new Map(); // fieldKey → [{text, value}]（saleProp 汇总去重）
    for (const def of skuDefs) {
      const field = matchField(def.name);
      if (!field) continue;
      const vm = new Map();
      for (const v of (def.values || [])) {
        let text = String(v.name || '').trim();
        if (!text) continue;
        // SKU替换词（黑鲸鱼 SkuReplaceWord：a=b）与随机字符（SkuRandomWord）
        if (opts.valueTransform) text = opts.valueTransform(text);
        // 淘宝候选值优先（精确→包含匹配）
        let hit = field.dataSource.find(d => d.text === text)
          || field.dataSource.find(d => d.text && (d.text.includes(text) || text.includes(d.text)));
        let vid;
        if (hit) {
          vid = Number(hit.value);
          text = hit.text;
        } else {
          // 自定义值（黑鲸鱼：负数伪造ID；文本截断防超限）
          vid = -(fakeBase + (fakeSeq++));
          text = text.slice(0, 20);
        }
        vm.set(String(v.name || '').trim(), { vid, text, field, imageUrl: (v.imageUrl && v.uploadedUrl) ? v.imageUrl : '' });
        if (!usedByField.has(field.key)) usedByField.set(field.key, []);
        const arr = usedByField.get(field.key);
        // SKU 图仅在上传后才挂 imageUrl（未上传时不能把 1688 外域 URL 塞进淘宝表单）
        if (!arr.find(x => x.value === vid)) arr.push((v.imageUrl && v.uploadedUrl) ? { text, value: vid, imageUrl: v.imageUrl } : { text, value: vid });
      }
      defValueMap.set(String(def.name || '').trim(), vm);
    }
    if (!defValueMap.size && !addedProps.length) return { saleProp: {}, sku: [], price: null };

    // 组合 → sku 数组（黑鲸鱼 UpSku：props 按规格顺序 name=pid / value 数字 / text / label）
    // 补齐的缺失规格（addedProps）追加到每个组合（黑鲸鱼 list9 参与组合同款）
    const sku = [];
    let minPrice = null;
    for (const info of skuInfos) {
      const props = [];
      let ok = true;
      const defNames = skuDefs.map(d => String(d.name || '').trim());
      for (let i = 0; i < defNames.length; i++) {
        const vm = defValueMap.get(defNames[i]);
        if (!vm) continue; // 未匹配字段跳过（该规格丢弃）
        const valText = String(info.values[i] || '').trim();
        const m = vm.get(valText) || [...vm.entries()].find(([k]) => k.includes(valText) || valText.includes(k));
        if (!m) { ok = false; break; }
        const { vid, text, field } = (m[1] || m);
        props.push({ name: field.key, value: vid, text, label: field.label });
      }
      if (!ok || !props.length) continue;
      for (const ap of addedProps) props.push({ name: ap.name, value: ap.value, text: ap.text, label: ap.label });
      const cost = info.price > 0 ? info.price : fallbackCost;
      const sell = calcPrice(cost);
      if (sell == null || sell <= 0) continue;
      if (minPrice == null || sell < minPrice) minPrice = sell;
      sku.push({
        skuStatus: 1,
        skuStock: String(stock),
        skuPrice: String(sell),
        props,
      });
      if (sku.length >= 150) break; // 淘宝 SKU 组合上限保护
    }
    if (!sku.length) return { saleProp: {}, sku: [], price: null };

    // saleProp（黑鲸鱼 GetSaleCat：普通属性=值数组；尺码组属性={selectedSizeGroupId, value}）
    // 补齐的缺失规格值也汇总进对应字段（黑鲸鱼 UpSkuProps 同款）
    for (const ap of addedProps) {
      const f = ap._field;
      if (!usedByField.has(f.key)) usedByField.set(f.key, []);
      const arr = usedByField.get(f.key);
      if (!arr.find(x => x.value === ap.value)) arr.push({ text: ap.text, value: ap.value });
    }
    const saleProp = {};
    for (const [k, arr] of usedByField) {
      if (specSkuMap[k]) {
        saleProp[k] = { selectedSizeGroupId: specSkuMap[k], value: arr };
      } else {
        saleProp[k] = arr;
      }
    }
    return { saleProp, sku, price: minPrice };
  }

  /** 从 addSku 文本（"颜色=黑色，一行一个"）或字段候选值里取补齐值（黑鲸鱼 L54246 同款优先级） */
  static _pickSkuValue(field, addSkuText) {
    if (!field) return null;
    const ds = (field.dataSource || []).slice();
    if (!ds.length) return null;
    // 1. addSku 文本优先："规格名=值"
    for (const line of String(addSkuText || '').split(/\r?\n/)) {
      const m = String(line).match(/^([^=]+)=(.+)$/);
      if (!m) continue;
      const name = m[1].trim(), val = m[2].trim();
      const label = String(field.label || '');
      if (label.includes(name) || name.includes(label)) {
        const hit = ds.find(d => d.text === val) || ds.find(d => d.text && (d.text.includes(val) || val.includes(d.text)));
        if (hit) return { text: hit.text, value: Number(hit.value) };
      }
    }
    // 2. 无指定 → 用第一个候选值（黑鲸鱼 array9[0]）
    return { text: ds[0].text, value: Number(ds[0].value) };
  }

  // ==================== UpItem 构造 ====================

  static buildUpItem(info) {
    const images = (info.images || []).map(u => ({ url: u }));
    // 黑鲸鱼 defaultVale 复刻：stuffStatus/startTime/subStock/vipDiscount/globalStock/paymentMode 等均为 {value:...} 对象
    const upLoadType = info.putawayTime ? 1 : (info.warehouse ? 2 : 0); // enumUpLoadWay: 0=直接上架 1=定时上架 2=放入仓库
    const item = {
      catId: Number(info.catId),
      id: 0,
      title: info.title,
      quantity: String(info.quantity || 99),
      price: String(info.price),
      outerId: info.outerId || '',
      images,
      mainImagesGroup: { 'mainImagesGroup-imageGroup': { images } },
      desc: info.desc || '',
      wirelessDesc: info.wirelessDesc || info.desc || '',
      descType: { value: 0 },
      wirelessDescType: { value: 0 },
      catProp: {},
      saleProp: info.saleProp || {},
      sku: info.sku || [],
      tbExtractWay: { template: (info.shipTemplate != null && String(info.shipTemplate) !== '') ? String(info.shipTemplate) : '0', value: ['2'] },
      location: info.location || '浙江省 杭州市',
      startTime: { type: upLoadType, shelfTime: upLoadType === 1 ? String(info.putawayTime) : null },
      auctionType: 'b',
      // 二手/全新（黑鲸鱼 IsTwoItem：二手 value=6 带 text，全新 value=5）
      stuffStatus: info.secondHand ? { value: 6, text: '二手' } : { value: 5 },
      // 退换货承诺（黑鲸鱼 IsBackCn：sellPromise=[{value:1}]）
      sellPromise: info.backPromise ? [{ value: 1 }] : [],
      // 7天退货服务（黑鲸鱼 Is7DayBackOne 关闭时=0）
      sevenDayOptional: info.sevenDay === false ? 0 : 1,
      sevenDayDefaultValue: 3,
      // 库存计数（黑鲸鱼 StockType：0=付款减库存 1=拍下减库存）
      subStock: { value: Number(info.subStock) === 0 ? 0 : 1 },
      vipDiscount: { value: -1 },
      globalStock: { value: 'globalStock_0' },
      paymentMode: { value: 'buyNow' },
      catSuggest: { empty: false },
      regionLimitSale: { value: 'regionLimitSale_0' },
      inventoryMode: { value: 1 },
      shopcat: info.shopcat || [],
      fromAIPublish: 1,
      guideMaterialEnable: 1,
      showDraft: 1,
      spuConfirm: 1,
      sevenDayGray: -1,
      qualityIdentify: '1',
      itemdiagnoseInfo: '{"showNewVersion":true}',
      imageVideo: [{ itemId: 0, interactiveId: 0 }],
      verticalImage: info.verticalUrl ? [{ url: info.verticalUrl }] : [],
      qualification: [],
      customSaleProp: [],
      customItemProp: [],
    };
    // 条形码（黑鲸鱼 BarCode）
    if (info.barcode) item.barcode = String(info.barcode);
    // 发货时效（黑鲸鱼 tbDeliveryTime：UI 1=24小时 2=48小时 3=72小时 → value=天数）
    if (Number(info.deliveryTime) === 1) item.tbDeliveryTime = { text: '1', value: 1 };
    else if (Number(info.deliveryTime) === 2) item.tbDeliveryTime = { text: '2', value: 2 };
    else if (Number(info.deliveryTime) >= 3) item.tbDeliveryTime = { text: String(Number(info.deliveryTime)), value: Number(info.deliveryTime) };
    // 重量（黑鲸鱼 deliverWeight：仅按重量计费模板生效，包邮/计件时后端忽略）
    if (info.postWeight != null && Number(info.postWeight) > 0 && String(info.shipTemplate || '0') !== '0') {
      item.deliverWeight = String(Number(info.postWeight));
    }
    // 多件优惠（黑鲸鱼 multiDiscountPromotion：{value:9.5折, type:1, enable:true}）
    if (info.multiDiscount) {
      item.multiDiscountPromotion = { value: Number(info.multiDiscountVal) > 0 ? Number(info.multiDiscountVal) : 9.5, type: 1, enable: true };
    }
    // 尺码表（黑鲸鱼 sizeMappingV3：{sizeRecommend, sizeMapping:{sizeMappingIpt}, sizeModelTryInfo}）
    if (info.sizeMappingV3) item.sizeMappingV3 = info.sizeMappingV3;
    // 适用商户门店（黑鲸鱼 IsShopStore：store={type:'shop', value:shopStoreId}）
    if (info.shopStoreId && String(info.shopStoreId) !== '0') {
      item.store = { type: 'shop', value: String(info.shopStoreId) };
    }
    // 代购（黑鲸鱼 SetDaigou：departurePlace + globalStock.globalStock_1 {country, stockType}）
    if (info.dgSendCity) {
      const city = String(info.dgSendCity).trim();
      item.departurePlace = { value: 1, text: '中国港澳台地区及其他国家和地区' };
      item.globalStock = {
        value: 'globalStock_1',
        globalStock_1: {
          country: { text: city, value: city },
          stockType: { text: '现货（可快速发货）', value: 4738 },
        },
      };
    }
    // 定制（黑鲸鱼 IsCustomize：1=图片传输 → customize_1 带 customizeTool；2=文字 → 仅 value）
    if (info.customItem === 1 || info.customItem === 'image') {
      item.customize = { value: 'customize_1', customize_1: { customizeTool: { text: '图片传输', value: 1 } } };
    } else if (info.customItem === 2 || info.customItem === 'text') {
      item.customize = { value: 'customize_1' };
    }
    // 鉴别服务（黑鲸鱼 IsRaise）
    if (info.appraiseService) item.appraiseService = 1;
    // 主图视频（黑鲸鱼 dual 字段：旧版 video:[{itemId,videoId,...}]；2026新版 auctionVideos:[{videoInfo,videoType}]）
    // 新版发布页 components.auctionVideos（simplyMaterialsVideos 组件）才是视频绑定入口，
    // 黑鲸鱼：auctionVideos = [{videoInfo: _imageVideo[0], videoType: '宝贝讲解'}]（IsNewVideo 检测同款）
    if (info.video && info.video.videoId) {
      const vInfo = {
        itemId: '',
        videoId: String(info.video.videoId),
        mainPicUrl: info.video.mainPicUrl || '',
        sceneCode: 'imageVideo',
        sceneName: 'imageVideo',
        width: info.video.width || 0,
        height: info.video.height || 0,
        ...(info.video.duration ? { duration: info.video.duration } : {}),
        ...(info.video.videoRadio ? { videoRadio: String(info.video.videoRadio) } : {}),
      };
      item.video = [vInfo];
      item.auctionVideos = [{ videoInfo: vInfo, videoType: '宝贝讲解' }];
    }
    // 发布页表单默认值（logisticsMode 物流模式=发货地等，API直提必须自带）
    const fd = info.formDefaults || {};
    if (fd.logisticsMode != null) item.logisticsMode = fd.logisticsMode;
    if (fd.regionLimitSale != null) item.regionLimitSale = fd.regionLimitSale;
    // 发货地 shippingArea（黑鲸鱼 LocCity 结构：{type:'1', warehouseType:'1', value:{text,value}}，value 为市级编码）
    const loc = String(info.location || '浙江省 杭州市').trim();
    const locParts = loc.split(/\s+/);
    const provName = String(locParts[0] || '').replace(/省|市|自治区|特别行政区/g, '');
    const cityName = String(locParts[1] || '').replace(/市|地区|自治州|盟/g, '');
    const provCode = PROVINCE_CODE[provName] || '330000';
    const cityCode = CITY_CODE[cityName] || '330100';
    item.shippingArea = {
      type: '1',
      warehouseType: '1',
      value: { text: cityName || '杭州', value: cityCode },
    };
    for (const cp of (info.catProps || [])) item.catProp[cp.name] = cp.value;
    if (info.brandId) item.catProp['p-20000'] = { text: info.brandName || '', value: Number(info.brandId) || info.brandId };
    // 导购标题（黑鲸鱼 TitleToShop：1=标题生成 2=自定义 DgTitle；interest 拆两段 partition 0/1）
    // 自定义模式校验 20~30 字；标题模式取标题去特殊字符前 24 字
    const gMode = Number(info.titleToShop) || 0;
    if (gMode === 1 || gMode === 2) {
      let gtxt = '';
      if (gMode === 1) {
        const raw = String(info.title || '');
        const skip = new Set(";'./*&^%$#@~()。‘’；（）@#￥%…&<《》>≤≥★".split(''));
        gtxt = raw.split('').filter(ch => !skip.has(ch) || /[0-9]/.test(ch)).join('').slice(0, 24);
        if (gtxt.length < 24) gtxt += 'abcdefghijklmnopqrstuvwsyz'.slice(0, 24 - gtxt.length);
      } else {
        gtxt = String(info.dgTitle || '').trim();
      }
      if (gtxt && gtxt.length >= 10) {
        const parts = [gtxt.slice(0, 12), gtxt.slice(12, 24)].filter(Boolean);
        item.catProp['interest'] = parts.map((p, i) => ({ name: 'interest', value: p, partition: i }));
      }
    }
    return item;
  }

  // ==================== 提交 ====================

  async submit(upItem, opts = {}) {
    const maxRetry = Number(opts.maxRetry) || 3;
    let retries = 0;
    let item = JSON.parse(JSON.stringify(upItem));

    while (retries <= maxRetry) {
      const jsonBody = JSON.stringify(item);
      // 提交也走页面上下文 fetch（黑鲸鱼 PubBrowser 模式：数据加载到 publish.htm 由页面 JS 提交）
      const html = await this._pageSubmit(item.catId, {
        icatId: item.catId, catId: item.catId, itemId: item.id || 0,
        copyItemMode: 0, jsonBody,
      });
      const jsonStart = html.indexOf('{');
      if (jsonStart >= 0) {
        let j;
        try { j = JSON.parse(html.substring(jsonStart)); }
        catch (e) { return { ok: false, error: '响应解析失败: ' + html.slice(0, 200), retries }; }

        const models = j.models || {};
        const gm = models.globalMessage || {};
        if (gm.type === 'success') {
          let itemId = '';
          const su = gm.successUrl || '';
          const m1 = su.match(/primaryId=(\d+)/) || su.match(/id=(\d+)/);
          if (m1) itemId = m1[1];
          return { ok: true, itemId, itemUrl: itemId ? `https://item.taobao.com/item.htm?id=${itemId}` : su, retries };
        }

        const errMsgs = [];
        const collect = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 5) return;
          for (const v of Object.values(obj)) {
            if (Array.isArray(v)) { v.forEach(x => { if (x && typeof x === 'object' && (x.errorMessage || x.message)) errMsgs.push(x.errorMessage || x.message); else if (typeof x === 'string') errMsgs.push(x); }); }
            else if (v && typeof v === 'object') {
              if (v.errorMessage) errMsgs.push(v.errorMessage);
              else if (v.message) errMsgs.push(typeof v.message === 'string' ? v.message : JSON.stringify(v.message).slice(0, 100));
              collect(v, depth + 1);
            }
          }
        };
        collect(models.formError || {});
        const errText = errMsgs.join('; ') || gm.message || html.slice(0, 200);

        // ---- 自动重试（黑鲸鱼策略） ----
        if (/标题.{0,10}(超|超过|长度)|title.{0,10}long/i.test(errText)) {
          const mlen = errText.match(/(\d+)\s*个字/) || errText.match(/超过(\d+)/);
          const maxLen = mlen ? parseInt(mlen[1], 10) : 30;
          if (item.title.length > maxLen) { item.title = item.title.substring(0, maxLen); retries++; continue; }
        }
        if (/SKU.{0,10}(超|长)|规格.{0,8}(超|长)/.test(errText)) {
          let trimmed = false;
          (item.sku || []).forEach(s => (s.props || []).forEach(p => { if (p.text && p.text.length > 76) { p.text = p.text.slice(0, 76); trimmed = true; } }));
          Object.values(item.saleProp || {}).forEach(arr => Array.isArray(arr) && arr.forEach(v => { if (v.text && v.text.length > 76) { v.text = v.text.slice(0, 76); trimmed = true; } }));
          if (trimmed) { retries++; continue; }
        }
        if (/SKU.{0,15}(数量|个数|超过|上限)|销售属性.{0,12}(超|多)/.test(errText)) {
          if (TaoApi._cutSkus(item)) { retries++; continue; }
        }
        if (/视频|video/i.test(errText) && (item.video || item.threeToFourImages || item.auctionVideos)) {
          item.video = null; item.threeToFourImages = null; item.threeToFourImageGroup = null;
          item.imageVideoType = null; item.auctionVideos = null;
          retries++; continue;
        }
        if (/定制/.test(errText) && !item.customizeBySku) { item.customizeBySku = 1; retries++; continue; }
        // 运费模板不支持按重量计费 → 自动去掉重量重试（模板按件计费时 deliverWeight 会触发校验失败）
        if (/不支持按重量计费|DELIVERY_TEMPLATE_NOT_SUPPORT_WEIGHT/i.test(errText) && item.deliverWeight != null) {
          delete item.deliverWeight;
          await this._sleep(2000); retries++; continue;
        }
        // 尺寸表必填 → 自动生成尺码表重试（黑鲸鱼 L109931 IsAutoSizemap=true; continue）
        if (/尺寸表为必填|商品尺寸表/.test(errText) && opts.sizeTable && !item.sizeMappingV3) {
          try {
            const sizeMap = await this.getSizeMap(item.catId);
            const smv = TaoApi.buildSizeMappingV3({ sizeMap, title: item.title, sizeTexts: opts.sizeTexts || [] });
            if (smv) { item.sizeMappingV3 = smv; await this._sleep(4000); retries++; continue; }
          } catch (_) {}
        }
        // 多件优惠组件要求 → 补 multiDiscountPromotion 重试（黑鲸鱼 L109878）
        if (/多件优惠/.test(errText) && !item.multiDiscountPromotion) {
          item.multiDiscountPromotion = { value: 9.5, type: 1, enable: true };
          await this._sleep(4000); retries++; continue;
        }
        // 能效标识图 → qualification 补图重试（黑鲸鱼 L109891：key=eng_ef_mark_image_1）
        if (/能效标识图/.test(errText) && opts.nxImg) {
          const q = Array.isArray(item.qualification) ? [...item.qualification] : [];
          if (!q.find(x => x && x.key === 'eng_ef_mark_image_1')) {
            q.push({ key: 'eng_ef_mark_image_1', image: 'image', value: opts.nxImg });
            item.qualification = q;
            await this._sleep(4000); retries++; continue;
          }
        }
        // 价格超限自动修改 SKU 价格（黑鲸鱼 chkPriceToOne L115952：正则提取限价区间 → 抬低价 SKU 重试）
        if (opts.priceToOne && /价格范围过大|价格不能低于/.test(errText)) {
          const mA = errText.match(/在([\d.]+)到/) || errText.match(/不能低于([\d.]+)/);
          const mB = errText.match(/到([\d.]+)之/);
          const lo = mA ? parseFloat(mA[1]) : 0;
          const hi = mB ? parseFloat(mB[1]) : 0;
          if (TaoApi._fixSkuPrices(item, lo, hi)) {
            await this._sleep(3000); retries++; continue;
          }
        }
        // 发货时效拦截（2026淘宝新规：部分类目不允许承诺24/48小时，要求>2天）→ 自动抬到72小时(3天)重试
        if (/CHK_RELATIVE_TIME_MIN_DAY_ERROR|发货时间必须大于/.test(errText) && Number((item.tbDeliveryTime || {}).value || 0) <= 2) {
          item.tbDeliveryTime = { text: '3', value: 3 };
          await this._sleep(2000); retries++; continue;
        }
        if (/必填|不能为空/.test(errText) && !item.__propsFilled) {
          const pd = await this.getPublishPageData(item.catId).catch(() => null);
          if (pd) {
            const cur = new Set(Object.keys(item.catProp));
            for (const p of pd.props) {
              if (p.required && p.name && !cur.has(p.name)) {
                // 输入型必填（含无候选自由文本，如型号/货号）兜底"其他"；其他类型需有候选首项
                if (p.uiType === 'input') {
                  item.catProp[p.name] = p.dataSource.length ? p.dataSource[0].text : '其他';
                } else if (p.dataSource && p.dataSource.length) {
                  item.catProp[p.name] = p.uiType === 'material'
                    ? [{ text: p.dataSource[0].text, value: p.dataSource[0].value, content: '100' }]
                    : { text: p.dataSource[0].text, value: p.dataSource[0].value };
                }
              }
            }
            item.__propsFilled = true;
            retries++; continue;
          }
        }
        return { ok: false, error: errText, retries, html: html.slice(0, 600) };
      }
      if (html.includes('login.taobao.com')) return { ok: false, error: '登录态失效', retries };
      return { ok: false, error: '未知响应: ' + html.slice(0, 200), retries };
    }
    return { ok: false, error: `重试${maxRetry}次仍失败`, retries };
  }

  /**
   * 价格超限 SKU 修正（黑鲸鱼 chkPriceToOne 功能移植，算法按淘宝规则合理化）
   * 错误提示"宝贝规格中的价格范围过大 在X到Y之间"/"价格不能低于X"：
   * 把所有 SKU 价格收敛到允许区间（低价抬到下限、高价压到上限），主价取最低 SKU 价
   * @returns 是否有修改
   */
  static _fixSkuPrices(item, lo, hi) {
    const skus = item.sku || [];
    if (!skus.length) return false;
    const floor = lo > 0 ? lo : (hi > 0 ? Math.max(0.01, hi / 10) : 1);
    const ceil = hi > 0 ? hi : (lo > 0 ? lo * 10 : 0);
    let changed = false;
    let minPrice = Infinity;
    for (const s of skus) {
      let p = parseFloat(s.skuPrice) || 0;
      if (p <= 0) p = floor;
      if (p < floor) { p = floor; changed = true; }
      if (ceil > 0 && p > ceil) { p = ceil; changed = true; }
      p = Math.max(0.01, Math.round(p * 100) / 100);
      s.skuPrice = String(p);
      if (p < minPrice) minPrice = p;
    }
    if (changed && isFinite(minPrice)) {
      const cur = parseFloat(item.price) || 0;
      if (cur !== minPrice) { item.price = String(minPrice); changed = true; }
    }
    return changed;
  }

  /**
   * 尺码表生成器（黑鲸鱼 SizeTableGenerator/SizeMapHelper 移植）
   * 从类目尺码定义（sizeMap：{shengao:'身高（cm）',...}）+ 销售属性尺码值（sizeTexts）
   * 生成 sizeMappingV3：{sizeRecommend:{sizeReferenceIpt}, sizeMapping:{sizeMappingIpt}, sizeModelTryInfo:{disabled:true}}
   */
  static buildSizeMappingV3({ sizeMap, title, sizeTexts, withRecommend = true }) {
    try {
      const map = sizeMap || {};
      const texts = (sizeTexts || []).map(t => String(t).trim()).filter(Boolean);
      if (!Object.keys(map).length || !texts.length) return null;
      const t = String(title || '');
      const isShoe = /鞋/.test(t);
      const sex = /女/.test(t) ? '女' : (/童/.test(t) && !isShoe ? '童' : '男');
      // 黑鲸鱼默认起点：身高155 体重45 胸围90（每档 +5/+5/+2）
      let h = sex === '男' ? 165 : 155, w = sex === '男' ? 55 : 45, x = sex === '男' ? 88 : 90;
      let jiao = 22.5;
      const rows = {};   // 尺码文本 → {shengao, tizhong}
      const codes = new Set();
      const sizeItemCode = (seg) => seg.split(',').filter(Boolean).map(p => p.slice(p.lastIndexOf(':'))).join('');
      let ipt = '';
      texts.forEach((text, i) => {
        let seg = '';
        if (isShoe) {
          const num = String(text).match(/(\d+(\.\d+)?)/);
          if (num) {
            let v = parseFloat(num[1]);
            if (v >= 30 && v <= 50) v = (v + 10) / 2;   // 欧码 → 脚长cm（黑鲸鱼 GetXieValue 同源近似）
            if (v >= 10 && v <= 40) jiao = v;
          }
          jiao = Math.min(Math.max(jiao, 20), 32);
          while ([...codes].some(c => c.includes(`jiaochang=${jiao}`)) && jiao < 32) jiao = Math.round((jiao + 0.5) * 10) / 10;
          seg = `${i + 1}:${text}:jiaochang=${jiao},`;
        } else {
          const fz = TaoApi._fzValue(sex, text);
          if (fz) { h = fz.shengao; w = fz.tizhong; x = fz.xiongwei; }
          const fields = Object.keys(map);
          for (const k of fields) {
            if (k === 'size') continue; // 尺寸列无需映射值（黑鲸鱼同款：只映射 shengao/tizhong/xiongwei 数值列）
            let v = 70;
            if (k === 'shengao') v = h;
            else if (k === 'tizhong') v = w;
            else if (k === 'xiongwei') v = x;
            seg += `${i + 1}:${text}:${k}=${v},`;
          }
          rows[text] = { shengao: h, tizhong: w };
          w += 5; x += 2; h += (h <= 180 ? 5 : 2);
        }
        const code = sizeItemCode(seg);
        if (codes.has(code) && !isShoe) {
          w += 1; // 黑鲸鱼去重：同码时体重+1 重新生成
          seg = seg.replace(/tizhong=\d+/, `tizhong=${w}`);
          codes.add(sizeItemCode(seg));
        } else codes.add(code);
        ipt += seg;
      });
      if (!ipt) return null;
      ipt = ipt.replace(/,$/, '');
      // sizeReferenceIpt（黑鲸鱼 SizeTableGenerator.GetSizeMapV3：身高/体重范围矩阵匹配；仅"生成推荐尺码表"开启时生成）
      let ref = null;
      if (withRecommend) {
        try { ref = TaoApi._sizeReferenceIpt(rows, texts); } catch (_) { ref = null; }
      }
      return {
        sizeRecommend: ref ? { sizeReferenceIpt: ref } : { disabled: true },
        sizeMapping: { sizeMappingIpt: ipt },
        sizeModelTryInfo: { disabled: true },
      };
    } catch (e) { return null; }
  }

  /** 服装尺码 S/M/L... → 身高/体重/胸围（黑鲸鱼 size.json 查表近似） */
  static _fzValue(sex, sku) {
    const t = String(sku).toUpperCase().trim();
    const m = t.match(/(\d{2,3})/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 120 && n <= 210) {
        // 数字码（160/165/170...）→ 身高即码、体重 BMI 近似（黑鲸鱼童装逻辑同源）
        const bmi = n >= 150 ? 19 : (n >= 130 ? 18 : 17);
        const w = Math.round(17 * Math.pow(n / 100, 2)) || Math.round(bmi * Math.pow(n / 100, 2));
        return { shengao: n, tizhong: w, xiongwei: 84 + Math.round((n - 155) * 0.8) };
      }
      if (n >= 24 && n <= 44) return null; // 牛仔裤码（26/28/30）无身高对应 → 用递增默认
    }
    const tb = {
      女: { XS: [150, 40, 80], S: [155, 45, 84], M: [160, 50, 88], L: [165, 55, 92], XL: [170, 60, 96], XXL: [175, 65, 100], '2XL': [175, 65, 100], '3XL': [180, 70, 104], 'XXXL': [180, 70, 104], '4XL': [185, 75, 108], 'XXXXL': [185, 75, 108] },
      男: { XS: [160, 50, 84], S: [165, 55, 88], M: [170, 60, 92], L: [175, 65, 96], XL: [180, 70, 100], XXL: [185, 75, 104], '2XL': [185, 75, 104], '3XL': [190, 80, 108], 'XXXL': [190, 80, 108] },
      童: { XS: [100, 20, 60], S: [110, 24, 64], M: [120, 28, 68], L: [130, 32, 72], XL: [140, 36, 76], XXL: [150, 42, 80], '2XL': [150, 42, 80] },
    }[sex] || {};
    const row = tb[t] || (/^X+S$/.test(t) ? tb.XS : null) || (/^X+L$/.test(t) ? (tb.XXL || tb['3XL'] || tb.XL) : null);
    return row ? { shengao: row[0], tizhong: row[1], xiongwei: row[2] } : null;
  }

  /** 身高/体重范围矩阵（黑鲸鱼 heightRanges 50-190 步长10 / weightRanges 5-120 步长5）→ SizeRoot */
  static _sizeReferenceIpt(rows, sizeTexts) {
    const defs = Object.entries(rows).map(([label, r]) => ({
      label, hm: r.shengao - 5, hx: r.shengao, wm: r.tizhong - 5, wx: r.tizhong, priority: 1,
    }));
    // 排序保证矩阵中点匹配确定性
    defs.sort((a, b) => a.priority - b.priority || a.hx - b.hx);
    const match = (hc, wc) => {
      for (const d of defs) {
        if (hc >= d.hm && hc <= d.hx && wc >= d.wm && wc <= d.wx) return d.label;
      }
      return null;
    };
    const hr = [], wr = [];
    for (let v = 50; v < 190; v += 10) hr.push({ min: String(v), max: String(v + 10) });
    for (let v = 5; v < 120; v += 5) wr.push({ min: String(v), max: String(v + 5) });
    const values = [];
    const rowKeys = new Set(), colKeys = new Set();
    for (const h of hr) for (const w of wr) {
      const hc = (Number(h.min) + Number(h.max)) / 2;
      const wc = (Number(w.min) + Number(w.max)) / 2;
      const label = match(hc, wc);
      if (label) {
        values.push({ axis: [{ min: h.min, max: h.max, key: 'shengao' }, { min: w.min, max: w.max, key: 'tizhong' }], value: label });
        rowKeys.add(h.min + '_' + h.max);
        colKeys.add(w.min + '_' + w.max);
      }
    }
    if (!values.length) return null;
    return {
      row: { key: 'shengao', name: '身高', unit: 'cm', ranges: hr.filter(r => rowKeys.has(r.min + '_' + r.max)) },
      col: { key: 'tizhong', name: '体重', unit: '公斤', ranges: wr.filter(r => colKeys.has(r.min + '_' + r.max)) },
      value: values,
    };
  }

  /** 提交：工作窗口页面内 fetch POST submit.htm */
  async _pageSubmit(catId, formData) {
    const win = this.win;
    if (!win) throw new Error('TaoApi 需要 win');
    await win.loadURL(`https://item.upload.taobao.com/sell/v2/publish.htm?catId=${catId}`);
    for (let i = 0; i < 15; i++) {
      const ready = await win.webContents.executeJavaScript(`!!(window.csrfToken || window.Json)`, false).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      try {
        const fd = new URLSearchParams();
        const data = ${JSON.stringify(formData)};
        for (const [k, v] of Object.entries(data)) fd.append(k, String(v));
        const token = (window.csrfToken && window.csrfToken.tokenValue) || '';
        const r = await fetch('https://item.upload.taobao.com/sell/v2/submit.htm', {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            ...(token ? { 'X-XSRF-TOKEN': token } : {}),
          },
          body: fd.toString(),
          credentials: 'include',
        });
        return await r.text();
      } catch (e) { return 'ERR: ' + e.message; }
    })()`, false);
    return result || '';
  }

  static _cutSkus(item) {
    try {
      const keys = Object.keys(item.saleProp || {});
      if (!keys.length) return false;
      let minKey = null, minLen = 999;
      for (const k of keys) {
        const arr = item.saleProp[k];
        if (Array.isArray(arr) && arr.length > 1 && arr.length < minLen) { minLen = arr.length; minKey = k; }
      }
      if (!minKey) return false;
      const removed = item.saleProp[minKey].shift();
      if (!removed) return false;
      item.sku = (item.sku || []).filter(s => !(s.props || []).some(p => p.value === removed.value));
      if (item.sku.length) {
        const total = item.sku.reduce((a, s) => a + (parseInt(s.skuStock, 10) || 0), 0);
        item.quantity = String(total || item.quantity);
      }
      return true;
    } catch (_) { return false; }
  }
}

module.exports = { TaoApi };