/**
 * 阿里巴巴采集引擎 —— 黑鲸鱼 alibabasource.exe 完整移植
 *
 * 对应黑鲸鱼 5 大采集窗体：
 *   1. 一键代发     → daixiaoList()      s.1688.com/daixiao/offer_search.htm（解析 window.data.offerresultData）
 *   2. 低价货源     → daixiaoList(priceSort) 同上 + 价格排序/区间过滤
 *   3. 关键词选品   → premiumList()      data.p4psearch.1688.com get_premium_offer_list.json（P4P 优质货源）
 *   4. 全店采集     → shopCate()/shopItems()  mtop.alibaba.alisite.cbu.server.ModuleAsyncService（结构化数据）
 *   5. 工厂店/跨境  → factoryTabs()/factoryItems()  mtop.mbox.fc.common.gateway
 *
 * 请求方式（与黑鲸鱼 HttpItem 直连同源数据，但走浏览器上下文更抗风控）：
 *   - 列表页：导航窗口 → 页面全局数据解析（黑鲸鱼 HtmlAgilityPack 同款字段）
 *   - mtop 接口：页面内 JSONP script 注入（自动携带 1688 登录态 cookie，无 CORS）
 *     签名 sign = MD5(token + "&" + t + "&12574478&" + data)，token 取 cookie _m_h5_tk（黑鲸鱼 TbH5Sign 同款）
 */
const DOM = require('./dom');
const { net } = require('electron');
const crypto = require('crypto');

const APP_KEY = '12574478';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 精简 MD5（页面内注入用，与 Java/C# 标准实现一致） */
const MD5_JS = `
function __md5(str){
  function rl(n,c){return (n<<c)|(n>>>(32-c));}
  function au(x,y){var l=(x&0xFFFF)+(y&0xFFFF),m=(x>>16)+(y>>16)+(l>>16);return (m<<16)|(l&0xFFFF);}
  function cmn(q,a,b,x,s,t){return au(rl(au(au(a,q),au(x,t)),s),b);}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
  function cvh(x,len){x[len>>5]|=0x80<<(len%32);x[(((len+64)>>>9)<<4)+14]=len;return x;}
  function st2bl(str){var uni=false;try{escape(str.charCodeAt(0))*0x10000<0x10000&&(uni=true);}catch(e){}
    for(var i=0;i<str.length;i++){if(str.charCodeAt(i)>255)uni=true;}
    if(!uni)return unescape(encodeURIComponent(str));
    var out='';for(var j=0;j<str.length;j++){var c=str.charCodeAt(j);
      if(c<128)out+=String.fromCharCode(c);
      else if(c>127&&c<2048){out+=String.fromCharCode((c>>6)|192);out+=String.fromCharCode((c&63)|128);}
      else{out+=String.fromCharCode((c>>12)|224);out+=String.fromCharCode(((c>>6)&63)|128);out+=String.fromCharCode((c&63)|128);}}
    return out;}
  function bl2st(bin){var out='',hex='0123456789abcdef';
    for(var i=0;i<bin.length*4;i++){out+=hex.charAt((bin[i>>2]>>((i%4)*8+4))&0xF)+hex.charAt((bin[i>>2]>>((i%4)*8))&0xF);}
    return out;}
  var x=cvh(Array(str.length>>2),str.length*8),k=1732584193,l=-271733879,i1=-1732584194,i2=271733878,i3=-1009589776;
  for(var i=0;i<x.length;i++)x[i]=0;
  for(i=0;i<str.length*8;i+=8)x[i>>5]|=(st2bl(str).charCodeAt(i/8)&0xFF)<<(i%32);
  x=cvh(x,str.length*8);
  for(i=0;i<x.length;i+=16){var ok=k,ol=l,oi1=i1,oi2=i2,oi3=i3;
    k=ff(k,l,i1,i2,x[i+0],7,-680876936);i2=ff(i2,k,l,i1,x[i+1],12,-389564586);i1=ff(i1,i2,k,l,x[i+2],17,606105819);l=ff(l,i1,i2,k,x[i+3],22,-1044525330);
    k=ff(k,l,i1,i2,x[i+4],7,-176418897);i2=ff(i2,k,l,i1,x[i+5],12,1200080426);i1=ff(i1,i2,k,l,x[i+6],17,-1473231341);l=ff(l,i1,i2,k,x[i+7],22,-45705983);
    k=ff(k,l,i1,i2,x[i+8],7,1770035416);i2=ff(i2,k,l,i1,x[i+9],12,-1958414417);i1=ff(i1,i2,k,l,x[i+10],17,-42063);l=ff(l,i1,i2,k,x[i+11],22,-1990404162);
    k=ff(k,l,i1,i2,x[i+12],7,1804603682);i2=ff(i2,k,l,i1,x[i+13],12,-40341101);i1=ff(i1,i2,k,l,x[i+14],17,-1502002290);l=ff(l,i1,i2,k,x[i+15],22,1236535329);
    k=gg(k,l,i1,i2,x[i+1],5,-165796510);i2=gg(i2,k,l,i1,x[i+6],9,-1069501632);i1=gg(i1,i2,k,l,x[i+11],14,643717713);l=gg(l,i1,i2,k,x[i+0],20,-373897302);
    k=gg(k,l,i1,i2,x[i+5],5,-701558691);i2=gg(i2,k,l,i1,x[i+10],9,38016083);i1=gg(i1,i2,k,l,x[i+15],14,-660478335);l=gg(l,i1,i2,k,x[i+4],20,-405537848);
    k=gg(k,l,i1,i2,x[i+9],5,568446438);i2=gg(i2,k,l,i1,x[i+14],9,-1019803690);i1=gg(i1,i2,k,l,x[i+3],14,-187363961);l=gg(l,i1,i2,k,x[i+8],20,1163531501);
    k=gg(k,l,i1,i2,x[i+13],5,-1444681467);i2=gg(i2,k,l,i1,x[i+2],9,-51403784);i1=gg(i1,i2,k,l,x[i+7],14,1735328473);l=gg(l,i1,i2,k,x[i+12],20,-1926607734);
    k=hh(k,l,i1,i2,x[i+5],4,-378558);i2=hh(i2,k,l,i1,x[i+8],11,-2022574463);i1=hh(i1,i2,k,l,x[i+11],16,1839030562);l=hh(l,i1,i2,k,x[i+14],23,-35309556);
    k=hh(k,l,i1,i2,x[i+1],4,-1530992060);i2=hh(i2,k,l,i1,x[i+4],11,1272893353);i1=hh(i1,i2,k,l,x[i+7],16,-155497632);l=hh(l,i1,i2,k,x[i+10],23,-1094730640);
    k=hh(k,l,i1,i2,x[i+13],4,681279174);i2=hh(i2,k,l,i1,x[i+0],11,-358537222);i1=hh(i1,i2,k,l,x[i+3],16,-722521979);l=hh(l,i1,i2,k,x[i+6],23,76029189);
    k=hh(k,l,i1,i2,x[i+9],4,-640364487);i2=hh(i2,k,l,i1,x[i+12],11,-421815835);i1=hh(i1,i2,k,l,x[i+15],16,530742520);l=hh(l,i1,i2,k,x[i+2],23,-995338651);
    k=ii(k,l,i1,i2,x[i+0],6,-198630844);i2=ii(i2,k,l,i1,x[i+7],10,1126891415);i1=ii(i1,i2,k,l,x[i+14],15,-1416354905);l=ii(l,i1,i2,k,x[i+5],21,-57434055);
    k=ii(k,l,i1,i2,x[i+12],6,1700485571);i2=ii(i2,k,l,i1,x[i+3],10,-1894986606);i1=ii(i1,i2,k,l,x[i+10],15,-1051523);l=ii(l,i1,i2,k,x[i+1],21,-2054922799);
    k=ii(k,l,i1,i2,x[i+8],6,1873313359);i2=ii(i2,k,l,i1,x[i+15],10,-30611744);i1=ii(i1,i2,k,l,x[i+6],15,-1560198380);l=ii(l,i1,i2,k,x[i+13],21,1309151649);
    k=ii(k,l,i1,i2,x[i+4],6,-145523070);i2=ii(i2,k,l,i1,x[i+11],10,-1120210379);i1=ii(i1,i2,k,l,x[i+2],15,718787259);l=ii(l,i1,i2,k,x[i+9],21,-343485551);
    k=au(k,ok);l=au(l,ol);i1=au(i1,oi1);i2=au(i2,oi2);}
  return bl2st([k,l,i1,i2]);
}
`;

