/**
 * 渲染进程 - 黑鲸鱼淘宝上货 UI 复刻版
 * 五大Tab：采集宝贝 / 上传设置 / 图片设置 / 上传宝贝 / 上传记录
 */
const bridge = window.api;

/* ============ 状态 ============ */
let collected = { link: [], kw: [], shop: [] };
let ulPageNum = 1;

/* ============ 主Tab导航（黑鲸鱼 mTabControl1） ============ */
document.querySelectorAll('.mtab').forEach(btn => {
  btn.addEventListener('click', () => go(btn.dataset.tab));
});
document.querySelectorAll('.stab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.subpage').forEach(p => p.classList.toggle('show', p.id === 'sub-' + btn.dataset.sub));
  });
});
function go(page) {
  document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('active', b.dataset.tab === page));
  document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('show', p.id === 'tab-' + page));
  document.getElementById('page-logs').classList.toggle('active', page === 'logs');
  const loaders = {
    collect: () => { refreshTopbar(); },
    hotpick: () => {},
    upset: loadUploadConfig,
    imgset: loadUploadConfig,
    upload: loadUploadList,
    records: loadRecords,
    logs: refreshLogs,
    aiop: loadAiConfig,
    suppl: loadSuppliers,
  };
  if (loaders[page]) loaders[page]();
}