class AlibabaCollector {
  /**
   * @param {object} opts
   * @param {import('./collector')} opts.collector 现有 1688 采集器（复用会话/导航/滑块基础设施）
   * @param {object} opts.logger
   */
  constructor({ collector, logger }) {
    this.collector = collector;
    this.logger = logger;
  }

  _prog(p) { try { this.collector._prog(p); } catch (_) {} }

  /** 借用现有 collector 的采集会话（账号轮换/滑块处理/游客模式全复用） */
  async _session() { return this.collector._session(); }

  /* ==================== 直连 HTTP（黑鲸鱼 HttpItem/HttpStl 同款：cookie 直带，无浏览器窗口） ==================== */

  /** HTTP GET（会话 cookie 自动携带，gzip 自动解压） */
  _httpGet(session, url, headers = {}) {
    return new Promise((resolve, reject) => {
      const opts = { url, method: 'GET', useSessionCookies: true, redirect: 'follow' };
      if (session) opts.session = session;
      const req = net.request(opts);
      req.setHeader('User-Agent', UA);
      req.setHeader('Accept', '*/*');
      req.setHeader('Referer', headers.Referer || 'https://sale.1688.com/');
      req.setHeader('sec-ch-ua', '"Google Chrome"; v="89", "Chromium"; v="89", ";Not A Brand"; v = "99"');
      req.setHeader('sec-fetch-dest', 'script');
      req.setHeader('sec-fetch-mode', 'no-cors');
      req.setHeader('sec-fetch-site', 'same-origin');
      const timer = setTimeout(() => { req.abort(); reject(new Error('请求超时')); }, 20000);
      const chunks = [];
      req.on('response', (res) => {
        res.on('data', c => chunks.push(c));
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  /** 读会话 _m_h5_tk token（mtop 签名用，黑鲸鱼 GlobalData.TaobaoCookie 提取同款） */
  async _h5Token(session) {
    try {
      const cs = await session.cookies.get({ url: 'https://h5api.m.1688.com/' });
      const tk = (cs.find(c => c.name === '_m_h5_tk') || {}).value || '';
      return tk ? tk.split('_')[0] : 'undefined';
    } catch (_) { return 'undefined'; }
  }

  /**
   * 直连 1688 mtop 接口（黑鲸鱼 GetAlishopItemsList 同款：POST data= + Referer=店铺URL + jsv=2.7.0）
   * 首次调用 token 无效时服务端会种新 _m_h5_tk（useSessionCookies 自动入库），自动重试
   * @returns 接口 data 字段
   */
  async _mtopHttp(session, api, v, dataObj, referer) {
    const dataStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
    const apiPath = String(api).toLowerCase(); // 黑鲸鱼：URL 路径小写，api 参数原样
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = Date.now().toString();
      const token = await this._h5Token(session);
      const sign = crypto.createHash('md5').update(`${token}&${t}&${APP_KEY}&${dataStr}`, 'utf8').digest('hex');
      const url = `https://h5api.m.1688.com/h5/${apiPath}/${v}/?jsv=2.7.0&appKey=${APP_KEY}&t=${t}&sign=${sign}&api=${api}&v=${v}&type=json&valueType=string&dataType=jsonp&timeout=10000`;
      const r = await this._httpPost(session, url, 'data=' + encodeURIComponent(dataStr), referer || 'https://sale.1688.com/');
      let txt = String(r.body || '');
      if (txt.indexOf('{') > 0) txt = txt.slice(txt.indexOf('{'));
      let j = null;
      try { j = JSON.parse(txt); } catch (_) {}
      if (!j) throw new Error('mtop 响应解析失败: ' + String(r.body || '').slice(0, 80));
      const ret = (j.ret && j.ret[0]) || '';
      if (/SUCCESS/.test(ret)) return j.data;
      if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(ret)) {
        await DOM.sleep(300 + attempt * 400);
        continue;
      }
      const err = new Error('mtop: ' + ret);
      err.code = ret;
      // 1688风控拦截（RGV587/滑块）：响应 data.url 通常是 punish 验证页地址
      if (/FAIL_SYS_USER_VALIDATE|RGV587|USER_VALIDATE|被挤爆/i.test(ret)) {
        err.risk = true;
        err.url = (j.data && j.data.url) || '';
      }
      throw err;
    }
    throw new Error('mtop token 校验失败（重试3次）');
  }

  /** HTTP POST（黑鲸鱼 HttpItem POST 同款：form body + cookie 直带） */
  _httpPost(session, url, body, referer) {
    return new Promise((resolve, reject) => {
      const opts = { url, method: 'POST', useSessionCookies: true, redirect: 'follow' };
      if (session) opts.session = session;
      const req = net.request(opts);
      req.setHeader('User-Agent', UA);
      req.setHeader('Accept', 'application/json');
      req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      req.setHeader('Referer', referer);
      const timer = setTimeout(() => { req.abort(); reject(new Error('请求超时')); }, 20000);
      const chunks = [];
      req.on('response', (res) => {
        res.on('data', c => chunks.push(c));
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 在 1688 页面上下文内调 mtop 接口（JSONP script 注入，自动带 cookie）
   * 返回接口 data 字段（黑鲸鱼 AliItemApi 各方法同款数据）
   * @param {BrowserWindow} win 已导航到任意 *.1688.com 页面的窗口
   * @param {string} api 如 mtop.alibaba.alisite.cbu.server.ModuleAsyncService
   * @param {string} v 版本如 1.0 / 2.0
   * @param {object} dataObj 请求数据（会被 JSON 序列化）
   */
  async _mtop(win, api, v, dataObj) {
    const dataStr = JSON.stringify(dataObj);
    const code = `
      ${MD5_JS}
      const t = Date.now().toString();
      let token = 'undefined';
      const m = document.cookie.match(/_m_h5_tk=([^_]+)_/);
      if (m) token = m[1];
      const dataStr = ${JSON.stringify(dataStr)};
      const sign = __md5(token + '&' + t + '&${APP_KEY}&' + dataStr);
      const cbName = '__mtopcb' + Date.now() + Math.floor(Math.random() * 1000);
      const url = 'https://h5api.m.1688.com/h5/' + '${api}' + '/' + '${v}' + '/?jsv=2.7.2&appKey=${APP_KEY}&t=' + t +
        '&sign=' + sign + '&api=' + '${api}' + '&v=' + '${v}' + '&type=jsonp&isSec=0&timeout=10000&dataType=jsonp&callback=' + cbName +
        '&data=' + encodeURIComponent(dataStr);
      const p = new Promise((resolve, reject) => {
        window[cbName] = (res) => { try { delete window[cbName]; } catch(e) {} resolve(res); };
        setTimeout(() => { if (window[cbName]) { try { delete window[cbName]; } catch(e) {} reject(new Error('mtop 超时')); } }, 15000);
      });
      const s = document.createElement('script');
      s.src = url;
      s.onerror = () => { try { delete window[cbName]; } catch(e) {} };
      document.head.appendChild(s);
      const res = await p;
      if (!res) throw new Error('mtop 无响应');
      if (res.ret && res.ret[0] && String(res.ret[0]).indexOf('SUCCESS') === -1) {
        const ret0 = String(res.ret[0]);
        // 风控拦截：返回信封（executeJavaScript 会丢 Error 自定义属性），由 Node 侧转成带 url 的错误
        if (/FAIL_SYS_USER_VALIDATE|RGV587|USER_VALIDATE|被挤爆/.test(ret0)) {
          return { __mtopRisk: true, ret: res.ret.join(','), url: (res.data && res.data.url) || '' };
        }
        const e = new Error('mtop: ' + res.ret.join(','));
        e.code = ret0;
        throw e;
      }
      return res.data;
    `;
    const out = await DOM.evalInPage(win.webContents, code);
    if (out && out.__mtopRisk) {
      const err = new Error('mtop: ' + out.ret);
      err.code = out.ret;
      err.risk = true;
      err.url = out.url || '';
      throw err;
    }
    return out;
  }

  /** 确保 win 停留在 1688 域下（mtop jsonp 需要同主域 cookie），不在则导航一次 */
  async _ensureAliDomain(win, isGuest) {
    const url = win.webContents.getURL() || '';
    if (/\.1688\.com/.test(url)) return;
    await this.collector._navTo(win, 'https://www.1688.com/', { isGuest });
  }

  /* ==================== mtop 风控（FAIL_SYS_USER_VALIDATE/RGV587）处理 ==================== */

  /** 判断错误是否为 1688 风控拦截（滑块/挤爆/punish） */
  _isRiskControl(e) {
    return !!(e && /FAIL_SYS_USER_VALIDATE|RGV587|USER_VALIDATE|被挤爆|punish/i.test(String(e.code || '') + ' ' + String(e.message || '')));
  }

  /**
   * mtop 请求风控包装：触发风控时弹采集窗口过滑块（先自动后人工），通过后重试一次
   * 不做验证码破解/绕过——自动滑是真实事件模拟，失败后完全交由用户手动完成
   * @param {Function} fn 无参请求函数，返回 data
   * @param {object} ctx 会话上下文 { win?, session?, isGuest?, referer? }（会被补全复用）
   * @param {string} label 日志/进度标识
   */
  async _mtopWithVerify(fn, ctx = {}, label = 'mtop') {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (!this._isRiskControl(e) || round === 1) throw e;
        this.logger.warn('ali-collect', `${label} 触发1688风控验证（${String(e.message || e.code || '').slice(0, 60)}），开始处理滑块…`);
        await this._passMtopVerify(ctx, e, label);
      }
    }
    throw lastErr;
  }

  /** 弹出采集窗口处理风控滑块（复用 collector._guardPunish：自动滑→失败弹人工等待5分钟） */
  async _passMtopVerify(ctx, err, label) {
    if (ctx.isGuest !== false) {
      // _session 可能还没跑过，先取一次确认身份；游客无登录态过不了验证
      if (!ctx.win) {
        const s = await this._session();
        ctx.win = s.win; ctx.isGuest = s.isGuest; ctx.session = s.win.webContents.session;
      }
      if (ctx.isGuest) {
        throw new Error('1688要求滑块验证，请先在「采集账号管理」添加采集账号并扫码登录');
      }
    }
    const win = ctx.win;
    this._prog({ key: 'mtop-verify', title: `1688风控验证（${label}）`, detail: '触发滑块验证，自动拖动中；自动失败会弹出窗口请您手动完成…', percent: 0 });
    try { win.show(); win.focus(); win.webContents.focus(); } catch (_) {}
    win.setTitle('【需要人工】1688 风控验证 - 请完成滑块验证（完成后自动继续采集）');
    const target = err.url || ctx.referer || 'https://www.1688.com/';
    await this.collector._navTo(win, target, { isGuest: ctx.isGuest });
    const passed = await this.collector._guardPunish(win, ctx.isGuest);
    if (passed === false) {
      // 验证已过但页面未跳转：回 1688 域刷新会话 cookie
      this.logger.warn('ali-collect', '风控验证已通过但页面未跳转，重新加载1688刷新会话');
      await DOM.sleep(1500);
      await this.collector._navTo(win, 'https://www.1688.com/', { isGuest: ctx.isGuest });
    }
    await DOM.sleep(1500);
    this._prog({ key: 'mtop-verify', title: `1688风控验证（${label}）`, detail: '验证通过，重试请求…', percent: 100, done: true });
    this.logger.success('ali-collect', `${label} 风控验证通过，重试请求`);
  }

  /* ================================================================
   * 渠道1+2：一键代发 / 低价货源（Form一键代发 + Form低价货源）
   * 黑鲸鱼 RequestPagePartial：s.1688.com/daixiao/offer_search.htm
   * 数据源 window.data.offerresultData → data.offerList[]
   * 字段：id / information.simpleSubject / aliTalk.loginId /
   *       image.imgUrlOf100x100 / tradeQuantity.quantitySumMonth /
   *       tradePrice.offerPrice.priceInfo.priceUnderLine
   * ================================================================ */
  async daixiaoList({ keyword, pages = 3, sortType = '', priceMin, priceMax }) {
    const { acc, win, isGuest } = await this._session();
    const ccfg = this.collector.store.settings.collect || {};
    if (ccfg.maxPages) pages = Math.min(pages, ccfg.maxPages);
    // 关键词按 GBK 编码（1688 搜索页约定，与现有 collectByKeyword 一致）
    const iconv = require('iconv-lite');
    const gbk = (s) => {
      const buf = iconv.encode(String(s), 'gbk');
      let out = '';
      for (const x of buf) out += '%' + x.toString(16).padStart(2, '0').toUpperCase();
      return out;
    };
    const sortMap = {
      sale: 'tradenumdown',     // 销量优先（黑鲸鱼 va_rmdarkgmv30 → tradenumdown）
      priceDown: 'pricedown',   // 价格从高到低
      priceUp: 'priceup',       // 价格从低到高（低价货源用）
    };
    const sort = sortMap[sortType] || '';
    const base = 'https://s.1688.com/daixiao/offer_search.htm?keywords=' + gbk(keyword) + (sort ? '&sortType=' + sort : '');
    this.logger.info('ali-collect', `一键代发采集: ${keyword} (最多${pages}页, 排序=${sort || '默认'})`, { account: acc.name });

    const all = new Map();
    let noNew = 0;
    for (let page = 1; page <= pages; page++) {
      this._prog({ key: 'ali-daixiao', title: `一键代发「${keyword.slice(0, 8)}」`, detail: `第 ${page}/${pages} 页，已获取 ${all.size} 条…`, percent: Math.round(((page - 1) / pages) * 100) });
      // 2026新版 SPA（air.1688.com）翻页靠页内"下一页"；老版页面用 beginPage URL 参数
      const pageUrl = base + '&beginPage=' + page;
      let newCount = 0;
      // 空结果重试（复用采集配置）
      const retries = (ccfg.retryEmpty === false || isGuest) ? 0 : Math.max(0, ccfg.retryTimes || 2);
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (page === 1 || attempt > 0) {
          const navOk = await this.collector._navTo(win, pageUrl, { isGuest });
          if (navOk === false) break;
        } else if (page > 1) {
          // 翻页：优先点击"下一页"（SPA），失败退回 URL 参数导航
          const turned = await this.collector._nextPage(win, page, isGuest);
          if (!turned) {
            this.logger.info('ali-collect', 'SPA页内无下一页，尝试URL参数翻页');
            await this.collector._navTo(win, pageUrl, { isGuest });
          }
        }
        await this.collector._scrollForLazy(win, 6);
        await DOM.sleep(1500);
        let batch = await this._parseDaixiaoPage(win);
        if ((!batch || !batch.length) && attempt < retries) {
          // 空结果含两种情况：真没搜到 / 解析到推荐榜单被兜底作废（页面可能被重定向或结果区未加载）
          this.logger.warn('ali-collect', `第${page}页空结果（当前URL: ${(() => { try { return String(win.webContents.getURL()).slice(0, 90); } catch (_) { return '?'; } })()}），重试 ${attempt + 1}/${retries}…`);
          await DOM.sleep(6000 + Math.random() * 4000);
          continue;
        }
        for (const it of (batch || [])) {
          if (it.offerId && !all.has(it.offerId)) { all.set(it.offerId, it); newCount++; }
        }
        break;
      }
      this._prog({ key: 'ali-daixiao', title: `一键代发「${keyword.slice(0, 8)}」`, detail: `第 ${page}/${pages} 页 ✓ 新增${newCount}条，累计 ${all.size} 条`, percent: Math.round((page / pages) * 100) });
      if (newCount === 0) { noNew++; if (noNew >= 2) break; } else noNew = 0;
      await DOM.sleep(...(this.collector.store.settings.collect.pageDelay || [1500, 3500]));
    }

    let items = [...all.values()];
    if (priceMin != null && priceMin !== '') items = items.filter(x => x.price == null || x.price >= +priceMin);
    if (priceMax != null && priceMax !== '') items = items.filter(x => x.price == null || x.price <= +priceMax);
    if (items.length && !isGuest && this.collector.accounts.markSticky) {
      try { this.collector.accounts.markSticky(acc.id); } catch (_) {}
    }
    this.logger.success('ali-collect', `一键代发采集完成: ${items.length} 个`);
    return { ok: true, items, account: acc.name, message: `一键代发采集到 ${items.length} 个宝贝` };
  }

  /** 解析一键代发搜索页（黑鲸鱼 RequestPagePartial 同款字段；2026新版 air.1688.com SPA 用 DOM 卡片解析） */
  async _parseDaixiaoPage(win) {
    return DOM.evalInPage(win.webContents, `
      const out = [];
      const seen = new Set();
      // 旧版通道：window.data.offerresultData（黑鲸鱼时代数据源，老页面结构）
      try {
        let raw = null;
        if (window.data && window.data.offerresultData) raw = window.data.offerresultData;
        if (!raw) {
          const html = document.documentElement.innerHTML;
          const m = html.match(/window\\.data\\.offerresultData\\s*=\\s*([\\s\\S]+?)\\};/);
          if (m) { try { raw = JSON.parse(m[1] + '}'); } catch (e) {} }
        }
        if (raw && raw.data && Array.isArray(raw.data.offerList)) {
          for (const o of raw.data.offerList) {
            const g = (obj, path) => { let c = obj; for (const k of path.split('.')) { if (c == null) return undefined; c = c[k]; } return c; };
            const id = String(g(o, 'id') || g(o, 'offerId') || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({
              offerId: id,
              title: String(g(o, 'information.simpleSubject') || '').slice(0, 60),
              company: String(g(o, 'aliTalk.loginId') || g(o, 'companyName') || ''),
              image: String(g(o, 'image.imgUrlOf100x100') || g(o, 'image.imgUrl') || ''),
              price: parseFloat(String(g(o, 'tradePrice.offerPrice.priceInfo.priceUnderLine') || '')) || null,
              monthSales: String(g(o, 'tradeQuantity.quantitySumMonth') || ''),
              isFenxiao: true,
              url: 'https://detail.1688.com/offer/' + id + '.html',
              source: 'daixiao',
            });
          }
        }
      } catch (e) {}
      // 2026新版 air.1688.com SPA：卡片是 <a href="detail.1688.com/offer/{id}.html?fxcv=2&sk=consign">
      // 卡片定位：从链接逐层向上找最近的"像商品卡片"的容器（含价格、文本量适中），
      // 防止 closest 命中整页大容器导致 N 条结果全是同一个推荐商品的文本（横幅/榜单散落链接误采）
      if (!out.length) {
        const isCardText = (t) => !!t && t.length < 600 && /[￥¥]/.test(t);
        document.querySelectorAll('a[href*="detail.1688.com/offer/"]').forEach(a => {
          const m = (a.href || '').match(/offer\\/(\\d{6,})\\.html/);
          if (!m || seen.has(m[1])) return;
          let card = a, text = a.innerText || '';
          for (let i = 0; i < 5 && card; i++) {
            const t = card.innerText || '';
            if (isCardText(t)) { text = t; break; }
            const p = card.parentElement;
            if (!p) break;
            card = p;
            text = p.innerText || '';
          }
          if (!isCardText(text)) return;   // 无价格的链接（导航/推荐位/横幅）不算商品卡片
          seen.add(m[1]);
          const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
          // 标题：第一行长度>=8 且不是按钮词的行
          let title = '';
          for (const ln of lines) {
            if (ln.length >= 8 && !/^(找相似|找同款|立即铺货|代发商家榜)$/.test(ln) && !/^\\d+年$/.test(ln)) { title = ln; break; }
          }
          if (!title) return;
          // 价格：￥xx.xx（取最小值）
          let price = null;
          const prices = [...text.matchAll(/[￥¥]\\s*([0-9]+(?:\\.[0-9]+)?)/g)].map(x => parseFloat(x[1])).filter(x => isFinite(x) && x > 0);
          if (prices.length) price = Math.min(...prices);
          // 月代发量：月代发3w+ / 月代发3000+
          const dm = text.match(/月代发\\s*([0-9.]+\\s*[wW万]?\\+?)/);
          // 公司名
          const cm = text.match(/([\\u4e00-\\u9fa5A-Za-z0-9]+(?:有限公司|贸易有限公司|实业公司|科技|厂|商行|工作室))/);
          // 图片：卡片内第一张真实商品图
          const img = card.querySelector ? card.querySelector('img') : null;
          let imgSrc = img ? (img.getAttribute('data-src') || img.currentSrc || img.src || '') : '';
          if (imgSrc && imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
          out.push({
            offerId: m[1],
            title: title.slice(0, 60),
            company: cm ? cm[1] : '',
            image: /alicdn\\.com/.test(imgSrc) ? imgSrc : '',
            price,
            monthSales: dm ? dm[1] : null,
            isFenxiao: true, // daixiao 渠道即一件代发货源
            url: 'https://detail.1688.com/offer/' + m[1] + '.html',
            source: 'daixiao-spa',
          });
        });
        // 相关性兜底：同标题占比过高=推荐榜单误采（非真实搜索结果），整体作废交由上层按空结果重试
        if (out.length >= 4) {
          const cnt = {}; let maxSame = 0;
          out.forEach(o => { cnt[o.title] = (cnt[o.title] || 0) + 1; if (cnt[o.title] > maxSame) maxSame = cnt[o.title]; });
          if (maxSame >= Math.max(3, Math.floor(out.length / 2))) { out.length = 0; }
        }
      }
      return out;
    `);
  }

  /* ================================================================
   * 渠道3：优质货源（黑鲸鱼 Form关键词选品 GetDataListSearch1688）
   * 注意：原 P4P 接口（data.p4psearch.1688.com get_premium_offer_list.json）
   * 2026 年实测已停服（返回空 data），现代等价渠道 = 1688严选筛选（f10=y）
   * 的 selloffer 搜索，复用现有采集引擎（点击捕获+网络捕获+DOM 三通道）。
   * ================================================================ */
  async premiumList({ keyword, pages = 3 }) {
    this.logger.info('ali-collect', `优质货源采集（1688严选）: ${keyword} (最多${pages}页)`);
    const r = await this.collector.collectByKeyword({
      keyword,
      pages,
      onlyYanxuan: true,   // 1688严选（黑鲸鱼"优质货源"的现代等价筛选）
      onlyFenxiao: false,  // 严选渠道不强制一件代发
    });
    const items = (r.items || []).filter(it => it.offerId && it.title && it.title.length >= 6 && !/点此可以|联系卖家|和卖家交流/.test(it.title))
      .map(it => ({ ...it, source: 'premium' }));
    this.logger.success('ali-collect', `优质货源采集完成: ${items.length} 个`);
    return { ok: true, items, account: r.account, message: `优质货源（严选）采集到 ${items.length} 个宝贝` };
  }

  /* ================================================================
   * 渠道4：全店采集 mtop 结构化（Form全店采集 GetAliShopCate/GetAlishopItemsList）
   * 接口：mtop.alibaba.alisite.cbu.server.ModuleAsyncService
   *   分类：componentKey=wpProductsCategory params={"memberId":"xx"}
   *   列表：componentKey=Wp_pc_common_offerlist params={"memberId":"xx","appdata":{...}}
   * ================================================================ */
  /** 从店铺页提取 memberId（黑鲸鱼方法：直连 HTTP 拉页面源码正则提取；兜底隐藏窗口导航，无弹窗） */
  async getShopMemberId(shopUrl) {
    const { acc, win, isGuest } = await this._session();
    const session = win.webContents.session;
    // 黑鲸鱼 mButton2_Click 同款：一律取域名根 + /page/offerlist.htm（老版旺铺首页无 memberId，必须进商品列表页）
    let target = shopUrl;
    const domainRoot = String(shopUrl).match(/^(https?:\/\/[^\/]+)/);
    if (domainRoot) target = domainRoot[1] + '/page/offerlist.htm';
    // 主通道：直连 HTTP（无窗口，黑鲸鱼 HttpStl.GetHtml 同款）
    try {
      const r = await this._httpGet(session, target, { Referer: 'https://www.1688.com/' });
      const body = String(r.body || '');
      const m = body.match(/"memberId"\s*:\s*"(b2b-)?[\w]{5,40}"/) || body.match(/globalData[\s\S]{0,400}?"memberId"\s*:\s*"(\w{5,40})"/);
      if (m) {
        const id = (m[1] && !m[0].startsWith('"memberId')) ? m[1] : (m[0].match(/"memberId"\s*:\s*"([^"]+)"/) || [])[1];
        if (id) {
          this.logger.info('ali-collect', `店铺 memberId(HTTP): ${id}`);
          return { memberId: id, win, session, isGuest, acc };
        }
      }
      this.logger.warn('ali-collect', 'HTTP 源码未含 memberId，转窗口方式');
    } catch (e) {
      this.logger.warn('ali-collect', `HTTP 提取 memberId 失败: ${e.message}，转窗口方式`);
    }
    // 兜底：隐藏窗口导航提取（内部自动化窗口，非弹窗）
    await this.collector._navTo(win, target, { isGuest });
    await DOM.sleep(2000);
    let memberId = '';
    for (let i = 0; i < 10 && !memberId; i++) {
      memberId = await DOM.evalInPage(win.webContents, `
      let id = '';
      // 策略1: window.pageData.globalData（黑鲸鱼 GetglobalData 主通道）
      try {
        if (window.pageData && window.pageData.globalData) id = window.pageData.globalData.memberId || '';
      } catch (e) {}
      // 策略2: 顶栏 data-view-config → astorePageData.globalData
      try {
        if (!id) {
          const el = document.querySelector('div[class*="app-topbar"][data-view-config]');
          if (el) {
            const cfg = JSON.parse(el.getAttribute('data-view-config').replace(/&quot;/g, '"'));
            id = (cfg.astorePageData && cfg.astorePageData.globalData && cfg.astorePageData.globalData.memberId) || '';
          }
        }
      } catch (e) {}
      // 策略3: 页面源码全局搜索 memberId（扩大到全量 HTML）
      try {
        if (!id) {
          const html = document.documentElement.innerHTML;
          const m = html.match(/"memberId"\\s*:\\s*"(\\w{5,40})"/) || html.match(/memberId['"]?\\s*[:=]\\s*['"](\\w{5,40})['"]/);
          if (m) id = m[1];
        }
      } catch (e) {}
      // 策略4: window.__INIT_DATA__ 等全局数据
      try {
        if (!id) {
          for (const d of [window.__INIT_DATA__, window.pageData, window.__ALI_GLOBAL_DATA]) {
            if (!d) continue;
            const s = JSON.stringify(d);
            const m = s.match(/"memberId":"(\\w{5,40})"/);
            if (m) { id = m[1]; break; }
          }
        }
      } catch (e) {}
      return id;
    `).catch(() => '');
      if (!memberId) {
        // 滚动触发渲染再试
        await win.webContents.executeJavaScript(`window.scrollBy(0, 600); 'ok'`).catch(() => {});
        await DOM.sleep(2000);
      }
    }
    // 仍失败：可能首跳被中转/重定向，重新导航一次再提取（最多2轮）
    for (let round = 0; round < 2 && !memberId; round++) {
      this.logger.warn('ali-collect', `memberId 提取失败（当前页: ${(win.webContents.getURL() || '').slice(0, 60)}），重新导航…`);
      await this.collector._navTo(win, shopUrl, { isGuest });
      for (let i = 0; i < 5 && !memberId; i++) {
        await DOM.sleep(2000);
        memberId = await DOM.evalInPage(win.webContents, `
          let id = '';
          try { if (window.pageData && window.pageData.globalData) id = window.pageData.globalData.memberId || ''; } catch (e) {}
          try {
            if (!id) {
              const html = document.documentElement.innerHTML;
              const m = html.match(/"memberId"\\s*:\\s*"(\\w{5,40})"/) || html.match(/memberId['"]?\\s*[:=]\\s*['"](\\w{5,40})['"]/);
              if (m) id = m[1];
            }
          } catch (e) {}
          return id;
        `).catch(() => '');
      }
    }
    if (!memberId) throw new Error('未在该店铺页提取到 memberId（请确认是 1688 店铺链接）');
    this.logger.info('ali-collect', `店铺 memberId: ${memberId}`);
    return { memberId, win, session, isGuest, acc };
  }

  /** 店铺分类（黑鲸鱼 GetAliShopCate 同款：直连 mtop，失败降级窗口 JSONP） */
  async shopCate(shopUrl) {
    const s = await this.getShopMemberId(shopUrl);
    const { memberId, win, session, isGuest } = s;
    const payload = {
      componentKey: 'wpProductsCategory',
      params: JSON.stringify({ memberId }),
    };
    let data = null;
    const ctx = { win, session, isGuest, referer: shopUrl };
    try {
      data = await this._mtopWithVerify(
        () => this._mtopHttp(session, 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService', '1.0', payload, shopUrl),
        ctx, '店铺分类'
      );
    } catch (e) {
      this.logger.warn('ali-collect', `分类直连失败(${String(e.message).slice(0, 60)})，降级窗口方式`);
      await this._ensureAliDomain(win, isGuest);
      data = await this._mtopWithVerify(
        () => this._mtop(win, 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService', '1.0', payload),
        ctx, '店铺分类(窗口)'
      );
    }
    const cats = (data && data.categoryModelList) || [];
    const out = [];
    for (const c of cats) {
      // 过滤 mtop 返回的空占位分类（catId/name 为空，黑鲸鱼会显示空节点，直接丢弃更干净）
      if (c.catId == null || c.catId === '' || !c.name) continue;
      out.push({ id: String(c.catId || ''), name: String(c.name || ''), count: +c.offerCount || 0, parentId: '0' });
      const children = typeof c.children === 'string' ? safeJson('[' + String(c.children).replace(/^\[|\]$/g, '') + ']') : (c.children || []);
      for (const ch of (children || [])) {
        if (ch.catId == null || ch.catId === '' || !ch.name) continue;
        out.push({ id: String(ch.catId || ''), name: String(ch.name || ''), count: +ch.offerCount || 0, parentId: String(ch.catPid || '0') });
      }
    }
    return { ok: true, memberId, categories: out, shopUrl };
  }

  /**
   * 全店商品列表 mtop 结构化通道（黑鲸鱼 GetAlishopItemsList 同款参数：直连 HTTP 优先，降级窗口）
   * sortType: 'va_rmdarkgmv30'=综合(销量) / 'pricedown'=价格升序 / 'priceup'=价格降序（黑鲸鱼映射同款）
   */
  async shopItems({ shopUrl, memberId, page = 1, sortType = 'va_rmdarkgmv30', catId = '', priceStart = '', priceEnd = '', quantityBegin = 0, tags = '' }) {
    let win, session, isGuest;
    if (!memberId) {
      const s = await this.getShopMemberId(shopUrl);
      memberId = s.memberId; win = s.win; session = s.session; isGuest = s.isGuest;
    } else {
      const s = await this._session();
      win = s.win; session = win.webContents.session; isGuest = s.isGuest;
    }
    const appdata = {
      sortType,
      sellerRecommendFilter: false,
      mixFilter: false,
      tradenumFilter: false,
      quantityBegin: quantityBegin > 0 ? quantityBegin : null,
      pageNum: page,
      count: 30,
    };
    if (priceStart !== '' && priceStart != null) appdata.priceStart = +priceStart;
    if (priceEnd !== '' && priceEnd != null) appdata.priceEnd = +priceEnd;
    if (catId) appdata.catId = String(catId);
    if (tags) appdata.tags = String(tags); // 一件代发标记 340866（黑鲸鱼 tagsflag/yjdf）
    const payload = {
      componentKey: 'Wp_pc_common_offerlist',
      params: JSON.stringify({ memberId, appdata }),
    };
    let data = null;
    const ctx = { win, session, isGuest, referer: shopUrl };
    try {
      data = await this._mtopWithVerify(
        () => this._mtopHttp(session, 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService', '1.0', payload, shopUrl),
        ctx, '全店列表'
      );
    } catch (e) {
      this.logger.warn('ali-collect', `全店列表直连失败(${String(e.message).slice(0, 60)})，降级窗口方式`);
      await this._ensureAliDomain(win, isGuest);
      data = await this._mtopWithVerify(
        () => this._mtop(win, 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService', '1.0', payload),
        ctx, '全店列表(窗口)'
      );
    }
    const content = (data && data.content) || {};
    const offers = content.offerList || [];
    return {
      ok: true,
      offerCount: +content.offerCount || 0,
      member: content.member || null,
      items: offers.map(o => {
        const id = String(o.offerId || o.id || (o.simpleOfferPO && o.simpleOfferPO.id) || '');
        const info = o.information || o.simpleOfferPO || o;
        // price：真实字段 underLinePrice/offerPrice/discountPrice（可能是数字/字符串/对象）
        let price = null;
        try {
          let pv = o.underLinePrice != null ? o.underLinePrice
            : (o.offerPrice != null ? o.offerPrice
              : (o.discountPrice != null ? o.discountPrice : info.price));
          if (pv != null && typeof pv === 'object') pv = pv.price != null ? pv.price : (pv.value != null ? pv.value : '');
          price = parseFloat(String(pv).split(',')[0]) || null;
        } catch (_) {}
        // image：offerImages[].imageURI 相对路径 → 拼 cbu01.alicdn.com 前缀（黑鲸鱼 dowImage 同款域名）
        let image = '';
        try {
          const im0 = Array.isArray(o.offerImages) && o.offerImages.length ? o.offerImages[0] : null;
          const uri = im0 && typeof im0 === 'object' ? (im0.imageURI || im0.searchImageURI || im0.size220x220ImageURI) : im0;
          if (uri) image = /^https?:/.test(String(uri)) ? String(uri) : ('https://cbu01.alicdn.com/' + String(uri).replace(/^\//, ''));
        } catch (_) {}
        return {
          offerId: id,
          title: String(o.subject || info.subject || '').slice(0, 60),
          image,
          price,
          monthSales: String(o.thirtySaleQuantity != null ? o.thirtySaleQuantity : (o.saleQuantity != null ? o.saleQuantity : (o.bookedCount != null ? o.bookedCount : ''))),
          // 黑鲸鱼 Form全店采集 BindGridView 全字段（v2.5）
          thirtySales: o.thirtySaleQuantity != null ? +o.thirtySaleQuantity : null,      // 30天销量
          sales90: o.vaSales90 != null ? +o.vaSales90 : null,                            // 90天销量（工厂/新版字段）
          city: String(o.city || ''),                                                    // 发货地区
          buyerCount: String(o.fuzzyBuyerCount || ''),                                   // 付款人数
          gmv: String(o.gmvValueFuzzify || o.thirtyGmv || ''),                           // 成交额
          categoryId: String(o.categoryId || o.categoryId1 || o.postCategory || ''),    // 类目ID
          gmtCreate: String(o.gmtCreate || ''),                                          // 创建时间戳
          consignPrice: (() => { try { const v = o.consignPrice; return v != null ? parseFloat(String(typeof v === 'object' ? (v.price != null ? v.price : v.value) : v)) : null; } catch (_) { return null; } })(), // 代发价
          sellerLoginId: String((o.aliTalk && o.aliTalk.loginId) || o.sellerLoginId || o.loginId || ''), // 卖家loginId（好评率接口入参）
          companyName: String(o.companyName || ''),
          isFenxiao: o.tags === '340866' ? true : null,
          url: 'https://detail.1688.com/offer/' + id + '.html',
          source: 'shop-mtop',
        };
      }).filter(x => x.offerId),
    };
  }

  async _ensureSessionWin() {
    const s = await this._session();
    return s.win;
  }

  /* ================================================================
   * 渠道5：工厂店/跨境选品（Form跨境选品 GetFactoryShopCategory/GetFactoryItemList）
   * 接口：mtop.mbox.fc.common.gateway 2.0（直连 HTTP 优先）
   *   分类：serviceName=recommendItemTabV3Service params={"facMemberId":"xx","isPC":"Y"}
   *   列表：serviceName=recommendRollingItemV3Service params={...,extendParam:{tabIds,sortType,pageNo,pageSize:20,isPC:"Y"}}
   * ================================================================ */
  async factoryTabs(shopUrl) {
    const s = await this.getShopMemberId(shopUrl);
    const { memberId, win, session, isGuest } = s;
    const payload = {
      fcGroup: 'cbu-seller-fc',
      fcName: 'factory-card-common-fn',
      serviceName: 'recommendItemTabV3Service',
      params: JSON.stringify({ facMemberId: memberId, isPC: 'Y' }),
    };
    let data = null;
    const ctxTabs = { win, session, isGuest, referer: 'https://sale.1688.com/' };
    try {
      data = await this._mtopWithVerify(
        () => this._mtopHttp(session, 'mtop.mbox.fc.common.gateway', '2.0', payload, 'https://sale.1688.com/'),
        ctxTabs, '工厂店分类'
      );
    } catch (e) {
      this.logger.warn('ali-collect', `工厂店分类直连失败(${String(e.message).slice(0, 60)})，降级窗口方式`);
      await this._ensureAliDomain(win, isGuest);
      data = await this._mtopWithVerify(
        () => this._mtop(win, 'mtop.mbox.fc.common.gateway', '2.0', payload),
        ctxTabs, '工厂店分类(窗口)'
      );
    }
    const result = (data && data.result) || [];
    const tabs = result
      .filter(t => t.name !== '全部' && t.name !== '新品')
      .map(t => ({ id: String(t.id || ''), name: String(t.name || '') + '(' + (t.count || 0) + ')', count: +t.count || 0 }));
    return { ok: true, facMemberId: memberId, tabs };
  }

  async factoryItems({ shopUrl, facMemberId, tabId = 'all', page = 1, sortType = '' }) {
    let win, session, isGuest;
    if (!facMemberId) {
      const s = await this.getShopMemberId(shopUrl);
      facMemberId = s.memberId; win = s.win; session = s.session; isGuest = s.isGuest;
    } else {
      const s = await this._session();
      win = s.win; session = win.webContents.session; isGuest = s.isGuest;
    }
    const payload = {
      fcGroup: 'cbu-seller-fc',
      fcName: 'factory-card-common-fn',
      serviceName: 'recommendRollingItemV3Service',
      params: JSON.stringify({
        facMemberId: facMemberId || '',
        extendParam: { tabIds: tabId === '0' ? 'all' : String(tabId), tabIndex: 0, sortType, pageNo: page, pageSize: 20, isPC: 'Y' },
      }),
    };
    let data = null;
    const ctxItems = { win, session, isGuest, referer: 'https://sale.1688.com/' };
    try {
      data = await this._mtopWithVerify(
        () => this._mtopHttp(session, 'mtop.mbox.fc.common.gateway', '2.0', payload, 'https://sale.1688.com/'),
        ctxItems, '工厂店列表'
      );
    } catch (e) {
      this.logger.warn('ali-collect', `工厂店列表直连失败(${String(e.message).slice(0, 60)})，降级窗口方式`);
      await this._ensureAliDomain(win, isGuest);
      data = await this._mtopWithVerify(
        () => this._mtop(win, 'mtop.mbox.fc.common.gateway', '2.0', payload),
        ctxItems, '工厂店列表(窗口)'
      );
    }
    const result = (data && (data.result || data)) || {};
    const items = (result.items || []).map(o => {
      const id = String(o.itemId || o.offerId || '');
      return {
        offerId: id,
        title: String(o.offerSubject || '').slice(0, 60),
        image: String(o.imageUrl || o.image || (o.offerImgInfo && o.offerImgInfo.imageUrl) || ''),
        price: parseFloat(String((o.priceInfo && (o.priceInfo.price || o.priceInfo.rangePrice)) || o.price || '')) || null,
        monthSales: String((o.saleCount && o.saleCount.count) || o.thirtyBookCount || ''),
        isFenxiao: null,
        url: 'https://detail.1688.com/offer/' + id + '.html',
        source: 'factory',
      };
    }).filter(x => x.offerId);
    return { ok: true, items, offerCount: +result.totalCount || items.length };
  }

  /* ================================================================
   * 全店采集配套 API（v2.5，黑鲸鱼 Form全店采集 剩余功能完整移植）
   * ================================================================ */

  /**
   * 直连 mtop GET 通道（黑鲸鱼 GetproxyAdvice/queryRate 同款：GET jsonp + 动态签名）
   * @param {object} [opts] {mode:'jsonp'|'original'} jsonp=旧式 GET jsonp（黑鲸鱼同款）；original=页面现代式 POST originaljson（jsv=2.7.4 + _bx-login）
   * @returns {object} j.data；data.url 存在时表示触发验证码，抛 {code:'NEED_VERIFY', url}
   */
  async _mtopGet(session, api, v, dataObj, referer, opts = {}) {
    const mode = opts.mode || 'jsonp';
    const dataStr = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
    const apiPath = String(api).toLowerCase();
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = Date.now().toString();
      const token = await this._h5Token(session);
      const sign = crypto.createHash('md5').update(`${token}&${t}&${APP_KEY}&${dataStr}`, 'utf8').digest('hex');
      const base = `https://h5api.m.1688.com/h5/${apiPath}/${v}/?jsv=${mode === 'original' ? '2.7.4' : '2.4.11'}&appKey=${APP_KEY}&t=${t}&sign=${sign}&api=${api}&v=${v}`;
      let url;
      if (mode === 'original') {
        url = base + `&_bx-login=new&dataType=jsonp&type=originaljson&timeout=20000`;
        const r = await this._httpPost(session, url, 'data=' + encodeURIComponent(dataStr), referer || 'https://detail.1688.com/');
        const j = this._parseMtopJson(r.body, 'mtop POST');
        const ret = (j.ret && j.ret[0]) || '';
        if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(ret)) {
          await DOM.sleep(300 + attempt * 400);
          continue;
        }
        if (!/SUCCESS/i.test(ret) && !j.data) throw new Error('mtop POST: ' + ret);
        if (j.data && j.data.url) { const e = new Error('mtop 触发验证码'); e.code = 'NEED_VERIFY'; e.url = j.data.url; throw e; }
        return j.data && j.data.data !== undefined ? j.data.data : j.data;
      }
      url = base + `&type=jsonp&isSec=0&timeout=20000&dataType=jsonp&callback=mtopjsonp10&data=${encodeURIComponent(dataStr)}`;
      const r = await this._httpGet(session, url, { Referer: referer || 'https://detail.1688.com/' });
      const j = this._parseMtopJson(r.body, 'mtop GET');
      const ret = (j.ret && j.ret[0]) || '';
      // token 失效：等待服务端种新 _m_h5_tk 后重试（黑鲸鱼 Request 同款逻辑）
      if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(ret)) {
        await DOM.sleep(300 + attempt * 400);
        continue;
      }
      if (!/SUCCESS/i.test(ret) && !j.data) throw new Error('mtop GET: ' + ret);
      if (j.data && j.data.url) { const e = new Error('mtop 触发验证码'); e.code = 'NEED_VERIFY'; e.url = j.data.url; throw e; }
      return j.data && j.data.data !== undefined ? j.data.data : j.data;
    }
    throw new Error('mtop GET token 校验失败（重试3次）');
  }

  /** mtop 响应解析：先按纯 JSON 直接解析；失败再兼容 jsonp 尾部 ')' 截断重试（响应数据内含 ')' 不能盲截） */
  _parseMtopJson(txt, label) {
    const s = String(txt || '').indexOf('{');
    if (s < 0) throw new Error(label + ' 无 JSON 响应');
    const body = String(txt).slice(s);
    let j = null;
    try { j = JSON.parse(body); } catch (_) {}
    if (!j) {
      const end = body.lastIndexOf(')');
      if (end > 0) { try { j = JSON.parse(body.slice(0, end)); } catch (_) {} }
    }
    if (!j) throw new Error(label + ' 响应解析失败: ' + String(txt).slice(0, 80));
    return j;
  }

  /**
   * 页面级 mmga 聚合接口（2026 新版好评率/参谋统一入口）：
   * 与页面完全一致的请求格式：POST + data={mmgaRequest:{...}} + jsv=2.7.4 + _bx-login=new + type=originaljson
   * 签名 data 序列化为 {"mmgaRequest":dataObj}（键序与页面一致，否则 FAIL_SYS_ILLEGAL_ACCESS）
   * @returns 完整 j.data 对象（含 data.result / data.data 等子结构，按 serviceName 不同而不同）
   */
  async _mmgaPost(session, serviceName, dataObj, referer) {
    const api = 'mtop.1688.mmga.offerdetail.service';
    const dataStr = JSON.stringify({ mmgaRequest: dataObj });
    const apiPath = String(api).toLowerCase();
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = Date.now().toString();
      const token = await this._h5Token(session);
      const sign = crypto.createHash('md5').update(`${token}&${t}&${APP_KEY}&${dataStr}`, 'utf8').digest('hex');
      const url = `https://h5api.m.1688.com/h5/${apiPath}/1.0/?jsv=2.7.4&appKey=${APP_KEY}&t=${t}&sign=${sign}&_bx-login=new&api=${api}&v=1.0&dataType=jsonp&type=originaljson&timeout=20000`;
      const r = await this._httpPost(session, url, 'data=' + encodeURIComponent(dataStr), referer || 'https://detail.1688.com/');
      const j = this._parseMtopJson(r.body, 'mmga POST');
      const ret = (j.ret && j.ret[0]) || '';
      if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(ret)) {
        await DOM.sleep(300 + attempt * 400);
        continue;
      }
      if (!/SUCCESS/i.test(ret)) throw new Error('mmga POST(' + serviceName + '): ' + ret);
      if (j.data && j.data.url) { const e = new Error('mmga 触发验证码'); e.code = 'NEED_VERIFY'; e.url = j.data.url; throw e; }
      return j.data;
    }
    throw new Error('mmga POST token 校验失败（重试3次）');
  }

  /**
   * 代发参谋数据（黑鲸鱼 GetproxyAdvice 功能 → 2026 新版接口 offerPCConsignInfoService）
   * 请求：mtop.1688.mmga.offerdetail.service + mmgaRequest.offerPCConsignInfoService（最小参数即可）
   * 返回：advise{商家代发热度/近30天代发数量/近7天代发数量/铺货分销商数/代发品质达标率/代发买家留货率/商品发布时间}
   */
  async proxyAdvice(offerId, sellerMemberId) {
    const { win } = await this._session();
    const session = win.webContents.session; // 账号窗口专用 partition session（登录态 cookie 与 _m_h5_tk 在此）
    const data = await this._mmgaPost(session, 'offerPCConsignInfoService', {
      serviceName: 'offerPCConsignInfoService',
      offerId: Number(offerId) || 0,
      isDistribution: true,
      sellerMemberId: String(sellerMemberId || ''),
    });
    const out = { advise: {}, waybillSupport: '' };
    // 响应路径：j.data.data.data.adviseList（_mmgaPost 已返回 j.data，再进 data 层）
    const list = ((data && data.data && data.data.data && data.data.data.adviseList) || []);
    const pick = {};
    for (const it of (list || [])) pick[String(it.name || '')] = String(it.value != null ? it.value : '');
    // 兼容旧字段名（黑鲸鱼旧版列：月代发订单数/下游铺货数），映射到新接口字段
    out.advise = {
      ...pick,
      '月代发订单数': pick['近30天代发数量'] || '',
      '下游铺货数': pick['铺货分销商数'] || '',
      '商品退货率': pick['代发买家留货率'] || '',
      '48小时发货率': pick['代发品质达标率'] || '',
    };
    return { ok: true, ...out };
  }

  /**
   * 好评率数据（页面接口 pcOdRateCardInfoMergeService）
   * 响应 model 字段：goodPercentForPc 好评率数字 / goodPercent 好评率文案 / commentTotalNum 评论数 /
   *                 tbRateCnt 评价数 / rateAverageStarLevel 星级 / commentList 评价列表 / ratePics 晒图
   */
  async queryRate(offerId, loginId, sellerMemberId) {
    const { win } = await this._session();
    const session = win.webContents.session; // 账号窗口专用 partition session（登录态 cookie 与 _m_h5_tk 在此）
    let data;
    try {
      data = await this._mmgaPost(session, 'pcOdRateCardInfoMergeService', {
        serviceName: 'pcOdRateCardInfoMergeService',
        offerId: Number(offerId) || 0,
        sellerLoginId: String(loginId || ''),
        sellerMemberId: String(sellerMemberId || ''),
      });
    } catch (e) {
      this.logger.warn('ali-collect', 'queryRate err: ' + e.message + ' loginId=' + loginId);
      throw e;
    }
    const out = {};
    // 兼容外层：j.data.data.result.offerRateInfo.model
    const model = ((data && data.data && data.data.result && data.data.result.offerRateInfo && data.data.result.offerRateInfo.model) || {});
    out['商品好评'] = String(model.goodPercent != null ? model.goodPercent : (model.goodPercentForPc != null ? model.goodPercentForPc + '%' : ''));
    out['评论数'] = String(model.commentTotalNum != null ? model.commentTotalNum : '');
    out['评价数'] = String(model.tbRateCnt != null ? model.tbRateCnt : '');
    out['星级'] = String(model.rateAverageStarLevel != null ? model.rateAverageStarLevel : '');
    return { ok: true, rates: out };
  }

  /**
   * 轻量详情（黑鲸鱼 Get_Item1688DetailInfo + HdItemDetail1688_new 直连版）：
   * 直连 HTTP 拉详情页 → 解析 window.__INIT_DATA__，仅提取全店采集过滤所需字段
   * 返回：qdl 起订量 / bookcount 总库存 / location 发货地区 / deliveryLimitText 发货时间 /
   *       postFeeValue 运费 / huohao 货号 / skulist[{skuvalue,price,quantity}]
   */
  async itemDetailLite(offerId) {
    const { win, isGuest } = await this._session();
    const session = win.webContents.session; // 直连 HTTP 必须用窗口同源 session（登录态 cookie）
    const url = 'https://detail.1688.com/offer/' + String(offerId) + '.html';
    let html = '';
    try {
      const r = await this._httpGet(session, url, { Referer: 'https://sale.1688.com/' });
      html = String(r.body || '');
    } catch (_) {}
    // 主通道：直连 HTML 解析（window.context SSR 数据优先，黑鲸鱼 HdItemDetail1688_new 同源）
    if (html && !html.includes('小二正忙') && !html.includes('_____tmd_____/verify/')) {
      const parsed = this._parseDetailHtml(html);
      if (parsed) return { ok: true, ...parsed };
    }
    // 降级：隐藏窗口导航渲染（直连无 SSR 数据时，页面上下文提取；不弹窗）
    try {
      // 窗口已在目标 URL 且数据就绪则直接复用（避免重复导航重载时序），否则导航一次
      const cur = win.webContents.getURL() || '';
      let ready = false;
      if (cur === url) {
        ready = await DOM.evalInPage(win.webContents, `return !!(window.context && window.context.result && window.context.result.data);`).catch(() => false);
      }
      if (!ready) {
        await this.collector._navTo(win, url, { isGuest });
        // 就绪轮询：SSR 数据最长 12 秒（避免固定 sleep 时序问题）
        for (let i = 0; i < 12; i++) {
          await DOM.sleep(1000);
          ready = await DOM.evalInPage(win.webContents, `return !!(window.context && window.context.result && window.context.result.data);`).catch(() => false);
          if (ready) break;
        }
      }
      if (!ready) {
        const u2 = win.webContents.getURL() || '';
        return { ok: false, message: '详情页数据未就绪（' + String(u2).slice(0, 60) + '）' };
      }
      const out = await DOM.evalInPage(win.webContents, `
        return (() => {
          const out = { qdl: '', location: '', deliveryLimitText: '', postFeeValue: '', huohao: '', bookcount: 0, skulist: null, postCategoryId: '' };
          try {
            const rd = (window.context && window.context.result && window.context.result.data) ||
              (window.__INIT_DATA__ && ((window.__INIT_DATA__.result && window.__INIT_DATA__.result.data) || (window.__INIT_DATA__.globalData))) || null;
            if (rd) {
              const ship = (rd.shippingServices && rd.shippingServices.fields) || {};
              out.location = String(ship.location || '');
              out.deliveryLimitText = String(ship.deliveryLimitText || '');
              out.postFeeValue = String(ship.postFeeValue != null ? ship.postFeeValue : '');
              try { out.qdl = String(ship.startAmount || (rd.submitOrder && rd.submitOrder.fields && rd.submitOrder.fields.subName) || '').replace(/起批|起订/g, ''); } catch (e) {}
              try {
                const pm = rd.mainPrice && rd.mainPrice.fields && rd.mainPrice.fields.priceModel;
                if (!out.qdl && pm && pm.currentPrices && pm.currentPrices[0]) out.qdl = String(pm.currentPrices[0].beginAmount || '');
              } catch (e) {}
              try {
                const sm = rd.Root && rd.Root.fields && rd.Root.fields.dataJson && rd.Root.fields.dataJson.skuModel;
                if (sm && sm.skuInfoMap) {
                  const list = []; let total = 0;
                  for (const k of Object.keys(sm.skuInfoMap)) {
                    const info = sm.skuInfoMap[k] || {};
                    let pv = info.priceAmount;
                    if (pv == null && info.discountPrice != null) pv = info.discountPrice;
                    if (pv == null && info.price != null) pv = (typeof info.price === 'object') ? (info.price.priceText || info.price.price) : info.price;
                    list.push({ skuvalue: String(k).replace(/&gt;/g, '>'), price: String(pv != null ? pv : ''), quantity: parseInt(info.canBookCount || 0, 10) || 0 });
                    total += parseInt(info.canBookCount || 0, 10) || 0;
                  }
                  if (list.length) { out.skulist = list; out.bookcount = total; }
                }
              } catch (e) {}
              try {
                const s = JSON.stringify(window.context || {});
                const m = s.match(/"name":"货号"[\\s\\S]{0,80}?"values":\\["([^"]+)"\\]/);
                if (m) out.huohao = m[1];
                const c = s.match(/"postCategoryId":"?(\\d{6,})/);
                if (c) out.postCategoryId = c[1];
              } catch (e) {}
            }
          } catch (e) {}
          return JSON.stringify(out);
        })()
      `).catch(() => '');
      if (out) {
        const j = safeJson(out);
        if (j && (j.location || j.qdl || j.skulist || j.huohao)) return { ok: true, ...j };
      }
      if (!html || html.includes('小二正忙') || html.includes('_____tmd_____/verify/')) {
        return { ok: false, needVerify: true, message: '详情页触发验证码' };
      }
      return { ok: false, message: '详情数据提取失败' };
    } catch (e) {
      return { ok: false, message: '详情获取失败: ' + e.message };
    }
  }

  /** 直连 HTML 解析 __INIT_DATA__（提取成功返回对象，否则 null） */
  _parseDetailHtml(html, offerId) {
    const key = 'window.__INIT_DATA__';
    const idx = html.indexOf(key);
    if (idx < 0) return null;
    const eq = html.indexOf('=', idx + key.length);
    if (eq < 0) return null;
    let i = html.indexOf('{', eq);
    if (i < 0) return null;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    const D = safeJson(html.slice(html.indexOf('{', eq), end + 1));
    if (!D) return null;
    const g = (o, path) => { let c = o; for (const k of path.split('.')) { if (c == null) return undefined; c = c[k]; } return c; };
    const model = g(D, 'globalData') || g(D, 'model') || D;
    const result = g(D, 'result') || {};
    const rData = result.data || {};
    const shipFields = (rData.shippingServices && rData.shippingServices.fields) || {};
    const qdl = String(shipFields.startAmount || g(rData, 'mainPrice.fields.priceModel.currentPrices.0.beginAmount') || '').replace(/起批|起订/g, '');
    let bookcount = 0;
    try {
      const map = g(model, 'skuModel.skuInfoMapOriginal') || {};
      for (const k of Object.keys(map)) bookcount += parseInt(g(map, k + '.canBookCount') || 0, 10) || 0;
    } catch (_) {}
    let huohao = '';
    try {
      for (const fa of (g(model, 'offerDetail.featureAttributes') || [])) {
        if (String(fa.name || '') === '货号' && Array.isArray(fa.values) && fa.values.length) huohao = String(fa.values[0]);
      }
    } catch (_) {}
    let skulist = null;
    try {
      const skuModel = model.skuModel || g(D, 'globalData.tempModel') || {};
      const sku2info = skuModel.sku2info || {};
      const propMap = skuModel.skuValueMap || {};
      const list = [];
      for (const sid of Object.keys(sku2info)) {
        const info = sku2info[sid] || {};
        if (info.price == null) continue;
        let skuvalue = '';
        const pp = String(info.propPath || '');
        if (pp && Object.keys(propMap).length) {
          skuvalue = pp.split(';').filter(Boolean).map(seg => {
            const v = propMap[seg];
            return v ? String(typeof v === 'object' ? (v.name || v.value || '') : v) : '';
          }).filter(Boolean).join('+');
        }
        list.push({
          skuvalue,
          price: String((info.price && info.price.priceText) || ''),
          quantity: parseInt(info.canBookCount || info.quantity || 0, 10) || 0,
        });
      }
      if (list.length) skulist = list;
    } catch (_) {}
    return {
      qdl: qdl || '',
      bookcount,
      location: String(shipFields.location || g(model, 'location') || ''),
      deliveryLimitText: String(shipFields.deliveryLimitText || ''),
      postFeeValue: String(shipFields.postFeeValue || ''),
      huohao,
      skulist,
      postCategoryId: String(g(model, 'tempModel.postCategoryId') || ''),
    };
  }

  /**
   * 供应商名称搜索（黑鲸鱼 SearchCompany 移植 + 2026 改版适配）：
   * 主通道直连 HTTP（老版 SSR 正则）；1688 已改版为 React CSR，降级隐藏窗口导航渲染后 DOM 提取
   */
  async searchCompany(companyName) {
    const name = String(companyName || '').trim();
    if (!name) return { ok: false, message: '供应商名称为空' };
    const iconv = require('iconv-lite');
    const buf = iconv.encode(name, 'gbk');
    let gbk = '';
    for (const x of buf) gbk += '%' + x.toString(16).padStart(2, '0').toUpperCase();
    const url = 'https://s.1688.com/company/company_search.htm?keywords=' + gbk;
    const { win, isGuest } = await this._session();
    const session = win.webContents.session; // 直连 HTTP 必须用窗口同源 session
    // 主通道：直连 HTTP（黑鲸鱼 HttpStl 同款正则）
    try {
      const r = await this._httpGet(session, url, { Referer: 'https://www.1688.com/' });
      const m = String(r.body || '').match(/<a class="list-item-title-text"[\s\S]*?<\/a>/);
      if (m && m[0].includes(name)) {
        const href = (m[0].match(/href="[\s\S]*?"/) || [''])[0].replace('href="', '').replace('"', '');
        if (href) return { ok: true, shopUrl: href };
      }
    } catch (_) {}
    // 降级：隐藏窗口导航（CSR 渲染后 DOM 提取，不弹窗）
    try {
      await this.collector._navTo(win, url, { isGuest });
      await DOM.sleep(5000);
      const href = await DOM.evalInPage(win.webContents, `
        let out = '';
        try {
          const name = ${JSON.stringify(name)};
          let a = document.querySelector('a.list-item-title-text');
          if (!a) {
            a = [...document.querySelectorAll('a')].find(x => {
              const t = (x.textContent || '').trim();
              return t && t.includes(name) && /\\.1688\\.com/.test(x.href) && !/offer\\//.test(x.href);
            });
          }
          if (a) out = a.href;
        } catch (e) {}
        out;
      `).catch(() => '');
      if (href) return { ok: true, shopUrl: href };
    } catch (e) {
      return { ok: false, message: '搜索失败: ' + e.message };
    }
    return { ok: false, message: `供应商【${name}】未查询到` };
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = { AlibabaCollector, APP_KEY, MD5_JS };