/* ============ 通用 ============ */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg, isErr) {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = `position:fixed;top:60px;right:16px;z-index:999;padding:10px 18px;border-radius:8px;color:#fff;
    background:${isErr ? '#dc2626' : '#16a34a'};box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:13px;max-width:480px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function fmtTime(ts) { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function setChk(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }
function getChk(id) { const el = document.getElementById(id); return el ? el.checked : false; }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

/* ============ 无弹窗交互（黑鲸鱼式）：底部内嵌工具条 + 二次点击确认 ============ */
let _itResolve = null, _itArmed = false, _itArmTimer = null;
// 底部工具条表单：fields=[{key,label,type:'text'|'select',value,placeholder,options}]；confirmText 非空则提交需二次确认
// 返回 Promise<字段值对象|null>（取消=null）
function inlineForm(opts) {
  if (_itResolve) { const r = _itResolve; _itResolve = null; r(null); }
  return new Promise(resolve => {
    _itResolve = resolve;
    const tb = document.getElementById('inline-toolbar');
    const titleEl = document.getElementById('it-title');
    const fieldsEl = document.getElementById('it-fields');
    const okBtn = document.getElementById('it-ok');
    const cancelBtn = document.getElementById('it-cancel');
    const confirmText = opts.confirmText || '';
    titleEl.textContent = opts.title || '';
    fieldsEl.innerHTML = '';
    (opts.fields || []).forEach(f => {
      const wrap = document.createElement('label');
      if (f.label) { const sp = document.createElement('span'); sp.textContent = f.label; wrap.appendChild(sp); }
      if (f.type === 'select') {
        const sel = document.createElement('select');
        sel.id = 'itf-' + f.key;
        (f.options || []).forEach(o => { const op = document.createElement('option'); op.value = o.value; op.textContent = o.text; sel.appendChild(op); });
        if (f.value != null) sel.value = f.value;
        wrap.appendChild(sel);
      } else {
        const inp = document.createElement('input');
        inp.id = 'itf-' + f.key;
        inp.placeholder = f.placeholder || '';
        inp.value = f.value || '';
        wrap.appendChild(inp);
      }
      fieldsEl.appendChild(wrap);
    });
    const firstInput = fieldsEl.querySelector('input, select');
    const resetArm = () => {
      _itArmed = false; okBtn.dataset.arm = '0';
      okBtn.classList.remove('armed'); okBtn.textContent = '确定';
    };
    const finish = (vals) => {
      tb.style.display = 'none';
      clearTimeout(_itArmTimer);
      resetArm();
      const r = _itResolve; _itResolve = null;
      r(vals);
    };
    okBtn.onclick = () => {
      if (confirmText && !_itArmed) {
        _itArmed = true; okBtn.dataset.arm = '1';
        okBtn.textContent = '再点一次确认'; okBtn.classList.add('armed');
        clearTimeout(_itArmTimer);
        _itArmTimer = setTimeout(resetArm, 3200);
        return;
      }
      const vals = {};
      (opts.fields || []).forEach(f => { const el = document.getElementById('itf-' + f.key); if (el) vals[f.key] = el.value; });
      finish(vals);
    };
    cancelBtn.onclick = () => finish(null);
    fieldsEl.querySelectorAll('input').forEach(inp => {
      inp.onkeydown = e => {
        if (e.key === 'Enter') okBtn.onclick();
        if (e.key === 'Escape') cancelBtn.onclick();
      };
    });
    tb.style.display = 'flex';
    if (firstInput) setTimeout(() => { try { firstInput.focus(); } catch (_) {} }, 40);
  });
}
// 按钮二次点击确认：第一次点击变红"确认?"，3秒内再点执行
function armAction(btn, fn) {
  if (btn.dataset.arm === '1') {
    clearTimeout(btn._armT);
    btn.dataset.arm = '0'; btn.classList.remove('armed');
    btn.textContent = btn.dataset.orig || btn.textContent;
    fn();
    return;
  }
  btn.dataset.orig = btn.textContent;
  btn.dataset.arm = '1'; btn.classList.add('armed');
  btn.textContent = '确认?';
  btn._armT = setTimeout(() => {
    btn.dataset.arm = '0'; btn.classList.remove('armed');
    btn.textContent = btn.dataset.orig;
  }, 3200);
}

/* ============ 进度卡片 ============ */
const progressCards = new Map();
function showProgress(key, { title, detail = '', percent = null, done = false, error = false }) {
  let box = progressCards.get(key);
  if (!box) {
    box = document.createElement('div');
    box.className = 'prog-card';
    document.body.appendChild(box);
    progressCards.set(key, box);
  }
  const pct = percent != null ? Math.round(percent) : null;
  const barColor = error ? '#dc2626' : (done ? '#16a34a' : '#2563eb');
  box.innerHTML = `
    <div class="prog-head">
      <span class="prog-title">${done ? (error ? '✘ ' : '✔ ') : '⏳ '}${esc(title)}</span>
      ${pct != null ? `<span class="prog-pct" style="color:${barColor}">${pct}%</span>` : ''}
      ${done ? `<span class="prog-close" onclick="hideProgress('${key}')">✕</span>` : ''}
    </div>
    ${pct != null ? `<div class="prog-bar"><div class="prog-fill" style="width:${pct}%;background:${barColor}"></div></div>` : ''}
    ${detail ? `<div class="prog-detail">${esc(detail)}</div>` : ''}
  `;
  box.style.borderColor = error ? '#dc2626' : (done ? '#16a34a' : '#2563eb');
  clearTimeout(box._t);
  if (done) box._t = setTimeout(() => hideProgress(key), error ? 20000 : 8000);
  relayoutProgress();
}
function hideProgress(key) {
  const box = progressCards.get(key);
  if (box) { box.remove(); progressCards.delete(key); }
  relayoutProgress();
}
function relayoutProgress() {
  let bottom = 16;
  for (const box of progressCards.values()) {
    box.style.bottom = bottom + 'px';
    bottom += box.offsetHeight + 10;
  }
}

/* ============ 顶栏 ============ */
async function refreshTopbar() {
  try {
    const [accs, stats] = await Promise.all([bridge.listAccounts(), bridge.queueStats()]);
    const shop = accs.find(a => a.type === 'shop');
    const shopOk = shop && shop.status === 'ok';
    const shopText = shop ? (shopOk ? `店铺: ${shop.name}` : `店铺: ${shop.name} (登录失效)`) : '店铺: 未登录';
    setText('top-shop-name', shopText);
    setText('lblShopName', shopText);
    const shopEl = document.getElementById('top-shop-name');
    if (shopEl) shopEl.style.color = shop && !shopOk ? '#f59e0b' : '';
    // 采集账号（1688）状态：任意 ok 的显示第一个，否则未登录
    const collectOk = accs.filter(a => a.type === 'collect' && a.status === 'ok');
    const collectExpired = accs.filter(a => a.type === 'collect' && a.status === 'expired');
    const collectText = collectOk.length
      ? `采集账号: ${collectOk.map(a => a.name).join(' / ')}`
      : (collectExpired.length ? `采集账号: ${collectExpired.map(a => a.name).join(' / ')} (登录失效)` : '采集账号: 未登录');
    setText('top-collect-acc', collectText);
    const colEl = document.getElementById('top-collect-acc');
    if (colEl) colEl.style.color = collectExpired.length && !collectOk.length ? '#f59e0b' : '';
    setText('top-today-stat', `今日上传 ${stats.today}/${stats.dailyLimit}`);
    setText('lab_leftItem', String(stats.pending != null ? stats.pending : 0));
    setText('lab_leftItem1', String(stats.pending != null ? stats.pending : 0));
    const mini = document.getElementById('queue-mini');
    if (mini) mini.textContent = stats.running ? `🚀 队列运行中 · 待传 ${stats.pending}` : `待传 ${stats.pending} · 失败 ${stats.failed}`;
  } catch (e) { /* 静默 */ }
}

/* ============ 链接采集 ============ */
// 导入链接.txt到文本域（不采集，仅填入textarea供用户确认后点开始采集）
async function importLinksToTextarea() {
  try {
    const r = await bridge.pickTextFile();
    if (!r.ok || !r.text) return;
    const el = document.getElementById('link-input');
    if (!el) { toast('未找到链接输入框', true); return; }
    const existing = el.value.trim();
    el.value = existing ? existing + '\n' + r.text.trim() : r.text.trim();
    const count = el.value.split(/\r?\n/).filter(l => l.trim()).length;
    toast(`已导入 ${count} 行链接，确认后点「开始采集」`);
  } catch (e) { toast('导入失败：' + e.message, true); }
}
async function doLinkCollect() {
  const raw = document.getElementById('link-input').value.trim();
  if (!raw) { toast('请输入至少一条1688宝贝链接', true); return; }
  const offerIds = [...new Set(
    raw.split(/\r?\n/).map(l => l.trim()).map(l => (l.match(/offer\/(\d{6,})/) || [])[1]).filter(Boolean)
  )];
  if (!offerIds.length) { toast('未识别到有效的1688宝贝链接（需含 offer/数字）', true); return; }
  if (offerIds.length > 100) { toast('一次最多100条', true); return; }
  const btn = document.getElementById('btn-link-collect');
  btn.disabled = true; btn.textContent = `采集中（0/${offerIds.length}）…`;
  try {
    const r = await bridge.startCollect({ offerIds, downloadImages: getChk('link-dlimg') });
    const goods = await bridge.listGoods({ pageSize: 200, page: 1 });
    const fresh = goods.items.filter(g => offerIds.includes(g.offerId) && g.status === 'pending');
    collected.link = fresh.map(g => ({
      id: g.id, offerId: g.offerId, title: g.title,
      price: g.raw && g.raw.price, isFenxiao: g.raw && g.raw.isFenxiao,
      img: g.raw && g.raw.mainImages && g.raw.mainImages[0],
      localMain: g.raw && g.raw.localMainImages ? g.raw.localMainImages.length : 0,
    }));
    renderCollected('link');
    appendCollectLog(`链接采集完成：成功${r.ok} 失败${r.fail} 跳过${r.skipped}`);
    toast(`采集完成：成功${r.ok} 失败${r.fail} 跳过${r.skipped}`);
    refreshTopbar();
  } catch (e) {
    toast('采集失败：' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '开始采集';
  }
}

/* ============ 关键词采集（按货源渠道路由：常规/一键代发/低价货源/优质货源P4P） ============ */
async function doKeywordCollect() {
  const kw = document.getElementById('kw-input').value.trim();
  if (!kw) { toast('请输入关键词', true); return; }
  const channel = getVal('cbb_Source') || 'normal';
  const pages = +getVal('kw-pages') || 3;
  const priceMin = getVal('kw-pricemin') || null;
  const priceMax = getVal('kw-pricemax') || null;
  const btn = document.getElementById('btn-kw-collect');
  const btnName = { normal: '关键词选款', daixiao: '一键代发', lowprice: '低价货源', premium: '优质货源' }[channel];
  btn.disabled = true; btn.textContent = '搜索中…';
  try {
    let items = [];
    if (channel === 'normal') {
      const r = await bridge.collectByKeyword({ keyword: kw, pages, priceMin, priceMax, onlyFenxiao: false });
      items = r.items || [];
    } else if (channel === 'daixiao' || channel === 'lowprice') {
      // 低价货源 = 一件代发货源按价格升序（黑鲸鱼 Form低价货源 同款逻辑）
      const r = await bridge.collectDaixiao({
        keyword: kw, pages, priceMin, priceMax,
        sortType: channel === 'lowprice' ? 'priceUp' : 'sale',
      });
      items = r.items || [];
    } else if (channel === 'premium') {
      const r = await bridge.collectPremium({ keyword: kw, pages });
      items = r.items || [];
    }
    collected.kw = items.map(it => ({
      offerId: it.offerId, title: it.title,
      price: it.price, isFenxiao: it.isFenxiao,
      img: it.image || (it.mainImages && it.mainImages[0]),
      monthSales: it.monthSales,
    }));
    renderCollected('kw');
    appendCollectLog(`${btnName}「${kw}」采集完成：${collected.kw.length} 个宝贝`);
    toast(`${btnName}采集完成：${collected.kw.length} 个宝贝`);
  } catch (e) {
    toast(btnName + '采集失败：' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = btnName;
  }
}

/* ============ 工厂店采集（黑鲸鱼 Form跨境选品，mtop.mbox.fc.common.gateway） ============ */
async function doFactoryCollect() {
  const urlIn = await inlineForm({
    title: '工厂店采集',
    fields: [{ key: 'url', label: '1688工厂店链接（工厂店/实力商家店铺）', placeholder: 'https://xxx.1688.com', value: '' }],
  });
  if (!urlIn) return;
  const url = String(urlIn.url || '').trim();
  if (!url || !/1688\.com/.test(url)) { toast('请输入有效的1688店铺链接', true); return; }
  toast('正在读取工厂店分类…');
  try {
    const t = await bridge.factoryTabs(url);
    if (!t.ok || !t.tabs || !t.tabs.length) { toast('未获取到工厂店分类（确认该店是工厂店/实力商家）', true); return; }
    // 选择分类（底部工具条下拉，最多展示12个）
    const pick = await inlineForm({
      title: `工厂店分类（共${t.tabs.length}个，选择后开始采集）`,
      fields: [{
        key: 'cat', label: '分类', type: 'select', value: 'all',
        options: [{ value: 'all', text: '全部分类' }].concat(t.tabs.slice(0, 12).map(x => ({ value: x.id, text: x.name }))),
      }],
    });
    if (!pick) return;
    const tabId = pick.cat || 'all';
    // 翻页采集（最多10页，每页20条）
    const all = new Map();
    for (let page = 1; page <= 10; page++) {
      const r = await bridge.factoryItems({ shopUrl: url, facMemberId: t.facMemberId, tabId, page });
      const items = (r.items || []).filter(x => x.offerId && !all.has(x.offerId));
      if (!items.length) break;
      items.forEach(x => all.set(x.offerId, x));
      toast(`工厂店采集第 ${page} 页：累计 ${all.size} 条…`);
      if (page < 10) await new Promise(res => setTimeout(res, 1500));
    }
    collected.shop = [...all.values()].map(it => ({
      offerId: it.offerId, title: it.title, price: it.price,
      isFenxiao: it.isFenxiao, img: it.image, monthSales: it.monthSales,
    }));
    renderCollected('shop');
    appendCollectLog(`工厂店采集完成：${collected.shop.length} 个宝贝`);
    toast(`工厂店采集完成：${collected.shop.length} 个宝贝`);
  } catch (e) {
    toast('工厂店采集失败：' + e.message, true);
  }
}

/* ============ 全店采集（黑鲸鱼 Form全店采集 完整移植 v2.5：分类树/6档排序/销量/90天/库存/起批量/参谋/好评率/SKU/货号/导出） ============ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let shopCateData = [];      // 分类树数据
let shopExportedIds = null; // 已导出宝贝ID缓存（exported-ids.txt）
let shopFilterWords = null;  // 标题过滤词缓存（filterwords.txt）

function syncSycmInputs() {
  const on = getChk('shop-sycm');
  document.getElementById('shop-ydxl1').disabled = !on;
  document.getElementById('shop-ydxl2').disabled = !on;
}
function toggleShopCateTree() {
  const w = document.getElementById('shop-cate-tree-wrap');
  w.style.display = w.style.display === 'none' ? 'block' : 'none';
}
// 渲染分类树（黑鲸鱼 BindTree：根"全部" + 顶级分类 + 子分类 两级）
function buildShopCateTree(cats) {
  const box = document.getElementById('shop-cate-tree');
  const roots = cats.filter(c => String(c.parentId) === '0');
  let html = `<div style="margin:2px 0"><label class="inline-check"><input type="checkbox" class="sc-node" data-id="0" onchange="shopCateStats()"> 全部</label></div>`;
  for (const r of roots) {
    const kids = cats.filter(c => String(c.parentId) === String(r.id));
    html += `<div style="margin:3px 0 3px 4px"><label class="inline-check"><input type="checkbox" class="sc-node" data-id="${esc(r.id)}" onchange="shopCateStats()"> <b>${esc(r.name)}(${r.count})</b></label>`;
    if (kids.length) {
      html += `<div style="margin-left:18px">` + kids.map(k =>
        `<div style="margin:2px 0"><label class="inline-check"><input type="checkbox" class="sc-node" data-id="${esc(k.id)}" onchange="shopCateStats()"> ${esc(k.name)}(${k.count})</label></div>`).join('') + `</div>`;
    }
    html += `</div>`;
  }
  box.innerHTML = html;
}
function shopCateCheckAll(on) {
  document.querySelectorAll('#shop-cate-tree .sc-node').forEach(c => c.checked = on);
  shopCateStats();
}
function shopCateStats() {
  const checked = [...document.querySelectorAll('#shop-cate-tree .sc-node:checked')];
  const n = checked.filter(c => c.dataset.id !== '0').length;
  const tip = document.querySelector('#shop-cate-tree-wrap b');
  if (tip) tip.textContent = n ? `店铺分类（已勾选 ${n} 个分类）` : '店铺分类（勾选后按分类采集，不勾=全部）';
}
// 获取店铺分类（黑鲸鱼 mButton2：普通店 GetAliShopCate 树形 / factory URL 走 GetFactoryShopCategory）
async function doShopLoadCate() {
  const url = getVal('shop-input').trim();
  if (!url) { toast('请输入1688店铺链接或供应商名称', true); return; }
  if (!/1688\.com/.test(url)) { toast('请输入有效的1688店铺链接（或供应商名称点「搜索店铺」）', true); return; }
  const btn = document.getElementById('btn-shop-cate');
  btn.disabled = true; btn.textContent = '获取中…';
  try {
    const isFactory = /factory/i.test(url);
    let cats = [], memberId = '';
    if (isFactory) {
      const t = await bridge.factoryTabs(url);
      if (!t.ok || !t.tabs || !t.tabs.length) { toast('未获取到工厂店分类（确认是工厂店/实力商家链接）', true); return; }
      cats = t.tabs.map(x => ({ id: String(x.id), name: String(x.name).replace(/\(\d+\)$/, ''), count: x.count, parentId: '0' }));
      memberId = t.facMemberId;
    } else {
      const r = await bridge.shopCateMtop(url);
      if (!r.ok || !r.categories) { toast(r.message || '分类获取失败', true); return; }
      cats = r.categories; memberId = r.memberId;
    }
    shopCateData = cats;
    window.__shopMemberId = memberId;
    buildShopCateTree(cats);
    document.getElementById('shop-cate-tree-wrap').style.display = 'block';
    appendCollectLog(`店铺分类获取完毕：${cats.length} 个${isFactory ? '（工厂店）' : ''}（memberId 已缓存）`);
    toast(`已获取 ${cats.length} 个店铺分类，勾选后开始采集`);
  } catch (e) {
    toast('分类获取失败：' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '获取店铺分类>>';
  }
}
// 供应商名称 → 店铺链接（黑鲸鱼 SearchCompany：s.1688.com 公司搜索）
async function searchCompanyBtnClick(btn) {
  const kw = getVal('shop-input').trim();
  if (!kw) { toast('请输入供应商名称', true); return; }
  if (/1688\.com/.test(kw)) { toast('输入的已是店铺链接，无需搜索', true); return; }
  btn.disabled = true; btn.textContent = '搜索中…';
  try {
    const r = await bridge.searchCompany(kw);
    if (r.ok && r.shopUrl) {
      setVal('shop-input', r.shopUrl);
      appendCollectLog(`供应商【${kw}】→ ${r.shopUrl}`);
      toast('已找到店铺：' + r.shopUrl);
    } else {
      toast(r.message || '未查询到该供应商', true);
    }
  } catch (e) {
    toast('搜索失败：' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '搜索店铺';
  }
}
// 过滤词文件（黑鲸鱼 fidderwords.txt + linkLabel1"设置"Process.Start 同款）
function openFilterWords() {
  bridge.auxFile('open', 'filterwords').then(r => {
    if (r && r.ok === false) toast(r.message || '打开失败', true);
    else toast('已打开过滤词文件（一行一个关键词，保存后重新采集生效）');
  });
}
// 清空缓存文件（黑鲸鱼 mButton3：清 searchcache 导出缓存）
function clearSearchCache(btn) {
  armAction(btn, async () => {
    const r = await bridge.auxFile('clear', 'searchcache');
    toast(r.ok ? '清空完毕' : (r.message || '清空失败'), !r.ok);
    appendCollectLog(r.ok ? '已清空导出缓存文件' : '清空失败：' + r.message);
  });
}
// 导出链接.txt（黑鲸鱼 btn_export_txt：全部宝贝链接 + 已导出ID记录 + 导出缓存）
async function exportShopLinks() {
  const list = collected.shop || collected.kw || collected.link || [];
  if (!list.length) { toast('请先采集或查询', true); return; }
  const links = list.map(g => 'https://detail.1688.com/offer/' + g.offerId + (g.isFenxiao ? '.html?sk=consign' : '.html')).join('\n');
  const blob = new Blob([links], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `采集链接_${Date.now()}.txt`;
  a.click();
  try {
    await bridge.auxFile('append', 'exported', list.map(g => g.offerId));
    await bridge.auxFile('append', 'searchcache', { count: list.length, type: '导出链接', ids: list.map(g => g.offerId) });
  } catch (_) {}
  appendCollectLog(`导出链接.txt：${list.length} 条（已记录到已导出ID，勾选「过滤已导出过的链接」后下次自动跳过）`);
  toast(`已导出 ${list.length} 条链接`);
}
// 导出到表格（黑鲸鱼 btn_add_pdd：dt_itemlist 全列导出）
async function exportShopTable() {
  const list = collected.shop || collected.kw || collected.link || [];
  if (!list.length) { toast('请先采集数据', true); return; }
  const cols = [
    ['宝贝ID', g => g.offerId],
    ['宝贝名称', g => g.title],
    ['价格', g => g.price != null ? g.price : ''],
    ['代发价', g => g.consignPrice != null ? g.consignPrice : ''],
    ['30天销量', g => g.thirtySales != null ? g.thirtySales : (g.monthSales || '')],
    ['90天销量', g => g.sales90 != null ? g.sales90 : ''],
    ['月代发订单数', g => (g.advise && g.advise.advise && g.advise.advise['月代发订单数']) || ''],
    ['下游铺货数', g => (g.advise && g.advise.advise && g.advise.advise['下游铺货数']) || ''],
    ['代发品质达标率', g => (g.advise && g.advise.advise && g.advise.advise['代发品质达标率']) || (g.advise && g.advise.advise && g.advise.advise['48小时发货率']) || ''],
    ['代发买家留货率', g => (g.advise && g.advise.advise && g.advise.advise['代发买家留货率']) || (g.advise && g.advise.advise && g.advise.advise['商品退货率']) || ''],
    ['近30天代发数量', g => (g.advise && g.advise.advise && g.advise.advise['近30天代发数量']) || ''],
    ['商家代发热度', g => (g.advise && g.advise.advise && g.advise.advise['商家代发热度']) || ''],
    ['商品发布时间', g => (g.advise && g.advise.advise && g.advise.advise['商品发布时间']) || ''],
    ['商品好评', g => (g.rates && g.rates['商品好评']) || ''],
    ['评论数', g => (g.rates && g.rates['评论数']) || ''],
    ['评价数', g => (g.rates && g.rates['评价数']) || ''],
    ['星级', g => (g.rates && g.rates['星级']) || ''],
    ['货号', g => (g.detail && g.detail.huohao) || ''],
    ['库存', g => (g.detail && g.detail.bookcount) || ''],
    ['起订量', g => (g.detail && g.detail.qdl) || ''],
    ['发货地区', g => (g.detail && g.detail.location) || g.city || ''],
    ['发货时间', g => (g.detail && g.detail.deliveryLimitText) || ''],
    ['运费', g => (g.detail && g.detail.postFeeValue) || ''],
    ['成交额', g => g.gmv || ''],
    ['付款人数', g => g.buyerCount || ''],
    ['宝贝链接', g => 'https://detail.1688.com/offer/' + g.offerId + '.html'],
  ];
  const escCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = '\uFEFF' + [cols.map(c => escCell(c[0])).join(',')].concat(
    list.map(g => cols.map(c => escCell(c[1](g))).join(','))
  ).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `阿里巴巴宝贝列表_${Date.now()}.csv`;
  a.click();
  try {
    await bridge.auxFile('append', 'searchcache', { count: list.length, type: '导出表格', ids: list.map(g => g.offerId) });
  } catch (_) {}
  appendCollectLog(`导出到表格：${list.length} 行 × ${cols.length} 列`);
  toast(`已导出 ${list.length} 行到表格`);
}
// 采集结果右键：复制已勾选商品链接（黑鲸鱼 导出已勾选商品链接ToolStripMenuItem → 剪贴板）
function bindShopContextMenu() {
  const box = document.getElementById('goods-table-link');
  box.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = [...box.querySelectorAll('.g-item.sel')].map(el => +el.dataset.i);
    if (!sel.length) { toast('先勾选要复制的宝贝', true); return; }
    const srcType = (box.querySelector('.g-item') || {}).dataset ? box.querySelector('.g-item').dataset.type : 'link';
    const links = sel.map(i => collected[srcType][i]).filter(Boolean)
      .map(g => 'https://detail.1688.com/offer/' + g.offerId + '.html').join('\n');
    navigator.clipboard.writeText(links).then(() => toast(`已复制 ${sel.length} 条宝贝链接到剪贴板`));
  });
}
bindShopContextMenu();

// 全店采集主流程（黑鲸鱼 btn_caiji_Click 完整移植：多分类翻页 + 列表/详情/参谋三级过滤）
async function doShopCollect() {
  const btn = document.getElementById('btn-shop-collect');
  if (window.__shopCollecting) { window.__shopCollectStop = true; toast('正在停止采集…'); return; }
  const url = getVal('shop-input').trim();
  if (!url) { toast('请输入需要采集的店铺链接', true); return; }
  if (!/1688\.com/.test(url)) { toast('请输入有效的1688店铺链接', true); return; }
  if (url.includes('/offer/')) { toast('当前地址不正确，请放入阿里巴巴店铺的首页地址!', true); return; }

  // ---- 参数（黑鲸鱼控件逐一对应） ----
  const sortSel = getVal('cbb_shopsort') || 'wangpu_score';
  const priceMin = getVal('shop-pricemin') || '';
  const priceMax = getVal('shop-pricemax') || '';
  const yjdf = getChk('shop-fenxiao');
  const quantityBegin = +getVal('shop-quantitybegin') || 0;
  const xl1 = +getVal('shop-xl1') || 0, xl2 = +getVal('shop-xl2') || 0;
  const xl90a = +getVal('shop-xl90a') || 0, xl90b = +getVal('shop-xl90b') || 0;
  const bookcountFilter = +getVal('shop-bookcount') || 0;
  const qpl = +getVal('shop-qpl') || 0;
  const ydxl1 = +getVal('shop-ydxl1') || 0, ydxl2 = +getVal('shop-ydxl2') || 0;
  const maxcount = +getVal('shop-maxcount') || 10000;
  const cbkHuohao = getChk('shop-huohao'), cbkSku = getChk('shop-sku');
  const cbkShip = getChk('shop-shipinfo'), cbkRate = getChk('shop-rate'), cbkSycm = getChk('shop-sycm');
  const filterZdy = getChk('shop-filter-zdy'), filterExported = getChk('shop-filter-exported');

  // 工厂店分支（黑鲸鱼 ShopType=2：URL 含 factory；排序仅支持默认/销量/价格）
  const isFactory = /factory/i.test(url);
  let sortType = sortSel;
  if (isFactory) {
    const map = { wangpu_score: '', tradenumdown: 'va_sales90', priceup: '-price', pricedown: 'price' };
    if (!(sortSel in map)) { toast('该店铺排序条件仅支持【默认、销量、价格】', true); return; }
    sortType = map[sortSel];
  }
  // 勾选分类（黑鲸鱼 getchecknode：未勾选任何分类 = 全部）
  const checkedCats = [...document.querySelectorAll('#shop-cate-tree .sc-node:checked')]
    .filter(c => c.dataset.id !== '0').map(c => String(c.dataset.id));
  const catlist = checkedCats.length ? checkedCats : [''];
  // 过滤词 / 已导出ID（采集前一次性加载）
  if (filterZdy) {
    const t = await bridge.auxFile('read', 'filterwords');
    shopFilterWords = String(t || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } else shopFilterWords = null;
  if (filterExported) {
    const t = await bridge.auxFile('read', 'exported');
    shopExportedIds = Array.isArray(t) ? t : [];
  } else shopExportedIds = null;

  const memberId = window.__shopMemberId || '';
  window.__shopCollecting = true; window.__shopCollectStop = false;
  btn.textContent = '停止';
  const all = new Map();
  let got = 0, filteredN = 0;
  appendCollectLog(`开始采集--【${isFactory ? '工厂店' : '店铺'}】${catlist[0] ? `（勾选 ${catlist.length} 个分类）` : '（全部分类）'}`);

  const matchRange = (v, lo, hi) => v != null && ((lo > 0 && v < lo) || (hi > 0 && v > hi));
  try {
    for (const catId of catlist) {
      if (window.__shopCollectStop) break;
      if (catId) appendCollectLog(`正在采集店铺分类-> ${shopCateData.find(c => c.id === catId)?.name || catId}`);
      let page = 1, offersCount = 0;
      while (true) {
        if (window.__shopCollectStop) break;
        const r = isFactory
          ? await bridge.factoryItems({ shopUrl: url, facMemberId: memberId, tabId: catId || 'all', page, sortType })
          : await bridge.shopItemsMtop({ shopUrl: url, memberId, page, sortType, catId, priceStart: priceMin, priceEnd: priceMax, quantityBegin, tags: yjdf ? '340866' : '' });
        if (!r.ok || !r.items || !r.items.length) break;
        offersCount = r.offerCount || offersCount;
        appendCollectLog(`正在获取第${page}页，共${offersCount}条宝贝`);
        for (const it of r.items) {
          if (window.__shopCollectStop) break;
          if (all.has(it.offerId)) continue;
          // 已导出过滤（黑鲸鱼 cbk_ydc_items）
          if (shopExportedIds && shopExportedIds.includes(String(it.offerId))) {
            appendCollectLog(`该商品【${it.offerId}】在本地电脑上已导出..跳过.`);
            continue;
          }
          // 标题关键词过滤（黑鲸鱼 cbk_filter_zdy）
          if (shopFilterWords && shopFilterWords.length) {
            const t = (it.title || '').toUpperCase();
            if (shopFilterWords.some(w => w && t.includes(w.toUpperCase()))) {
              filteredN++; appendCollectLog(`>>包含过滤词【${it.title}】，已过滤..`);
              continue;
            }
          }
          // 列表级过滤：30天销量 / 90天销量 / 价格兜底
          if (matchRange(it.thirtySales, xl1, xl2)) { filteredN++; appendCollectLog('>>销量不符合要求..已过滤..'); continue; }
          if (matchRange(it.sales90, xl90a, xl90b)) { filteredN++; appendCollectLog('>>90天销量不符合要求..已过滤..'); continue; }
          // 价格单边/双边区间都要生效（工厂店不经服务端筛选，全靠这里兜底）
          if (it.price != null && ((priceMin !== '' && it.price < +priceMin) || (priceMax !== '' && it.price > +priceMax))) {
            filteredN++; appendCollectLog('>>价格不符合要求..已过滤..'); continue;
          }
          // 详情级过滤/补充（黑鲸鱼：qpl 起批量 / bookcount 库存 / 货号 / SKU / 发货信息）
          const needDetail = qpl > 0 || bookcountFilter > 0 || cbkHuohao || cbkSku || cbkShip;
          let detail = null;
          if (needDetail) {
            await sleep(2000 + Math.random() * 2000);
            const d = await bridge.itemDetailLite(it.offerId).catch(e => ({ ok: false, message: e.message }));
            if (d.ok) {
              detail = d;
              if (qpl > 0 && d.qdl && (parseInt(d.qdl, 10) || 0) > qpl) {
                filteredN++; appendCollectLog(`商品ID=${it.offerId}，起订量=${d.qdl}，不符合条件，过滤`);
                continue;
              }
              if (bookcountFilter > 1 && (d.bookcount || 0) < bookcountFilter) {
                filteredN++; appendCollectLog(`商品ID=${it.offerId}，库存=${d.bookcount}，不符合要求，过滤`);
                continue;
              }
            } else {
              appendCollectLog(`详情获取失败（${it.offerId}）：${d.needVerify ? '触发验证码' : d.message}${d.needVerify ? '，稍后重试' : ''}`);
            }
          }
          // 代发参谋数据（黑鲸鱼 cbk_sycm + GetproxyAdvice：月代发订单数区间过滤）
          let advise = null;
          if (cbkSycm) {
            await sleep(3000);
            try {
              const a = await bridge.proxyAdvice(it.offerId, memberId);
              if (a.ok) {
                advise = a;
                const mo = parseInt(String((a.advise && a.advise['月代发订单数']) || '').replace(/以内|\+/g, ''), 10) || 0;
                if (matchRange(mo, ydxl1, ydxl2)) { filteredN++; appendCollectLog('>>代发参谋月销量不符合要求..已过滤..'); continue; }
              }
            } catch (e) { appendCollectLog(`参谋数据失败（${it.offerId}）：${e.message}`); }
          }
          // 好评率（黑鲸鱼 cbk_rate + queryRate：商品好评/按时发货/商品退款）
          let rates = null;
          if (cbkRate) {
            await sleep(2500);
            try {
              const q = await bridge.queryRate({ offerId: it.offerId, loginId: it.sellerLoginId || '', sellerMemberId: memberId });
              if (q.ok) rates = q.rates;
            } catch (e) { appendCollectLog(`好评率获取失败（${it.offerId}）：${e.message}`); }
          }
          all.set(it.offerId, { ...it, detail, advise, rates });
          got++;
          appendCollectLog(`已采集>${it.offerId}(${got}/${maxcount})`);
          if (got % 10 === 0 || got >= maxcount) {
            collected.shop = [...all.values()].map(shopCardItem);
            renderCollected('shop');
          }
          if (got >= maxcount) break;
        }
        if (window.__shopCollectStop || got >= maxcount) break;
        // 翻页终止条件（黑鲸鱼同款：普通店采完 offerCount / 工厂店每页<20条）
        // 注意：普通店按"本分类服务端已扫描条数"判定（每页30条），不能用全局 all.size——
        // 多分类采集时 all.size 含其他分类累计，会提前误终止
        if (isFactory) { if (r.items.length < 20) break; }
        else if (offersCount > 0 && page * 30 >= offersCount) break;
        page++;
        await sleep(4000 + Math.random() * 2000);
      }
      if (got >= maxcount || window.__shopCollectStop) break;
    }
    collected.shop = [...all.values()].map(shopCardItem);
    renderCollected('shop');
    appendCollectLog(`>采集结束：${collected.shop.length} 条（过滤 ${filteredN} 条）`);
    toast(`全店采集完成：${collected.shop.length} 个宝贝`);
  } catch (e) {
    const msg = /FAIL_SYS_USER_VALIDATE|RGV587|被挤爆/i.test(e.message || '')
      ? '1688触发风控验证且未通过，请稍后重试（或降低采集频率、更换采集账号后再试）'
      : e.message;
    toast('全店采集失败：' + msg, true);
    appendCollectLog('全店采集失败：' + msg);
  } finally {
    window.__shopCollecting = false;
    btn.disabled = false; btn.textContent = '开始采集';
  }
}
// 采集结果 → 卡片/导出统一结构（黑鲸鱼 dt_itemlist 行结构）
function shopCardItem(it) {
  return {
    offerId: it.offerId, title: it.title, price: it.price,
    isFenxiao: it.isFenxiao != null ? it.isFenxiao : null,
    img: it.image, monthSales: it.monthSales,
    thirtySales: it.thirtySales != null ? it.thirtySales : null,
    sales90: it.sales90 != null ? it.sales90 : null,
    city: it.city || '', buyerCount: it.buyerCount || '', gmv: it.gmv || '',
    consignPrice: it.consignPrice != null ? it.consignPrice : null,
    detail: it.detail || null, advise: it.advise || null, rates: it.rates || null,
  };
}

/* ============ 采集结果渲染 ============ */
function renderCollected(type) {
  const list = collected[type] || [];
  setText('link-count', `${list.length} 个`);
  const box = document.getElementById('goods-table-link');
  const showPic = type !== 'shop' || getChk('shop-showpic'); // 黑鲸鱼 cbk_show_pic 列表显示主图
  box.innerHTML = list.map((it, i) => `
    <div class="g-item sel" data-type="${type}" data-i="${i}" onclick="toggleGItem(this)">
      ${showPic ? (it.img ? `<img src="${esc(it.img)}" onerror="this.style.visibility='hidden'"/>` : '<img/>') : '<img class="noimg" style="visibility:hidden"/>'}
      <div class="gi-body">
        <div class="gi-title" title="${esc(it.title)}">${esc(it.title || it.offerId)}</div>
        <div class="gi-meta">
          <span class="gi-price">¥${it.price != null ? it.price : '—'}</span>
          ${it.isFenxiao ? '<span class="fx-tag">一件代发</span>' : ''}
          ${it.thirtySales != null ? `<span>30天售${esc(it.thirtySales)}</span>` : (it.monthSales ? `<span>售${esc(it.monthSales)}</span>` : '')}
          ${it.sales90 != null ? `<span>90天${esc(it.sales90)}</span>` : ''}
          ${it.consignPrice != null ? `<span>代发¥${esc(it.consignPrice)}</span>` : ''}
          ${(it.detail && it.detail.qdl) ? `<span>起订${esc(it.detail.qdl)}</span>` : ''}
          ${(it.detail && it.detail.bookcount) ? `<span>库存${esc(it.detail.bookcount)}</span>` : ''}
          ${(it.detail && it.detail.huohao) ? `<span>货号${esc(it.detail.huohao)}</span>` : ''}
          ${(it.city) ? `<span>${esc(it.city)}</span>` : ''}
          ${(it.advise && it.advise.advise && it.advise.advise['月代发订单数']) ? `<span>月代发${esc(it.advise.advise['月代发订单数'])}</span>` : ''}
          ${(it.advise && it.advise.advise && it.advise.advise['商品退货率']) ? `<span>退货${esc(it.advise.advise['商品退货率'])}</span>` : ''}
          ${(it.rates && it.rates['商品好评']) ? `<span>好评${esc(it.rates['商品好评'])}</span>` : ''}
          ${type === 'link' && it.localMain ? `<span>图${it.localMain}张</span>` : ''}
        </div>
      </div>
    </div>`).join('') || '<p class="muted" style="padding:20px">无采集结果</p>';
}
function toggleGItem(el) { el.classList.toggle('sel'); }
function checkAll(type, on) {
  document.querySelectorAll(`#goods-table-link .g-item`).forEach(el => el.classList.toggle('sel', on));
}
async function addCheckedToUpload(type, btn) {
  const box = document.getElementById('goods-table-link');
  const selIdx = [...box.querySelectorAll('.g-item.sel')].map(el => +el.dataset.i);
  const srcType = (box.querySelector('.g-item') || {}).dataset ? box.querySelector('.g-item').dataset.type : 'link';
  if (!selIdx.length) { toast('请先勾选宝贝', true); return; }
  const arr = collected[srcType] || collected[type] || [];
  const items = selIdx.map(i => arr[i]).filter(Boolean);
  if (!items.length) { toast('选中的宝贝数据异常，请重新采集', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = '添加中…'; }
  try {
    // 只存offerId，秒加入上传列表；详情和图片在队列上传时自动补采（与导入链接.txt一致，避免长时间"添加中"）
    const r = await bridge.addToUploadListLite(items.map(it => ({ offerId: it.offerId })));
    toast(r.message || '已添加到上传列表');
    appendCollectLog(`添加 ${items.length} 个宝贝到上传列表（上传时自动采集详情）`);
    refreshTopbar();
    // 添加完成后自动跳转上传页，让用户看到结果
    if (r.added > 0) {
      setTimeout(() => go('upload'), 600);
    }
  } catch (e) {
    toast('添加失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '添加到上传列表'; }
  }
}
function appendCollectLog(msg) {
  const box = document.getElementById('listbox_marklog');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="t">${new Date().toLocaleTimeString('zh-CN')}</span> ${esc(msg)}`;
  box.appendChild(div);
  if (box.children.length > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ============ 上传列表（tab-upload） ============ */
async function loadUploadList() {
  const r = await bridge.listGoods({ status: '', keyword: '', page: ulPageNum, pageSize: 100 });
  document.getElementById('upload-list').innerHTML = `
    <table class="ultable">
      <thead><tr>
        <th style="width:30px"><input type="checkbox" onchange="ulSelectAll(this)" /></th>
        <th style="width:52px">图片</th><th>标题</th><th style="width:80px">源价</th>
        <th style="width:86px">售价</th><th style="width:52px">代发</th>
        <th style="width:110px">状态</th><th style="width:150px">操作/错误</th>
      </tr></thead>
      <tbody>${r.items.map(g => {
        const raw = g.raw || {};
        const img = (raw.mainImages && raw.mainImages[0]) || '';
        const dupTag = g.dupItemId ? `<span class="dup-tag" title="查重命中：店铺已发布商品 ${g.dupItemId}${g.dupSource ? '（' + g.dupSource + '）' : ''}">已铺货 ${g.dupItemId}</span>` : '';
        return `<tr${g.dupItemId ? ' class="row-dup"' : ''}>
          <td><input type="checkbox" class="ul-check" value="${g.id}" /></td>
          <td>${img ? `<img class="ul-img" src="${esc(img)}" onerror="this.style.visibility='hidden'"/>` : ''}</td>
          <td class="t-cell" title="${esc(g.title)}">${esc(g.title)}</td>
          <td>${raw.price != null ? '¥' + raw.price : '—'}</td>
          <td><input class="sellprice-input" value="${g.sellPrice != null ? g.sellPrice : ''}" placeholder="按配置" onchange="savePrice('${g.id}', this.value)" /></td>
          <td>${raw.isFenxiao === true ? '<span class="fx-tag">代发</span>' : '—'}</td>
          <td class="st-${g.status}">${statusName(g.status)}${dupTag}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn small" onclick="testPublish('${g.id}')">调试</button>
              <button class="btn small danger" onclick="delGoods('${g.id}', this)">删</button>
            </div>
            ${g.error ? `<div class="err-cell" title="${esc(g.error)}">${esc(g.error)}</div>` : ''}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--sub);padding:30px">上传列表为空，先去采集宝贝</td></tr>'}</tbody>
    </table>`;
  refreshTopbar();
  // 查重汇总（全量统计，不限当前页）
  try {
    const all = await bridge.listGoods({ status: '', keyword: '', page: 1, pageSize: 500 });
    const dupN = all.items.filter(g => g.dupItemId).length;
    if (_dupSummary && _dupSummary.checkedAt) {
      setText('dup-summary', `查重(${_dupSummary.source}) ${_dupSummary.dupCount} 个重复，已标记 ${dupN} 个（${fmtTime(_dupSummary.checkedAt)}）`);
    } else {
      setText('dup-summary', dupN ? `已标记重复 ${dupN} 个（点「移除重复」清理）` : '');
    }
  } catch (_) {}
}
function statusName(s) { return { pending: '待上传', queued: '排队中', publishing: '上传中', published: '已上传', failed: '失败', skipped: '已跳过' }[s] || s; }
function ulSelectAll(cb) { document.querySelectorAll('.ul-check').forEach(c => c.checked = cb.checked); }
// 用户手动改价：打 sellPriceManual 标记（补采后不覆盖手动价）；清空则恢复自动计算
async function savePrice(id, v) { await bridge.updateGoods(id, { sellPrice: v === '' ? null : +v, sellPriceManual: v !== '' }); }
function delGoods(id, btn) {
  armAction(btn, async () => {
    await bridge.removeGoods(id);
    loadUploadList();
    toast('已删除该宝贝记录');
  });
}
async function removeSelectedGoods() {
  const ids = [...document.querySelectorAll('.ul-check:checked')].map(c => c.value);
  if (!ids.length) { toast('先勾选要移除的宝贝', true); return; }
  for (const id of ids) await bridge.removeGoods(id);
  toast(`已移除 ${ids.length} 个`);
  loadUploadList();
}
async function removeUploadedGoods(which, btn) {
  const st = which === 'ok' ? 'published' : 'failed';
  const r = await bridge.listGoods({ status: st, pageSize: 500, page: 1 });
  if (!r.items.length) { toast(which === 'ok' ? '无已上传宝贝' : '无失败宝贝'); return; }
  armAction(btn, async () => {
    for (const g of r.items) await bridge.removeGoods(g.id);
    toast(`已移除 ${r.items.length} 个`);
    loadUploadList();
  });
  toast(`检测到 ${r.items.length} 个${which === 'ok' ? '成功' : '失败'}宝贝，再点一次按钮确认移除`);
}
function mButton3Click(btn) {
  armAction(btn, async () => {
    // 全部状态都要清（含 skipped 跳过、publishing 中断遗留）
    for (const s of ['pending', 'failed', 'published', 'queued', 'skipped', 'publishing']) {
      await bridge.clearGoods(s);
    }
    toast('已清空上传列表');
    setTimeout(loadUploadList, 500);
  });
}

/* ============ 查重（卖家中心 1688铺货商品 + 在售商家编码双数据源） ============ */
let _dupSummary = null;
async function doDupCheck(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '查重中…'; }
  try {
const r = await bridge.dupCheck();
    if (!r.ok) { toast(r.message || '查重失败', true); return; }
    _dupSummary = r;
    toast(`查重完成：${r.sourceMsg}，命中重复 ${r.dupCount} 个（已在列表标记）`, r.dupCount === 0);
    await loadUploadList();
  } catch (e) {
    toast('查重失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '查重（1688铺货）'; }
  }
}
function removeDupGoods(btn) {
  bridge.listGoods({ status: '', keyword: '', page: 1, pageSize: 500 }).then(async (r) => {
    const dups = r.items.filter(g => g.dupItemId);
    if (!dups.length) { toast('当前没有重复标记的宝贝'); return; }
    armAction(btn, async () => {
      for (const g of dups) await bridge.removeGoods(g.id);
      toast(`已移除 ${dups.length} 个重复宝贝`);
      setText('dup-summary', '');
      await loadUploadList();
    });
    toast(`检测到 ${dups.length} 个重复宝贝，再点一次确认移除`);
  });
}
function dupResetMarks(btn) {
  armAction(btn, async () => {
    const r = await bridge.dupReset();
    toast(`已清除 ${r.cleared} 个重复标记`);
    setText('dup-summary', '');
    await loadUploadList();
  });
  toast('再点一次确认清除全部重复标记');
}
function exportLink(which) {
  bridge.listGoods({ status: which === 1 ? 'published' : which === 2 ? 'pending' : 'failed', pageSize: 500, page: 1 }).then(r => {
    const links = r.items.map(g => `https://detail.1688.com/offer/${g.offerId}.html`).join('\n');
    if (!links) { toast('无链接可导出', true); return; }
    const blob = new Blob([links], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${which === 1 ? '上传成功' : which === 2 ? '未上传' : '失败'}链接_${Date.now()}.txt`;
    a.click();
  });
}
async function downloadItemImgs(btn) {
  const ids = [...document.querySelectorAll('.ul-check:checked')].map(c => c.value);
  if (!ids.length) { toast('先勾选要下载图片的宝贝（本地已有图的会自动跳过）', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = '下载图片…'; }
  const logBox = document.getElementById('upload-log-box');
  try {
    if (logBox) appendLog(logBox, { level: 'info', tag: '图片', message: `开始补下载 ${ids.length} 个宝贝的图片…` });
    const r = await bridge.ensureImages(ids);
    const msg = `图片下载完成：新下载 ${r.done} 个，已有图跳过 ${r.skipped} 个${r.failed.length ? '，失败 ' + r.failed.length + ' 个' : ''}`;
    toast(msg, r.failed.length > 0);
    if (logBox) appendLog(logBox, { level: r.failed.length ? 'warn' : 'ok', tag: '图片', message: msg });
    loadUploadList();
  } catch (e) {
    toast('下载失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '下载宝贝图片'; }
  }
}

/* ============ 上传启动 ============ */
async function startUploadSelected() {
  const ids = [...document.querySelectorAll('.ul-check:checked')].map(c => c.value);
  if (!ids.length) { toast('先勾选要上传的宝贝', true); return; }
  const stats = await bridge.queueStats();
  if (stats.running) { toast('队列正在运行中，请等待完成或暂停后重试', true); return; }
  const r1 = await bridge.addQueue(ids);
  const r2 = await bridge.startQueue();
  toast(`已加入队列 ${r1.added} 个，${r2.ok ? '上传已开始' : (r2.message || '启动失败')}`, !r2.ok);
  loadUploadList();
}
async function startUploadQuick() {
  go('upload');
  const r = await bridge.queueStats();
  if (r.running) { toast('队列正在运行中，请等待完成或暂停后重试', true); return; }
  // 取待上传、失败待重试、以及异常卡在排队中的商品（上次程序被关闭时遗留）
  const [pending, failed, queued] = await Promise.all([
    bridge.listGoods({ status: 'pending', pageSize: 500, page: 1 }),
    bridge.listGoods({ status: 'failed', pageSize: 500, page: 1 }),
    bridge.listGoods({ status: 'queued', pageSize: 500, page: 1 }),
  ]);
  const addIds = [...pending.items.map(g => g.id), ...failed.items.map(g => g.id)];
  if (addIds.length) {
    await bridge.addQueue(addIds);
  }
  // queued 商品无需重复入队，队列启动后会自动捞取
  if (addIds.length || queued.items.length) {
    await bridge.startQueue();
    toast(`上传开始（新增${addIds.length}个 + 排队中${queued.items.length}个）`);
    loadUploadList();
  } else {
    toast('上传列表为空，先去采集');
  }
}
async function testPublish(id) {
  toast('调试模式：填好整个表单但不提交');
  const r = await bridge.testPublish(id);
  toast(r.ok ? '调试完成（详情看日志）' : '调试失败：' + (r.error || ''), !r.ok);
}

/* ============ 上传设置/图片设置：配置读写（黑鲸鱼控件1:1绑定） ============ */
// 门店列表（黑鲸鱼 chkSdShop_CheckedChanged → GetShopStore → selStore 下拉）
async function loadShopStores(silent) {
  const sel = document.getElementById('selStore');
  if (!getChk('chkSdShop')) { sel.disabled = true; sel.innerHTML = '<option value="">勾选后加载门店</option>'; return; }
  sel.disabled = true; sel.innerHTML = '<option value="">加载中…</option>';
  try {
    const r = await bridge.shopStores();
    if (!r.ok || !r.stores || !r.stores.length) {
      sel.innerHTML = '<option value="">' + esc(r.message || '未获取到门店（需商家账号且已开通线下门店）') + '</option>';
      if (!silent) toast(r.message || '未获取到门店', true);
      return;
    }
    sel.innerHTML = r.stores.map(s => `<option value="${esc(s.storeId)}">${esc(s.name)}</option>`).join('');
    sel.disabled = false;
    toast(`已载入 ${r.stores.length} 个门店`);
  } catch (e) {
    sel.innerHTML = '<option value="">加载失败</option>';
    if (!silent) toast('门店加载失败：' + e.message, true);
  }
}

async function loadUploadConfig() {
  const c = await bridge.getConfig();
  const up = c.upset || {}, im = c.imgset || {};
  // 基础上传选项
  setVal('cbb_UploadWay', up.uploadWay != null ? String(up.uploadWay) : '2');
  setVal('dtp_PutawayTime', up.putawayTime || '');
  setVal('txt_UpawayInterval', up.upawayInterval != null ? up.upawayInterval : 30);
  setVal('txtJgMinute', up.jgMinute != null ? up.jgMinute : 0);
  setChk('cb_PriceDeal', up.priceDeal);
  setVal('cbb_PriceSource', up.priceSource != null ? String(up.priceSource) : '0');
  setVal('txt_AddNum', up.addNum != null ? up.addNum : '');
  setVal('txt_Multiplier1', up.multiplier != null ? up.multiplier : 1);
  setChk('chkMinPrice', up.minPrice);
  setVal('txt_AddNumMin', up.addNumMin != null ? up.addNumMin : '');
  setVal('cmbMinPriceSku', up.minPriceSku != null ? String(up.minPriceSku) : '0');
  setVal('txtkucun', up.stock != null ? up.stock : 99);
  setVal('txtminskukc', up.minSkuKc != null ? up.minSkuKc : 0);
  setVal('cmbStock', up.stockType != null ? String(up.stockType) : '1');
  setVal('txtBrand', up.brand || '');
  setChk('cb_BrandIsOther', up.brandOther !== false);
  setChk('cb_BrandIsNoBrand', up.brandNoBrand);
  setChk('cb_UploadToClassfy', up.uploadClassfy);
  if (up.uploadClassfyId) { const s = document.getElementById('cbb_UploadToClassfy'); if (s) { s.dataset.cur = up.uploadClassfyId; try { s.value = up.uploadClassfyId; } catch (_) {} } }
  setChk('mCheckBox1', up.autoDateCat);
  setChk('cb_Title', up.titleRebuild);
  setChk('cbk_filter_title', up.filterTitle);
  setChk('chkRadHh', up.randHh);
  setChk('chk7DayBack', up.day7 !== false);
  setChk('chkBackR', up.backR);
  setVal('cmbTwoItem', up.twoItem || '0');
  setVal('cmbCustomItem', up.customItem || '0');
  setVal('txtBarCode', up.barCode || '');
  setChk('chkFilterNoFreePost', up.filterNoFreePost);
  setChk('chkDownItem', up.filterDownItem);
  setChk('chkPriceToOne', up.priceToOne);
  setChk('chkMultiDiscount', up.multiDiscount);
  setVal('cmbMultiDiscount', up.multiDiscountVal != null ? String(up.multiDiscountVal) : '9.5');
  syncMultiDiscount();
  // 生成推荐尺码表 + 启用自定义过滤 + 导购标题（黑鲸鱼 chkSizeTableTj / cb_LocalDiyFilter / TitleToShop+DgTitle）
  setChk('chkSizeTableTj', up.sizeTableTj);
  setChk('cb_LocalDiyFilter', up.localDiyFilter !== false);
  setVal('cbb_DgTitle', up.titleToShop != null ? String(up.titleToShop) : '0');
  setVal('txt_DgTitle', up.dgTitle || '');
  syncDgTitleInput();
  // 商家编码（advanced.merchantCode：offerId=上家宝贝ID | none=不添加）
  try {
    const adv = c.advanced || {};
    setVal('cbb_MerchantCode', adv.merchantCode === 'none' ? 'none' : 'offerId');
  } catch (_) { setVal('cbb_MerchantCode', 'offerId'); }
  setChk('chkSizeTable', up.sizeTable);
  setChk('chkTranslateTitle', up.translateTitle);
  setChk('chkRaiseService', up.raiseService);
  setChk('chkNoLastDisc', up.noLastDisc);
  setChk('chkSdShop', up.sdShop);
  // AI推荐开关
  setChk('chkAiRecommend', up.aiRecommend);
  // 子Tab：标题
  setVal('txtTitleFilter', up.titleFilter || '');
  setVal('txtTitleClear', up.titleClear || '');
  setVal('txtTitleReplaceKeyword', up.titleReplace || '');
  setVal('txtCustomTitle', up.customTitle || '');
  setVal('txtTitlePreKeyword', up.titlePre || '');
  setVal('txtTitleSuffixKeyword', up.titleSuffix || '');
  setVal('txtDescClearWord', up.descClear || '');
  setVal('txt_IgnoreUid', up.ignoreUid || '');
  setVal('txt_IgnoreBrand', up.ignoreBrand || '');
  setVal('txt_filter_img', up.filterImg || '');
  // 子Tab：类目
  setChk('rab_categroy_default', up.categoryMode !== 'self');
  setChk('rab_categroy_self', up.categoryMode === 'self');
  setVal('txt_category_key', up.categoryKey || '');
  // 回填已选上传类目（下拉可能只有"请先查询"占位，缺选项时补一个）
  const catSel = document.getElementById('cbb_cagegorylist');
  if (catSel) {
    if (up.categoryId) {
      if (![...catSel.options].some(o => o.value === String(up.categoryId))) {
        catSel.insertAdjacentHTML('beforeend',
          `<option value="${esc(String(up.categoryId))}">${esc(up.categoryName || (up.categoryKey + ' (' + up.categoryId + ')'))}</option>`);
      }
      catSel.value = String(up.categoryId);
    } else if (!catSel.options.length) {
      catSel.innerHTML = '<option value="">未查询（点"查询类目"）</option>';
    }
  }
  // 子Tab：属性
  setVal('txtProps', up.props || '');
  setVal('txtPropsChange', up.propsChange || '');
  setVal('txtPropsLack', up.propsLack || '');
  setVal('txtPropsReplaceKey', up.propsReplace || '');
  setVal('txtPropsFilterKey', up.propsFilter || '');
  setVal('txtPropsClearKey', up.propsClear || '');
  // 子Tab：运费
  setChk('chk_copy_TransMode1', up.transMode !== '2' && up.transMode !== '3');
  setChk('chk_copy_TransMode2', up.transMode === '2');
  setChk('chk_copy_TransMode3', up.transMode === '3');
  setVal('cmbDeliveryTime', up.deliveryTime || '');
  setVal('txtPostWeight', up.postWeight != null ? up.postWeight : 1);
  setVal('cmbDgSendCity', up.dgSendCity || '');
  setVal('cmbDgSendCountry', up.dgSendCountry || '');
  // 适用商户门店 + 定时启动（黑鲸鱼 chkSdShop/selStore + TimerTask）
  setChk('chkSdShop', !!up.sdShop);
  setVal('txtAutoStartTime', up.autoStartTime || '');
  if (up.sdShop && up.shopStoreId) loadShopStores(true).then(() => setVal('selStore', String(up.shopStoreId)));
  // 子Tab：SKU
  setChk('chkFilterSkuPriceGt', up.skuFilterPriceGt);
  setVal('txtFilterSkuPriceMax', up.skuFilterPriceMax || '');
  setChk('chkFilterSkuPriceLt', up.skuFilterPriceLt);
  setVal('txtFilterSkuPriceMin', up.skuFilterPriceMin || '');
  setChk('chkFilterNoStockSku', up.skuFilterNoStock);
  setChk('chkFilterNoImgSku', up.skuFilterNoImg);
  setVal('txtFilterSkuWord', up.filterSkuWord || '');
  setVal('txtSkuNum', up.skuNum != null ? up.skuNum : 0);
  setChk('cmbCustomSku', up.customSkuLimit);
  setChk('chkAddNoSku', up.addNoSku);
  setChk('chkAddNoSku1', up.addNoSku1);
  setChk('chkCustomSkuMode', up.customSkuMode);
  setChk('cmbSkuParam', up.skuParam);
  setVal('txtAddSku', up.addSku || '');
  setVal('txtSkuReplaceWord', up.skuReplaceWord || '');
  setVal('txtSkuRandomWord', up.skuRandomWord || '');
  setVal('txt_1688sku', up.sku1688 || '');
  setVal('txtSkuMerge', up.skuMerge || '');
  setVal('cbb_DecimalMode1', up.decimalMode != null ? String(up.decimalMode) : '0');
  setVal('cbb_Ysf1', up.ysf1 != null ? String(up.ysf1) : '0');
  // 图片设置
  setVal('cmbMainImg', up.mainImgSource != null ? String(up.mainImgSource) : '0');
  setVal('cmbSqImg', im.sqImg || '800*800');
  setChk('chkVerImg', im.verImg !== false);
  setChk('chkUploadVideo', im.uploadVideo !== false);
  setChk('cb_UploadSkuImg', im.uploadSkuImg !== false);
  setChk('cb_SkuImgDeal', im.skuImgDeal);
  setChk('chkSkuSq800', im.skuSq800 !== false);
  setChk('cb_ItemCopyAutoDeal', im.mainFlip);
  setChk('cb_ItemCopyAutoDealDesc', im.descFlip);
  setChk('chkRadImg', im.randImg);
  setChk('chkBqQsImg', im.bqQsImg !== false);
  setVal('cmbProtectImg', im.protectImg || '0');
  setChk('chkNoPcDesc', im.noPcDesc);
  setChk('chkUseWlDesc', im.useWlDesc !== false);
  setChk('chkNoWlDesc', im.noWlDesc);
  setChk('chkCustomDesc', im.customDesc);
  setChk('cb_AddTopButtomToDetail', im.addTopButtom);
  setChk('chkRemoveA', im.removeA);
  setChk('cb_OnlyItemCopy', im.onlyImg);
  setVal('txt_DetailItemCopyNum', im.keepImgs != null ? im.keepImgs : 100);
  setVal('txtRemoveDescImgA', im.removeA_ != null ? im.removeA_ : 0);
  setVal('txtRemoveDescImgB', im.removeB_ != null ? im.removeB_ : 0);
  setChk('cbk_mainadddesc', im.mainAddDesc);
  setChk('chkMegerImage', im.mergeImg);
  setChk('cmbDescImgSplit', im.imgSplit);
  setVal('cmbDescVer', im.descVer != null ? String(im.descVer) : '1');
  setVal('cbb_HideLink', im.hideLink || '0');
  setVal('txt_DiyDetailHead', im.headImg || '');
  setVal('txt_DiyDetailButtom', im.buttomImg || '');
  setVal('txtPicDirName', im.picDir || '铺货助手');
  setChk('chkIsCompress', im.compress);
  setVal('cmbCompress', im.compressRate || '80');
  setVal('cmbWaterRemark', im.water || '0');
  setChk('chkAuditPic', im.auditPic);
  setVal('txtNxImg', im.nxImg || '');
  setChk('chkFileNameAddId', im.fileNameAddId);
  // 上传宝贝Tab
  setChk('chkAutoVerify', up.autoVerify !== false);
  setChk('chkFailSaveDraft', up.failSaveDraft !== false);
  setChk('chkClearDraft', up.clearDraft);
  setChk('chkSkipItem', up.skipItem !== false);
  setChk('chkFission', up.fission);
  setChk('chk2to1', up.two2one);
  setVal('txtIntervalSec', up.intervalSec != null ? up.intervalSec : 30);
  setVal('txtIntervalPic', up.intervalPic != null ? up.intervalPic : 0);
  setVal('txtTodayLimit', up.todayLimit != null ? up.todayLimit : 0);
  // 运费模板（店铺后台同步：兼容旧字符串数组与新版 {name,id} 对象）
  const info = await bridge.sellerInfo().catch(() => null);
  const ship = (info && info.shipTemplates) || [];
  const tplSel = document.getElementById('cbb_TransMode');
  if (tplSel) {
    const cur = up.shipTemplate || tplSel.dataset.cur || '';
    tplSel.innerHTML = '<option value="">不指定（自动选第一个模板）</option>' + ship.map(t => `<option value="${esc(t.name != null ? t.name : t)}">${esc(t.name != null ? t.name : t)}</option>`).join('');
    tplSel.value = cur; tplSel.dataset.cur = cur;
  }
  refreshTopbar();
}
async function saveUploadConfig() {
  const uploadWay = +getVal('cbb_UploadWay') || 0;
  let prevImgset = {};
  try { prevImgset = ((await bridge.getConfig()) || {}).imgset || {}; } catch (_) {}
  await bridge.saveConfig({
    upset: {
      uploadWay, putawayTime: getVal('dtp_PutawayTime'), upawayInterval: +getVal('txt_UpawayInterval') || 30, jgMinute: +getVal('txtJgMinute') || 0,
      priceDeal: getChk('cb_PriceDeal'), priceSource: +getVal('cbb_PriceSource'), addNum: +getVal('txt_AddNum') || 0,
      multiplier: +getVal('txt_Multiplier1') || 1, minPrice: getChk('chkMinPrice'), addNumMin: +getVal('txt_AddNumMin') || 0, minPriceSku: +getVal('cmbMinPriceSku'),
      stock: +getVal('txtkucun') || 99, minSkuKc: +getVal('txtminskukc') || 0, stockType: +getVal('cmbStock'),
      brand: getVal('txtBrand').trim(), brandOther: getChk('cb_BrandIsOther'), brandNoBrand: getChk('cb_BrandIsNoBrand'),
      uploadClassfy: getChk('cb_UploadToClassfy'), uploadClassfyId: getVal('cbb_UploadToClassfy'), autoDateCat: getChk('mCheckBox1'),
      titleRebuild: getChk('cb_Title'), filterTitle: getChk('cbk_filter_title'), randHh: getChk('chkRadHh'),
      day7: getChk('chk7DayBack'), backR: getChk('chkBackR'), twoItem: +getVal('cmbTwoItem'), customItem: +getVal('cmbCustomItem'), barCode: getVal('txtBarCode').trim(),
      filterNoFreePost: getChk('chkFilterNoFreePost'), filterDownItem: getChk('chkDownItem'), priceToOne: getChk('chkPriceToOne'),
      multiDiscount: getChk('chkMultiDiscount'), multiDiscountVal: +getVal('cmbMultiDiscount') || 9.5, sizeTable: getChk('chkSizeTable'), sizeTableTj: getChk('chkSizeTableTj'), translateTitle: getChk('chkTranslateTitle'),
      localDiyFilter: getChk('cb_LocalDiyFilter'), titleToShop: +getVal('cbb_DgTitle') || 0, dgTitle: getVal('txt_DgTitle').trim(),
      raiseService: getChk('chkRaiseService'), noLastDisc: getChk('chkNoLastDisc'), sdShop: getChk('chkSdShop'),
      titleFilter: getVal('txtTitleFilter'), titleClear: getVal('txtTitleClear'), titleReplace: getVal('txtTitleReplaceKeyword'),
      customTitle: getVal('txtCustomTitle'), titlePre: getVal('txtTitlePreKeyword'), titleSuffix: getVal('txtTitleSuffixKeyword'), descClear: getVal('txtDescClearWord'),
      ignoreUid: getVal('txt_IgnoreUid'), ignoreBrand: getVal('txt_IgnoreBrand'), filterImg: getVal('txt_filter_img'),
      categoryMode: getChk('rab_categroy_self') ? 'self' : 'default',
      categoryKey: getVal('txt_category_key'),
      categoryId: getVal('cbb_cagegorylist'),
      categoryName: (document.getElementById('cbb_cagegorylist') || {}).selectedOptions
        ? ((document.getElementById('cbb_cagegorylist').selectedOptions[0] || {}).textContent || '') : '',
      props: getVal('txtProps'), propsChange: getVal('txtPropsChange'), propsLack: getVal('txtPropsLack'),
      propsReplace: getVal('txtPropsReplaceKey'), propsFilter: getVal('txtPropsFilterKey'), propsClear: getVal('txtPropsClearKey'),
      transMode: getChk('chk_copy_TransMode2') ? '2' : (getChk('chk_copy_TransMode3') ? '3' : '1'),
      shipTemplate: getVal('cbb_TransMode'), deliveryTime: getVal('cmbDeliveryTime'), postWeight: +getVal('txtPostWeight') || 0,
      dgSendCity: getVal('cmbDgSendCity'), dgSendCountry: getVal('cmbDgSendCountry'),
      sdShop: getChk('chkSdShop'), shopStoreId: getVal('selStore') || '',
      autoStartTime: getVal('txtAutoStartTime').trim(),
      skuFilterPriceGt: getChk('chkFilterSkuPriceGt'), skuFilterPriceMax: +getVal('txtFilterSkuPriceMax') || 0,
      skuFilterPriceLt: getChk('chkFilterSkuPriceLt'), skuFilterPriceMin: +getVal('txtFilterSkuPriceMin') || 0,
      skuFilterNoStock: getChk('chkFilterNoStockSku'), skuFilterNoImg: getChk('chkFilterNoImgSku'), filterSkuWord: getVal('txtFilterSkuWord'),
      skuNum: +getVal('txtSkuNum') || 0, customSkuLimit: getChk('cmbCustomSku'),
      addNoSku: getChk('chkAddNoSku'), addNoSku1: getChk('chkAddNoSku1'), customSkuMode: getChk('chkCustomSkuMode'), skuParam: getChk('cmbSkuParam'),
      addSku: getVal('txtAddSku'), skuReplaceWord: getVal('txtSkuReplaceWord'), skuRandomWord: getVal('txtSkuRandomWord'),
      sku1688: getVal('txt_1688sku'), skuMerge: getVal('txtSkuMerge'), decimalMode: +getVal('cbb_DecimalMode1'), ysf1: +getVal('cbb_Ysf1'),
      mainImgSource: +getVal('cmbMainImg'),
      autoVerify: getChk('chkAutoVerify'), failSaveDraft: getChk('chkFailSaveDraft'), clearDraft: getChk('chkClearDraft'),
      skipItem: getChk('chkSkipItem'), fission: getChk('chkFission'), two2one: getChk('chk2to1'),
      intervalSec: +getVal('txtIntervalSec') || 30, intervalPic: +getVal('txtIntervalPic') || 0, todayLimit: +getVal('txtTodayLimit') || 0,
      aiRecommend: getChk('chkAiRecommend'),
    },
    imgset: {
      sqImg: getVal('cmbSqImg'), verImg: getChk('chkVerImg'), uploadVideo: getChk('chkUploadVideo'),
      uploadSkuImg: getChk('cb_UploadSkuImg'), skuImgDeal: getChk('cb_SkuImgDeal'), skuSq800: getChk('chkSkuSq800'),
      mainFlip: getChk('cb_ItemCopyAutoDeal'), descFlip: getChk('cb_ItemCopyAutoDealDesc'), randImg: getChk('chkRadImg'),
      bqQsImg: getChk('chkBqQsImg'), protectImg: getVal('cmbProtectImg'),
      noPcDesc: getChk('chkNoPcDesc'), useWlDesc: getChk('chkUseWlDesc'), noWlDesc: getChk('chkNoWlDesc'),
      customDesc: getChk('chkCustomDesc'), addTopButtom: getChk('cb_AddTopButtomToDetail'), removeA: getChk('chkRemoveA'),
      onlyImg: getChk('cb_OnlyItemCopy'), keepImgs: +getVal('txt_DetailItemCopyNum') || 100,
      removeA_: +getVal('txtRemoveDescImgA') || 0, removeB_: +getVal('txtRemoveDescImgB') || 0,
      mainAddDesc: getChk('cbk_mainadddesc'), mergeImg: getChk('chkMegerImage'), imgSplit: getChk('cmbDescImgSplit'),
      descVer: +getVal('cmbDescVer'), hideLink: getVal('cbb_HideLink'), headImg: getVal('txt_DiyDetailHead'), buttomImg: getVal('txt_DiyDetailButtom'),
      picDir: getVal('txtPicDirName'), compress: getChk('chkIsCompress'), compressRate: getVal('cmbCompress'),
      water: getVal('cmbWaterRemark'), waterText: prevImgset.waterText || '', auditPic: getChk('chkAuditPic'), nxImg: getVal('txtNxImg'), fileNameAddId: getChk('chkFileNameAddId'),
    },
    // 兼容旧字段（publisher 读取）；上传方式修复：0=立即上架(shelf) 1=定时上架(timed) 2=放入仓库(warehouse)
    template: {
      stock: +getVal('txtkucun') || 99,
      shipTemplate: getVal('cbb_TransMode'),
      sevenDayReturn: getChk('chk7DayBack'),
    },
    advanced: {
      uploadMode: ['shelf', 'timed', 'warehouse'][uploadWay] || 'warehouse',
      merchantCode: getVal('cbb_MerchantCode') || 'offerId',
    },
  });
  toast('配置已保存');
}

/* ============ 上传记录 ============ */
async function loadRecords() {
  const srcId = getVal('rec-src-id').trim(), newId = getVal('rec-new-id').trim();
  const r = await bridge.getRecords(200);
  let items = r.items || [];
  if (srcId) items = items.filter(x => String(x.offerId).includes(srcId));
  if (newId) items = items.filter(x => String(x.itemId || '').includes(newId));
  const ok = items.filter(x => x.ok).length;
  document.getElementById('records-table').innerHTML = `
    <div class="rec-summary">共 ${items.length} 条 · 成功 ${ok} · 失败 ${items.length - ok}</div>
    <table class="ultable">
      <thead><tr><th style="width:150px">时间</th><th>标题</th><th style="width:60px">结果</th><th>新商品/错误</th><th style="width:90px">操作</th></tr></thead>
      <tbody>${items.map(rec => `
        <tr>
          <td>${fmtTime(rec.at)}</td>
          <td class="t-cell" title="${esc(rec.title)}">${esc(rec.title || rec.offerId)}</td>
          <td>${rec.ok ? '<span class="st-published">成功</span>' : '<span class="st-failed">失败</span>'}</td>
          <td class="err-cell">${rec.ok ? (rec.itemUrl ? `<a href="#" onclick="event.preventDefault();window.open('${esc(rec.itemUrl)}')">查看宝贝</a>` : esc(rec.itemId || '')) : esc(rec.error || '')}</td>
          <td>${!rec.ok ? `<button class="btn small" onclick="retryFailed('${rec.goodsId}')">重新上传</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--sub);padding:30px">暂无上传记录</td></tr>'}</tbody>
    </table>`;
}
async function retryFailed(goodsId) {
  if (!goodsId) return;
  await bridge.addQueue([goodsId]);
  await bridge.startQueue();
  toast('已重新加入队列');
}

/* ============ 店铺账号 ============ */
async function loginShopBtnClick() {
  const list = await bridge.listAccounts();
  let shop = list.find(a => a.type === 'shop');
  if (!shop) shop = await bridge.addAccount('shop', '我的店铺');
  toast('已打开登录窗口，请用手机淘宝扫码（成功自动关闭）');
  const r = await bridge.loginAccount(shop.id);
  toast(r.message, !r.ok);
  refreshTopbar();
}
async function openShopWorkbench() {
  const r = await bridge.openWorkbench();
  if (!r.ok) toast(r.message, true);
}

/* ============ 采集账号管理（1688 多账号轮换） ============ */
async function openCollectAccountManager() {
  const accs = await bridge.listAccounts();
  const collect = accs.filter(a => a.type === 'collect');
  const rows = collect.length ? collect.map(a => {
    const st = a.status === 'ok' ? '<span class="st-published">已登录</span>'
      : a.status === 'expired' ? '<span class="st-failed">已过期</span>'
      : '<span class="st-pending">未登录</span>';
    const cred = a.username ? `<span class="muted">${esc(a.username)}</span>` : '';
    const last = a.lastLoginAt ? fmtTime(a.lastLoginAt) : '';
    return `<div class="acc-row" data-id="${esc(a.id)}">
      <span class="acc-name">${esc(a.name || '采集账号')} ${cred}</span>
      <span class="acc-status">${st} ${last ? `· ${last}` : ''}</span>
      <span class="acc-ops">
        <button class="btn small" onclick="loginCollectAccount('${esc(a.id)}')">登录</button>
        <button class="btn small" onclick="checkCollectAccount('${esc(a.id)}')">检测</button>
        <button class="btn small danger" onclick="removeCollectAccount('${esc(a.id)}')">删除</button>
      </span>
    </div>`;
  }).join('')
    : '<div class="acc-empty">暂无采集账号，点击下方"添加采集账号"扫码登录</div>';
  const html = `<div class="acc-manager">
    <div class="acc-manager-head">
      <b>1688 采集账号（可多个，采集时轮换使用降低风控）</b>
      <span class="flex-spacer"></span>
      <button class="btn small" onclick="closeAccManager()">关闭</button>
    </div>
    <div class="acc-list">${rows}</div>
    <div class="acc-manager-foot">
      <button class="btn primary" onclick="addCollectAccount()">添加采集账号并登录</button>
      <span class="tip-line">登录后自动识别旺旺号/店铺名；多个账号自动轮换</span>
    </div>
  </div>`;
  const box = document.createElement('div');
  box.id = 'acc-manager-box';
  box.style.cssText = 'position:fixed;top:80px;right:16px;z-index:900;width:480px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.2);padding:14px 16px;font-size:13px';
  box.innerHTML = html;
  document.body.appendChild(box);
  refreshTopbar();
}
function closeAccManager() { const b = document.getElementById('acc-manager-box'); if (b) b.remove(); }
async function addCollectAccount() {
  const acc = await bridge.addAccount('collect', '采集账号');
  toast('已打开登录窗口，请用手机1688扫码登录');
  const r = await bridge.loginAccount(acc.id);
  toast(r.message, !r.ok);
  openCollectAccountManager();
  refreshTopbar();
}
async function loginCollectAccount(id) {
  toast('已打开登录窗口，请用手机1688扫码登录');
  const r = await bridge.loginAccount(id);
  toast(r.message, !r.ok);
  openCollectAccountManager();
  refreshTopbar();
}
async function checkCollectAccount(id) {
  const r = await bridge.checkAccount(id);
  toast(r.message, !r.ok);
  openCollectAccountManager();
  refreshTopbar();
}
async function removeCollectAccount(id) {
  const ok = await inlineForm({
    title: '确认删除该采集账号？（登录态将一并清除）',
    fields: [],
    confirmText: '删除',
  });
  if (!ok) return;
  await bridge.removeAccount(id);
  toast('已删除');
  openCollectAccountManager();
  refreshTopbar();
}

/* ============ 工具功能（黑鲸鱼同款控件逐一实现） ============ */
// 导入商品数据包（JSON，兼容本工具采集格式）
async function btnImportDataClick() {
  try {
    const r = await bridge.importGoods();
    toast(r.message || (r.ok ? '导入成功' : '导入失败'), r.ok === false);
    if (r.ok) { refreshTopbar(); appendCollectLog(r.message); }
  } catch (e) { toast('导入失败：' + e.message, true); }
}
// 导入链接.txt（每行一个1688宝贝链接，仅存offerId到上传列表，上传时自动补采详情）
async function importLinksTxt() {
  try {
    const r = await bridge.pickTextFile();
    if (!r.ok || !r.text) return;
    const offerIds = [...new Set(
      r.text.split(/\r?\n/).map(l => l.trim()).map(l => (l.match(/offer\/(\d{6,})/) || [])[1]).filter(Boolean)
    )];
    if (!offerIds.length) { toast('未识别到有效的1688宝贝链接（需含 offer/数字）', true); return; }
    const ar = await bridge.addToUploadListLite(offerIds.map(id => ({ offerId: id })));
    toast(ar.message || `已导入 ${offerIds.length} 个链接`);
    appendCollectLog(`导入链接.txt：${offerIds.length} 个 → ${ar.message || '完成'}`);
    refreshTopbar();
    await loadUploadList();
  } catch (e) { toast('导入失败：' + e.message, true); }
}
// 批量替换标题（对当前采集结果列表全部标题生效）
async function btnReplaceTitleClick() {
  const r = await inlineForm({
    title: '批量替换标题（对当前采集结果全部生效）',
    fields: [
      { key: 'find', label: '查找内容', placeholder: '要替换的词', value: '' },
      { key: 'rep', label: '替换为（留空=直接删除该词）', value: '' },
    ],
  });
  if (!r) return;
  const find = String(r.find || '').trim();
  if (!find) { toast('查找内容为空', true); return; }
  const rep = r.rep || '';
  let n = 0;
  for (const type of Object.keys(collected)) {
    for (const it of (collected[type] || [])) {
      if (it.title && it.title.includes(find)) { it.title = it.title.split(find).join(rep); n++; }
    }
  }
  const curType = (document.querySelector('#goods-table-link .g-item') || {}).dataset;
  renderCollected(curType && curType.type ? curType.type : 'kw');
  appendCollectLog(`批量替换标题：「${find}」→「${rep}」，替换 ${n} 个`);
  toast(`已替换 ${n} 个标题`);
}
// 清理图片缓存
async function mButton7Click() {
  try {
    const r = await bridge.clearImageCache();
    toast(r.message || (r.ok ? '缓存已清理' : '清理失败'), r.ok === false);
  } catch (e) { toast('清理失败：' + e.message, true); }
}
function openLogsTab() { go('logs'); }
// 店铺分类载入（黑鲸鱼 GetShopCat：manage.render → filter → queryShopCategoryId，填入"上传到分类"下拉）
async function linkShopCategoryClick() {
  toast('正在同步店铺分类…');
  try {
    const r = await bridge.getShopCats();
    if (!r.ok || !r.cats || !r.cats.length) { toast(r.message || '未获取到店铺分类（需商家账号登录）', true); return; }
    const sel = document.getElementById('cbb_UploadToClassfy');
    if (sel) {
      const cur = sel.value || '';
      sel.innerHTML = '<option value="">不指定</option>' + r.cats.map(c =>
        `<option value="${esc(c.value)}">${esc(c.text)}</option>`).join('');
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    }
    toast(`已载入 ${r.cats.length} 个店铺分类（勾选"上传到分类"后选择）`);
  } catch (e) {
    toast('店铺分类同步失败：' + e.message, true);
  }
}
// 词库 txt 导入（过滤词/清理词/自定义标题，追加到对应文本框）
async function _importWords(targetId, label) {
  try {
    const r = await bridge.pickTextFile();
    if (!r.ok) return;
    const el = document.getElementById(targetId);
    if (!el) { toast('未找到目标文本框', true); return; }
    const add = String(r.text || '').trim();
    if (!add) { toast('文件内容为空', true); return; }
    el.value = el.value.trim() ? el.value.trim() + '\n' + add : add;
    toast(`已导入${label} ${add.split(/\r?\n/).filter(x => x.trim()).length} 行，请点「保存配置」生效`);
  } catch (e) { toast('导入失败：' + e.message, true); }
}
function btnTitleImportClick() { _importWords('txtTitleFilter', '标题过滤词'); }
function btnTitleClearImportClick() { _importWords('txtTitleClear', '标题清理词'); }
function btnCustomTitleImportClick() { _importWords('txtCustomTitle', '自定义标题'); }
// 清空 textarea 内容
function clearTextarea(id) {
  const el = document.getElementById(id);
  if (el) { el.value = ''; el.focus(); }
}
// 导购标题模式联动：自定义模式启用输入框
function syncDgTitleInput() {
  const mode = document.getElementById('cbb_DgTitle');
  const input = document.getElementById('txt_DgTitle');
  if (mode && input) input.disabled = mode.value !== '2';
}
// 多件优惠联动：勾选才可用折扣下拉（黑鲸鱼同款）
function syncMultiDiscount() {
  const chk = document.getElementById('chkMultiDiscount');
  const sel = document.getElementById('cmbMultiDiscount');
  if (chk && sel) sel.disabled = !chk.checked;
}
// 清空历史缓存标题（重复标题过滤开关）
function clearTitleCache(btn) {
  armAction(btn, () => {
    const chk = document.getElementById('cbk_filter_title');
    if (chk) chk.checked = false;
    toast('重复标题过滤已关闭，请点「保存配置」生效');
  });
}
// 类目查询（get_asyncOpt_categorySearch，结果填入下拉）
async function btnFindCategoryClick() {
  const kw = getVal('txt_category_key').trim();
  if (!kw) { toast('请输入类目关键词', true); return; }
  toast('正在查询类目…');
  try {
    const r = await bridge.categorySearch(kw);
    if (!r.ok || !r.cats || !r.cats.length) { toast('未查询到类目', true); return; }
    const sel = document.getElementById('cbb_cagegorylist');
    if (sel) {
      sel.innerHTML = r.cats.map(c => `<option value="${esc(String(c.catId))}">${esc(c.name)}（${esc(String(c.catId))}）</option>`).join('');
      sel.dataset.cur = '';
    }
    // 勾选"自定义统一上传类目"并回填关键词
    const selfRadio = document.getElementById('rab_categroy_self');
    if (selfRadio) selfRadio.checked = true;
    toast(`查询到 ${r.cats.length} 个类目，已填入「选择上传类目」下拉`);
  } catch (e) { toast('类目查询失败：' + e.message, true); }
}
function btnRefreshFeePostClick() {
  toast('正在从千牛后台同步运费模板…');
  bridge.sellerSync({}).then(r => { toast(r.message, !r.ok); loadUploadConfig(); });
}
// 清理未引用运费模板（本地对比：列出当前未在下拉选中/未被引用的模板）
async function clearPostTemplate() {
  toast('正在对比运费模板引用…');
  try {
    const c = await bridge.getConfig();
    const ship = (c.seller && c.seller.shipTemplates) || c.shipTemplates || [];
    const cur = (c.upset && c.upset.shipTemplate) || '';
    if (!ship.length) { toast('请先「加载全部模板」后再清理', true); return; }
    const unused = ship.filter(t => t !== cur);
    if (!unused.length) { toast('所有模板均被引用'); return; }
    toast(`共 ${ship.length} 个模板，未引用 ${unused.length} 个：${unused.slice(0, 3).join('、')}${unused.length > 3 ? '…' : ''}（淘宝后台暂无删除接口，请到千牛后台手动清理）`);
  } catch (e) { toast('对比失败：' + e.message, true); }
}
// 添加SKU（缺失SKU设置行编辑，格式 颜色=黑色）
async function btnAddSkuClick() {
  const r = await inlineForm({
    title: '添加缺失SKU',
    fields: [{ key: 'sku', label: '格式：颜色=黑色（例：颜色=黑色、尺码=M）', value: '' }],
  });
  if (!r) return;
  const s = String(r.sku || '').trim();
  if (!s) return;
  if (!/^[^=，,]+=[^=]+$/.test(s)) { toast('格式错误，应为：名称=值', true); return; }
  const el = document.getElementById('txtAddSku');
  el.value = el.value.trim() ? el.value.trim() + '\n' + s.trim() : s.trim();
  const chk = document.getElementById('chkAddNoSku');
  if (chk && !chk.checked) chk.checked = true;
  toast('SKU行已添加，请点「保存配置」生效');
}
// 其他配置（切到 sku 转换子 Tab 并聚焦）
function btn1688SettingClick() {
  const btn = document.querySelector('.stab[data-sub="skuconv"]');
  if (btn) btn.click();
  const el = document.getElementById('txt_1688sku');
  if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
  toast('SKU转换/合并/小数位等配置都在本页，改完记得「保存配置」');
}
// 主图处理（显示当前主图处理配置并快捷调整）
async function btnMainImgClick() {
  const sq = getVal('cmbSqImg') || '800*800';
  const ver = getChk('chkVerImg') ? '开' : '关';
  const fill = getChk('chkBqQsImg') ? '开' : '关';
  const sku800 = getChk('chkSkuSq800') ? '开' : '关';
  const r = await inlineForm({
    title: `主图处理（当前：方图${sq} / 3:4长图${ver} / 自动补齐${fill} / SKU图800*800：${sku800}）`,
    fields: [{
      key: 'opt', label: '选择要切换的项目', type: 'select', value: '1',
      options: [
        { value: '1', text: `1. 方主图尺寸（当前 ${sq}）` },
        { value: '2', text: `2. 生成3:4长图（当前${ver}）` },
        { value: '3', text: `3. 无方图自动补齐（当前${fill}）` },
        { value: '4', text: `4. SKU图改成800*800（当前${sku800}）` },
      ],
    }],
  });
  if (!r) return;
  const n = parseInt(r.opt, 10);
  if (n === 1) {
    const sel = document.getElementById('cmbSqImg');
    if (sel) sel.value = sq === '800*800' ? '700*700' : '800*800';
    toast(`方主图尺寸已切换为 ${sel.value}，请「保存配置」生效`);
  } else if (n === 2) {
    const el = document.getElementById('chkVerImg');
    if (el) el.checked = !el.checked;
    toast(`3:4长图已${el.checked ? '开启' : '关闭'}，请「保存配置」生效`);
  } else if (n === 3) {
    const el = document.getElementById('chkBqQsImg');
    if (el) el.checked = !el.checked;
    toast(`无方图自动补齐已${el.checked ? '开启' : '关闭'}，请「保存配置」生效`);
  } else if (n === 4) {
    const el = document.getElementById('chkSkuSq800');
    if (el) el.checked = !el.checked;
    toast(`SKU图800已${el.checked ? '开启' : '关闭'}，请「保存配置」生效`);
  } else {
    toast('序号无效（1~4）', true);
  }
}
// 水印设置（文字水印，发布时主图+详情图右下角自动打水印）
async function btnWaterClick() {
  let cur = '';
  try { const c = await bridge.getConfig(); cur = (c.imgset && c.imgset.waterText) || ''; } catch (_) {}
  const r = await inlineForm({
    title: '设置文字水印（发布时自动打到主图/详情图右下角，留空=关闭水印）',
    fields: [{ key: 'text', label: '水印内容', value: cur, placeholder: '如：店铺名' }],
  });
  if (!r) return;
  const t = String(r.text || '').trim();
  const sel = document.getElementById('cmbWaterRemark');
  if (sel) sel.value = t.trim() ? '1' : '0';
  await saveUploadConfig();
  // 把水印文字写进配置（saveUploadConfig 不含 waterText，单独保存）
  try { await bridge.saveConfig({ imgset: { waterText: t.trim() } }); } catch (_) {}
  toast(t.trim() ? `水印已设置：「${t.trim().slice(0, 10)}」，发布时生效` : '水印已关闭');
}
// 宝贝管理：上架/下架/删除（黑鲸鱼仅实现删除 batchDeleteItem，上下架其自身也未实现）
async function itemShelfOpt(act) {
  if (act !== 'delete') {
    toast('上下架功能黑鲸鱼本身未实现（反编译源码为空桩），请到千牛后台操作');
    return;
  }
  const r = await inlineForm({
    title: '删除淘宝宝贝（此操作直接删除淘宝后台宝贝，不可恢复）',
    fields: [{ key: 'ids', label: '宝贝ID（数字，多个用英文逗号分隔；新商品ID见上传记录页）', placeholder: '如：123456789,987654321', value: '' }],
    confirmText: '确认删除这些宝贝？此操作直接删除淘宝后台宝贝，不可恢复！',
  });
  if (!r) return;
  const list = String(r.ids || '').split(/[,，\s]+/).map(x => x.trim()).filter(x => /^\d{6,}$/.test(x));
  if (!list.length) { toast('未识别到有效宝贝ID', true); return; }
  toast(`正在删除 ${list.length} 个宝贝…`);
  try {
    const res = await bridge.deleteItems(list);
    toast(res.message || (res.ok ? '删除成功' : '删除失败'), res.ok === false);
  } catch (e) { toast('删除失败：' + e.message, true); }
}
function clearLogBox(id) { document.getElementById(id).innerHTML = ''; }

/* ============ 实时推送 ============ */
// 首启免责声明（渲染端主动查配置，避免事件时序丢失；同意一次后不再显示）
(async function checkDisclaimer() {
  try {
    const cfg = await bridge.getConfig();
    if (!cfg || !cfg.agreedDisclaimer) {
      const ov = document.getElementById('disclaimer-overlay');
      if (!ov) return;
      document.getElementById('disclaimer-ver').textContent = `千牛铺货助手 v${(cfg && cfg.__ver) || '1.0.0'}`;
      ov.style.display = 'block';
    }
  } catch (_) {}
})();
document.addEventListener('DOMContentLoaded', () => {
  const agreeBtn = document.getElementById('disclaimer-agree');
  const exitBtn = document.getElementById('disclaimer-exit');
  if (agreeBtn) agreeBtn.onclick = async () => {
    try { await bridge.saveConfig({ agreedDisclaimer: true }); } catch (_) {}
    document.getElementById('disclaimer-overlay').style.display = 'none';
    toast('已确认使用须知');
  };
  if (exitBtn) exitBtn.onclick = () => { window.close(); };
});
// 主进程推送兜底（若渲染端配置读取失败仍可收到）
bridge.on('app:disclaimer-needed', (p) => {
  const ov = document.getElementById('disclaimer-overlay');
  if (!ov || ov.style.display === 'block') return;
  document.getElementById('disclaimer-ver').textContent = `千牛铺货助手 v${(p && p.version) || '1.0.0'}`;
  ov.style.display = 'block';
});

bridge.on('queue:progress', (p) => {
  const logBox = document.getElementById('upload-log-box');
  if (p.type === 'start-item') {
    if (logBox) appendLog(logBox, { level: 'info', tag: '上传', message: `开始：${p.title || p.offerId}` });
    showProgress('queue-item', { title: `正在上传：${(p.title || p.offerId || '').slice(0, 18)}`, detail: p.detail || '处理中…', percent: 3 });
  } else if (p.type === 'collect-detail') {
    // 轻量导入商品上传前补采详情：让过程可见，否则用户以为卡住
    if (logBox) appendLog(logBox, { level: 'info', tag: '上传', message: `补采详情 ${p.offerId}…（约10~30秒）` });
    showProgress('queue-item', { title: `补采详情：${p.offerId}`, detail: '正在打开1688详情页提取数据…', percent: 10 });
  } else if (p.type === 'item-done') {
    if (logBox) appendLog(logBox, { level: p.ok ? 'ok' : 'err', tag: '上传', message: p.ok ? `成功 ${p.offerId}` : `失败 ${p.offerId}：${p.error || ''}` });
    showProgress('queue-item', {
      title: p.ok ? `已上架：${(p.title || p.offerId || '').slice(0, 18)}` : `失败：${(p.title || p.offerId || '').slice(0, 18)}`,
      detail: p.ok ? '已放入仓库/上架成功' : (p.error || '').slice(0, 60),
      percent: 100, done: true, error: !p.ok,
    });
    refreshTopbar();
  } else if (p.type === 'gap') {
    if (logBox) appendLog(logBox, { level: 'info', tag: '队列', message: `下一品间隔 ${p.seconds}s…` });
  } else if (p.type === 'daily-limit') {
    showProgress('queue-item', { title: '已达每日限量', detail: '队列停止', done: true, error: true });
  } else if (p.type === 'login-expired') {
    // 商家登录态失效：队列终止，醒目提示
    if (logBox) appendLog(logBox, { level: 'err', tag: '队列', message: `队列终止：${p.message || '商家登录态失效'}` });
    showProgress('queue-item', { title: '队列已终止：商家登录态失效', detail: (p.message || '').slice(0, 80) + ' — 请到「店铺管理」重新扫码，商品已回队', done: true, error: true });
    toast('商家登录态失效，队列已停止；重新扫码后点「开始上传」继续', true);
  } else if (p.type === 'config-error') {
    // 上传配置缺失（如类目关键词）：队列终止，商品回队，引导去配置
    if (logBox) appendLog(logBox, { level: 'err', tag: '队列', message: `队列终止：${p.message || '上传配置缺失'}` });
    showProgress('queue-item', { title: '队列已停止：上传配置缺失', detail: (p.message || '').slice(0, 80) + ' — 商品已回队，补全配置后重新开始', done: true, error: true });
    toast('上传配置缺失，队列已停止；正在跳转到「上传设置→类目」', true);
    setTimeout(() => {
      go('upset');
      const btn = document.querySelector('.stab[data-sub="category"]');
      if (btn) btn.click();
    }, 600);
  } else if (p.type === 'consec-fail') {
    // 连续失败熔断
    if (logBox) appendLog(logBox, { level: 'err', tag: '队列', message: `连续失败 ${p.count} 次，队列已自动熔断暂停` });
    showProgress('queue-item', { title: `连续失败 ${p.count} 次，队列已自动暂停`, detail: '请查看「上传记录」失败原因，处理后重新开始', done: true, error: true });
    toast(`连续失败 ${p.count} 次，队列已自动暂停；请检查失败原因`, true);
  } else if (p.type === 'verify-needed') {
    if (logBox) appendLog(logBox, { level: 'warn', tag: '队列', message: `遇验证，等待人工/自动处理 [${p.offerId}]` });
  } else if (p.type === 'stopped') {
    if (logBox) appendLog(logBox, { level: 'info', tag: '队列', message: '队列已停止' });
  }
});
bridge.on('queue:stats', refreshTopbar);
// 登录态巡检结果：失效账号顶栏标红 + 一次告警
let _patrolNotified = {};
bridge.on('acc:patrol', (r) => {
  try {
    const expired = [];
    if (r.shop && r.shop.status !== 'ok') expired.push({ name: r.shop.name || '店铺账号', type: 'shop' });
    for (const c of (r.collect || [])) if (c.status !== 'ok') expired.push({ name: c.name || '采集账号', type: 'collect' });
    if (expired.length) {
      const keys = expired.map(x => x.type + ':' + x.name);
      if (keys.some(k => !_patrolNotified[k])) {
        toast(`登录态失效：${expired.map(x => x.name).join(' / ')}，请到对应页面重新扫码`, true);
      }
      keys.forEach(k => _patrolNotified[k] = true);
    }
    const shopEl = document.getElementById('top-shop-name');
    const colEl = document.getElementById('top-collect-acc');
    if (shopEl && r && r.shop) {
      shopEl.style.color = r.shop.status === 'ok' ? '' : '#f59e0b';
      if (r.shop.status !== 'ok') shopEl.textContent = `店铺: ${r.shop.name} (登录失效)`;
    }
    if (colEl && r && r.collect && r.collect.length) {
      const allOk = r.collect.every(c => c.status === 'ok');
      colEl.style.color = allOk ? '' : '#f59e0b';
    }
  } catch (_) {}
});
// 启动检测：过期账号已清除旧会话，显示醒目横幅引导重新扫码
bridge.on('acc:startup-expired', (p) => {
  try {
    const expired = (p && p.expired) || [];
    if (!expired.length) return;
    const banner = document.getElementById('login-expired-banner');
    if (!banner) return;
    const listEl = document.getElementById('expired-acc-list');
    const shopBtn = document.getElementById('expired-goto-shop');
    const colBtn = document.getElementById('expired-goto-collect');
    const dismissBtn = document.getElementById('expired-dismiss');
    if (listEl) listEl.textContent = expired.map(x => x.name).join('、') + ' — 旧登录态已自动清除，请重新扫码';
    const hasShop = expired.some(x => x.type === 'shop');
    const hasCollect = expired.some(x => x.type === 'collect');
    if (shopBtn) shopBtn.style.display = hasShop ? '' : 'none';
    if (colBtn) colBtn.style.display = hasCollect ? '' : 'none';
    banner.style.display = 'flex';
    toast(`检测到 ${expired.length} 个账号登录态过期，已清除旧会话，请重新扫码`, true);
    if (shopBtn) shopBtn.onclick = () => { loginShopBtnClick(); banner.style.display = 'none'; };
    if (colBtn) colBtn.onclick = () => { openCollectAccountManager(); };
    if (dismissBtn) dismissBtn.onclick = () => { banner.style.display = 'none'; };
  } catch (_) {}
});
bridge.on('log:push', (entry) => {
  const box = document.getElementById('listbox_marklog');
  if (box && /collect|采集/.test(entry.tag || '')) appendLog(box, entry);
  const ub = document.getElementById('upload-log-box');
  if (ub && /publish|上传/.test(entry.tag || '')) appendLog(ub, entry);
});

/* ============ 日志 ============ */
async function refreshLogs() {
  const logs = await bridge.recentLogs(400);
  const box = document.getElementById('logs-box');
  box.innerHTML = '';
  logs.forEach(e => appendLog(box, e));
  box.scrollTop = box.scrollHeight;
}
function appendLog(box, e) {
  const div = document.createElement('div');
  div.className = 'log-line ' + (e.level || '');
  div.innerHTML = `<span class="t">${new Date(e.time || Date.now()).toLocaleTimeString('zh-CN')}</span> [${esc(e.tag)}] <span class="m">${esc(e.message)}</span>`;
  box.appendChild(div);
  if (box.children.length > 600) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ============ AI 整店运营（Tab6） ============ */
const AI_PROVIDERS = {
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  qwen: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  moonshot: { name: 'Kimi(Moonshot)', base: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  zhipu: { name: '智谱GLM', base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'] },
  doubao: { name: '豆包方舟(火山)', base: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-lite-32k', 'doubao-seed-1-6-250615'] },
  custom: { name: '自定义(OpenAI兼容)', base: '', models: [] },
};
let _aiReport = null;
function loadAiConfig() {
  const sel = document.getElementById('ai-provider');
  if (!sel || sel.options.length === 0) {
    sel.innerHTML = Object.entries(AI_PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  }
  bridge.aiConfigGet().then(cfg => {
    setVal('ai-provider', cfg.provider || 'deepseek');
    aiProviderChanged(true);
    setVal('ai-base', cfg.baseURL || AI_PROVIDERS[cfg.provider || 'deepseek'].base);
    setVal('ai-key', cfg.apiKey || '');
    setVal('ai-model', cfg.model || '');
    setText('ai-cfg-msg', cfg.apiKey ? `已保存配置（${cfg.model || ''}）` : '未配置 Key，可用「演示模式」');
    loadHostConfig();
  }).catch(() => {});
}
function aiProviderChanged(silent) {
  const k = getVal('ai-provider') || 'deepseek';
  const p = AI_PROVIDERS[k];
  if (!p) return;
  if (!silent && !getVal('ai-base')) setVal('ai-base', p.base);
  setVal('ai-model', p.models[0] || '');
}
function aiToggleKey(btn) {
  const inp = document.getElementById('ai-key');
  const isPw = inp.type === 'password';
  inp.type = isPw ? 'text' : 'password';
  btn.textContent = isPw ? '隐藏' : '显示';
}
async function aiSaveConfig(btn) {
  const cfg = {
    provider: getVal('ai-provider'),
    baseURL: getVal('ai-base').trim(),
    apiKey: getVal('ai-key').trim(),
    model: getVal('ai-model').trim(),
    providerName: (AI_PROVIDERS[getVal('ai-provider')] || {}).name || '',
  };
  if (!cfg.baseURL) { toast('请填写接口地址', true); return; }
  if (!cfg.model) { toast('请填写模型名', true); return; }
  const r = await bridge.aiConfigSave(cfg);
  if (r && r.ok) {
    setText('ai-cfg-msg', '已保存：' + cfg.providerName + ' / ' + cfg.model);
    toast('AI 配置已保存');
  } else {
    toast('保存失败', true);
  }
}
async function aiTestConn(btn) {
  const cfg = {
    baseURL: getVal('ai-base').trim(),
    apiKey: getVal('ai-key').trim(),
    model: getVal('ai-model').trim(),
  };
  if (!cfg.apiKey) { toast('请先填写 API Key', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  try {
    const r = await bridge.aiTest(cfg);
    if (r && r.ok) {
      setText('ai-cfg-msg', `连接成功（${r.ms}ms）：${r.reply}`);
      toast('AI 连接测试成功');
    } else {
      setText('ai-cfg-msg', '连接失败：' + (r.message || ''));
      toast('连接失败：' + (r.message || ''), true);
    }
  } catch (e) {
    setText('ai-cfg-msg', '连接失败：' + e.message);
    toast('连接失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '测试连接'; }
  }
}
async function doAiOperate(btn) {
  const mode = getVal('ai-mode') || 'auto';
  const scope = getVal('ai-scope') || 'all';
  if (btn) { btn.disabled = true; btn.textContent = '运营中…'; }
  setText('ai-err', '');
  try {
    const r = await bridge.aiOperate({ mode, scope, batch: 20 });
    if (!r.ok) { setText('ai-err', r.message || '运营失败'); toast(r.message || '运营失败', true); return; }
    _aiReport = r;
    const s = r.stats || {};
    setText('ai-summary', `模式：${r.provider}（${r.model}）｜商品 ${s.total}｜违禁词 ${s.forbidden}｜标题过长 ${s.longTitle}｜价格异常 ${s.priceIssue}｜失败 ${s.failed}`);
    renderAiReport(r);
    toast(`运营完成：分析 ${s.total} 个商品`);
  } catch (e) {
    setText('ai-err', e.message || '运营失败');
    toast('运营失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '开始整店运营'; }
  }
}
function renderAiReport(r) {
  const box = document.getElementById('ai-report');
  if (!r || !r.items) { box.innerHTML = '<div class="ai-empty">无数据</div>'; return; }
  const rows = r.items.map(it => {
    const issues = (it.issues || []).map(x => esc(x)).join('<br/>') || '—';
    const fw = (it.forbiddenWords && it.forbiddenWords.length) ? `<span class="ai-fw">${esc(it.forbiddenWords.join('/'))}</span>` : '<span style="color:var(--ok)">无</span>';
    const newTitle = it.optimizedTitle ? `<div class="ai-newtitle">${esc(it.optimizedTitle)}</div>` : (it.demoNote ? `<div class="ai-note">${esc(it.demoNote)}</div>` : '<div style="color:var(--sub)">无需修改</div>');
    const badge = it.status === 'failed' ? '<span class="ai-badge ai-badge-fail">失败</span>' : (it.source === '在售' ? '<span class="ai-badge">在售</span>' : '');
    return `<tr class="${it.forbiddenWords && it.forbiddenWords.length ? 'row-dup' : ''}">
      <td class="t-cell" title="${esc(it.title)}">${esc(it.title)}${badge}</td>
      <td>${issues}</td>
      <td>${fw}</td>
      <td>${newTitle}</td>
      <td style="max-width:200px">${it.salesPoints ? esc(it.salesPoints) : '—'}</td>
      <td style="max-width:220px">${it.descSuggestion ? esc(it.descSuggestion) : '—'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div style="overflow:auto;max-height:56vh"><table class="ultable ai-table">
    <thead><tr><th style="width:24%">原标题</th><th style="width:22%">问题</th><th style="width:12%">违禁词</th><th style="width:22%">优化标题</th><th>卖点</th><th>详情建议</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
async function aiApplyTitles(btn) {
  if (!_aiReport || !_aiReport.items) { toast('请先「开始整店运营」', true); return; }
  const candidates = _aiReport.items.filter(it => it.id && it.optimizedTitle);
  if (!candidates.length) { toast('没有可应用的优化标题（演示模式建议仅供参考）', true); return; }
  armAction(btn, async () => {
    const r = await bridge.aiApplyTitles(candidates);
    toast(`已应用 ${r.applied} 个优化标题到本地商品（不影响店铺线上）`);
  });
  toast(`检测到 ${candidates.length} 个可应用标题，再点一次确认应用`);
}
async function aiExportReport(btn) {
  if (!_aiReport) { toast('请先「开始整店运营」', true); return; }
  const r = await bridge.aiExportReport(_aiReport);
  if (r.ok) toast('报告已导出：' + r.path);
  else toast('导出失败：' + (r.message || ''), true);
}
function aiResetReport() {
  _aiReport = null;
  setText('ai-summary', '');
  setText('ai-err', '');
  document.getElementById('ai-report').innerHTML = '<div class="ai-empty">点击「开始整店运营」：拉取本店商品 → AI 诊断标题/违禁词/卖点/价格 → 生成优化报告<br/>没有 AI Key 也能用「演示模式」跑通全流程（本地规则）</div>';
}

/* ============ AI 全店托管运营 ============ */
async function loadHostConfig() {
  try {
    const cfg = await bridge.hostConfigGet();
    setChk('host-enabled', cfg.enabled);
    setChk('host-autoshelf', cfg.autoShelf !== false);
    setChk('host-pricing', cfg.autoPricing !== false);
    setVal('host-time', cfg.dailyTime || '02:00');
    setVal('host-mode', cfg.mode || 'auto');
  } catch (_) {}
  refreshHostStatus();
}
async function hostSaveFromUi() {
  await bridge.hostConfigSave({
    enabled: getChk('host-enabled'),
    autoShelf: getChk('host-autoshelf'),
    autoPricing: getChk('host-pricing'),
    dailyTime: getVal('host-time') || '',
    mode: getVal('host-mode'),
  });
  refreshHostStatus();
}
async function refreshHostStatus() {
  try {
    const s = await bridge.hostStatus();
    const run = s.lastRun ? `${fmtTime(s.lastRun.at)}（${s.lastRun.reason === 'scheduled' ? '定时' : '手动'}）下架 ${s.lastRun.stats.downShelfOk || 0} 件` : '尚未执行';
    setText('host-status', `${s.enabled ? '托管已开启' : '托管未开启'}｜今日动作 ${s.todayActions}｜上次：${run}${s.running ? '（运行中）' : ''}`);
  } catch (_) {}
}
async function doHostRun(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '托管运行中…'; }
  try {
    const r = await bridge.hostRun();
    if (!r.ok) { toast(r.message || '托管执行失败', true); return; }
    const st = r.stats || {};
    toast(`托管完成：诊断 ${st.total || 0} 个，自动下架成功 ${st.downShelfOk || 0} / 失败 ${st.downShelfFail || 0}，定价建议 ${st.pricing || 0}`);
    refreshHostStatus();
  } catch (e) {
    toast('托管执行失败：' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立即执行托管'; }
  }
}
async function loadHostRecords() {
  try {
    const list = await bridge.hostRecords(10);
    if (!list.length) { toast('暂无托管记录'); return; }
    toast('最近托管记录：' + linesToHtml(list));
  } catch (e) { toast('读取托管记录失败：' + e.message, true); }
}
function linesToHtml(list) {
  return list.slice(0, 3).map(r => `[${fmtTime(r.at)}] 诊断${r.stats.total}件·下架${r.stats.downShelfOk}成功/${r.stats.downShelfFail}失败·定价${r.stats.pricing}`).join(' ｜ ');
}

/* ============ 初始化 ============ */
go('collect');
refreshTopbar();
setInterval(refreshTopbar, 15000);

/* ============ 供应商管理（退货地址 / 失联下架） ============ */
// 主进程推送 suppliers:updated 时刷新列表
bridge.on('suppliers:updated', () => loadSuppliers());

async function loadSuppliers() {
  const box = document.getElementById('suppl-list');
  if (!box) return;
  try {
    const list = await bridge.listSuppliers();
    if (!list.length) {
      box.innerHTML = '<div class="empty-hint">暂无供应商。点击上方「从采集库同步供应商」自动导入已采集过的供应商</div>';
      return;
    }
    // 本店千牛地址库中的退货地址（仅作输入提示，发布时按名称匹配淘宝下拉）
    let addrOpts = '';
    try {
      const info = await bridge.sellerInfo();
      const addrs = (info && info.returnAddresses) || [];
      addrOpts = addrs.map(a => {
        const name = typeof a === 'string' ? a : (a.name || (a.address || ''));
        return name ? `<option value="${esc(name)}">` : '';
      }).join('');
    } catch (_) {}
    box.innerHTML = `<datalist id="suppl-addr-opts">${addrOpts}</datalist>` + list.map(s => {
      const isGhost = s.status === 'ghost';
      return `
      <div class="suppl-card ${isGhost ? 'ghost' : ''}" data-id="${esc(s.id)}">
        <div class="suppl-row">
          <div class="suppl-info">
            <div class="suppl-name">${esc(s.shopName || '未命名店铺')} ${isGhost ? '<span class="tag-ghost">失联</span>' : ''}</div>
            <div class="suppl-meta">供应商ID: ${esc(s.supplierUserId)} · 已铺 ${s.goodsCount || 0} 件</div>
          </div>
          <div class="suppl-actions">
            <button class="btn small primary" onclick="saveSuppAddr('${esc(s.id)}')">保存地址</button>
            ${isGhost
              ? `<button class="btn small danger" onclick="delistSupplier('${esc(s.id)}')">一键下架商品</button>`
              : `<button class="btn small warn" onclick="markGhost('${esc(s.id)}')">标记失联</button>`
            }
            <button class="btn small" onclick="removeSupplier('${esc(s.id)}')">删除</button>
          </div>
        </div>
        <div class="suppl-row">
          <label class="suppl-field">
            <span class="suppl-lbl">退货地址名称</span>
            <input type="text" class="suppl-input" list="suppl-addr-opts"
              data-uid="${esc(s.supplierUserId)}" data-shop="${esc(s.shopName || '')}"
              value="${esc(s.returnAddress || '')}"
              placeholder="须与千牛后台「退货地址管理」中的地址名称一致，可直接输入或点下拉选" />
          </label>
        </div>
        <div class="suppl-row">
          <label class="suppl-field suppl-field-full">
            <span class="suppl-lbl">供应商完整退货信息（私信问供应商要：收件人/电话/省市区/详细地址）</span>
            <textarea class="suppl-textarea" rows="2" placeholder="例：张三 13800000000 浙江省金华市义乌市XX街道XX号">${esc(s.returnAddressDetail || '')}</textarea>
          </label>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="empty-hint">加载失败: ' + esc(e.message) + '</div>';
  }
}

async function syncSuppliersFromGoods() {
  try {
    const r = await bridge.syncSuppliersFromGoods();
    toast(`同步完成：新增 ${r.added} 个供应商，共 ${r.total} 个`);
    loadSuppliers();
  } catch (e) { toast('同步失败: ' + e.message, true); }
}

async function saveSuppAddr(id) {
  const card = document.querySelector(`.suppl-card[data-id="${id}"]`);
  if (!card) return;
  const input = card.querySelector('.suppl-input');
  const detail = card.querySelector('.suppl-textarea');
  const uid = input.dataset.uid;
  const shop = input.dataset.shop;
  const addr = input.value.trim();
  const addrDetail = detail.value.trim();
  try {
    await bridge.upsertSupplier({
      supplierUserId: uid, shopName: shop,
      returnAddress: addr, returnAddressDetail: addrDetail,
    });
    toast(addr ? '退货地址已保存，发布该供应商商品时自动匹配' : '已清空退货地址（发布时用全局默认）');
    loadSuppliers();
  } catch (e) { toast('保存失败: ' + e.message, true); }
}

async function markGhost(id) {
  if (!confirm('标记为失联后，该供应商将无法自动匹配退货地址，且可一键下架其所有淘宝商品。确定？')) return;
  try {
    const r = await bridge.markSupplierGhost(id);
    if (r) toast(`已标记失联，${r.markedCount} 件商品标记待下架`);
    loadSuppliers();
  } catch (e) { toast('标记失败: ' + e.message, true); }
}

async function delistSupplier(id) {
  const card = document.querySelector(`.suppl-card[data-id="${id}"]`);
  const name = card ? (card.querySelector('.suppl-name') || {}).textContent : '';
  if (!confirm(`确定要下架【${name}】供应商在淘宝上的所有商品？此操作不可撤销！`)) return;
  try {
    const r = await bridge.delistBySupplier(id);
    if (r && r.ok) {
      toast(`下架完成：已删除 ${r.delistedCount || 0} 件商品`);
    } else {
      toast('下架失败：' + (r && r.message || '未知错误'), true);
    }
    loadSuppliers();
  } catch (e) { toast('下架失败: ' + e.message, true); }
}

async function removeSupplier(id) {
  if (!confirm('从供应商列表删除？已铺商品不受影响，但退货地址匹配将回退到全局默认。')) return;
  try {
    await bridge.removeSupplier(id);
    toast('已删除');
    loadSuppliers();
  } catch (e) { toast('删除失败: ' + e.message, true); }
}

/* ============ 热点选品（关键词→1688月销排序→评分→Top N→勾选采集） ============ */
let hotpickItems = [];

async function doHotPickSearch() {
  const kw = getVal('hp-kw').trim();
  if (!kw) { toast('请输入分类关键词', true); return; }
  const pages = +getVal('hp-pages') || 3;
  const topN = +getVal('hp-topn') || 30;
  const btn = document.getElementById('btn-hp-search');
  btn.disabled = true; btn.textContent = '搜索中…';
  setText('hp-count', '正在搜索1688货源（一件代发+常规）…');
  try {
    const r = await bridge.hotpickSearch({ keyword: kw, pages, topN });
    hotpickItems = (r && r.items) || [];
    renderHotPick();
    toast(r.message || `搜索完成：${hotpickItems.length} 个商品`);
  } catch (e) {
    toast('热点选品搜索失败：' + e.message, true);
    setText('hp-count', '搜索失败');
  } finally {
    btn.disabled = false; btn.textContent = '搜索选品';
  }
}

function renderHotPick() {
  const box = document.getElementById('hp-list');
  setText('hp-count', `共 ${hotpickItems.length} 个商品（按评分降序）`);
  if (!hotpickItems.length) {
    box.innerHTML = '<div class="empty-hint">未搜索到商品，换个关键词试试</div>';
    return;
  }
  box.innerHTML = hotpickItems.map((it, i) => {
    const rank = i + 1;
    const scoreCls = it.score >= 70 ? 'hp-hi' : (it.score >= 40 ? 'hp-mid' : 'hp-lo');
    return `
    <div class="hp-item sel" data-i="${i}" onclick="hpToggleItem(this)">
      <span class="hp-rank">${rank}</span>
      ${it.image ? `<img src="${esc(it.image)}" onerror="this.style.visibility='hidden'"/>` : '<img/>'}
      <div class="hp-body">
        <div class="hp-title" title="${esc(it.title)}">${esc(it.title || it.offerId)}</div>
        <div class="hp-meta">
          ${it.isFenxiao ? '<span class="fx-tag">一件代发</span>' : (it.minOrderQty != null && it.minOrderQty <= 1 ? '<span class="fx-tag">1件起批</span>' : '<span class="hp-tag-normal">常规货源</span>')}
          ${it.company ? `<span>${esc(it.company)}</span>` : ''}
          ${it.monthSales ? `<span>月销${esc(it.monthSales)}</span>` : ''}
          ${it.price != null ? `<span>成本¥${esc(it.price)}</span>` : ''}
          ${it.sellPrice != null ? `<span class="hp-sell">售价¥${esc(it.sellPrice)}</span>` : ''}
          ${it.profit != null ? `<span>利润¥${esc(it.profit)}</span>` : ''}
        </div>
      </div>
      <div class="hp-score ${scoreCls}">
        <span class="hp-score-num">${esc(it.score)}</span>
        <span class="hp-score-lbl">${it.score >= 70 ? '优选' : (it.score >= 40 ? '可做' : '观望')}</span>
      </div>
      ${it.url ? `<a class="hp-link" href="${esc(it.url)}" target="_blank" onclick="event.stopPropagation()">源链</a>` : ''}
    </div>`;
  }).join('');
}

function hpToggleItem(el) { el.classList.toggle('sel'); }

function hpCheckAll(on) {
  document.querySelectorAll('#hp-list .hp-item').forEach(el => el.classList.toggle('sel', on));
}

async function doHotPickCollect() {
  const selIdx = [...document.querySelectorAll('#hp-list .hp-item.sel')].map(el => +el.dataset.i);
  if (!selIdx.length) { toast('请先勾选宝贝', true); return; }
  const items = selIdx.map(i => hotpickItems[i]).filter(Boolean);
  const btn = document.getElementById('btn-hp-collect');
  btn.disabled = true; btn.textContent = '添加中…';
  try {
    // 秒加入上传列表（只存offerId），详情/图片上传时自动补采
    const r = await bridge.addToUploadListLite(items.map(it => ({ offerId: it.offerId })));
    toast(r.message || `已添加 ${items.length} 个宝贝到上传列表`);
    // 标记已采集项
    items.forEach(it => {
      const idx = hotpickItems.indexOf(it);
      if (idx >= 0) {
        const el = document.querySelector(`#hp-list .hp-item[data-i="${idx}"]`);
        if (el) el.classList.add('hp-done');
      }
    });
    refreshTopbar();
  } catch (e) {
    toast('采集失败：' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '加入上传列表';
  }
}

/* ============ AI推荐上传设置（AI分析商品库→推荐参数→填充表单） ============ */
async function doAiRecommendSettings() {
  const btn = document.getElementById('btn-ai-recommend');
  btn.disabled = true; btn.textContent = 'AI分析中…';
  const reasonEl = document.getElementById('ai-rec-reason');
  reasonEl.style.display = 'none';
  try {
    const r = await bridge.aiRecommendSettings();
    if (!r || !r.ok) { toast(r && r.message || 'AI推荐失败', true); return; }
    const rec = r.recommendations || {};
    // 填充表单
    if (rec.pricePercent != null) setVal('txt_AddNum', rec.pricePercent);
    if (rec.priceMode) {
      // priceMode: percent=加百分比(0), fixed=加价(0), stepped=乘(2)
      const src = rec.priceMode === 'fixed' ? '0' : rec.priceMode === 'stepped' ? '2' : '0';
      setVal('cbb_PriceSource', src);
    }
    if (rec.titleRebuild != null) setChk('cb_Title', rec.titleRebuild);
    if (rec.brandOther != null) setChk('cb_BrandIsOther', rec.brandOther);
    if (rec.brandName != null) setVal('txtBrand', rec.brandName);
    if (rec.day7 != null) setChk('chk7DayBack', rec.day7);
    if (rec.stock != null) setVal('txtkucun', rec.stock);
    if (rec.uploadWay != null) setVal('cbb_UploadWay', String(rec.uploadWay));
    if (rec.categoryKey) setVal('txt_category_key', rec.categoryKey);
    if (rec.filterTitle != null) setChk('cbk_filter_title', rec.filterTitle);
    if (rec.shipTemplate) setVal('cbb_TransMode', rec.shipTemplate);
    // 显示推荐理由
    if (rec.reason) {
      reasonEl.textContent = '💡 ' + rec.reason;
      reasonEl.style.display = 'inline';
    }
    // 自动勾选AI推荐开关
    setChk('chkAiRecommend', true);
    toast(r.message || 'AI推荐完成，请检查并保存');
  } catch (e) {
    toast('AI推荐失败：' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'AI一键推荐设置';
  }
}
