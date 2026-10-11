/**
 * preload - 安全 IPC 桥
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  // 账号
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (type, name) => ipcRenderer.invoke('accounts:add', type, name),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  loginAccount: (id) => ipcRenderer.invoke('accounts:login', id),
  checkAccount: (id) => ipcRenderer.invoke('accounts:check', id),
  patrolAccounts: () => ipcRenderer.invoke('accounts:patrol'),
  backupNow: () => ipcRenderer.invoke('app:backupNow'),
  listBackups: () => ipcRenderer.invoke('app:listBackups'),
  setCredential: (id, u, p) => ipcRenderer.invoke('accounts:setCred', id, u, p),
  // 采集
  previewCollect: (params) => ipcRenderer.invoke('collect:preview', params),
  startCollect: (params) => ipcRenderer.invoke('collect:start', params),
  collectByKeyword: (params) => ipcRenderer.invoke('collect:keyword', params),
  verifyShop: (url) => ipcRenderer.invoke('collect:verifyShop', url),
  // 阿里巴巴采集（黑鲸鱼 alibabasource 移植）
  collectDaixiao: (params) => ipcRenderer.invoke('collect:daixiao', params),
  collectPremium: (params) => ipcRenderer.invoke('collect:premium', params),
  shopItemsMtop: (params) => ipcRenderer.invoke('collect:shopMtop', params),
  shopCateMtop: (url) => ipcRenderer.invoke('collect:shopCate', url),
  factoryTabs: (url) => ipcRenderer.invoke('collect:factoryTabs', url),
  factoryItems: (params) => ipcRenderer.invoke('collect:factoryItems', params),
  // 全店采集配套（黑鲸鱼 Form全店采集 完整功能）
  proxyAdvice: (offerId, memberId) => ipcRenderer.invoke('collect:proxyAdvice', offerId, memberId),
  queryRate: (params) => ipcRenderer.invoke('collect:queryRate', params),
  itemDetailLite: (offerId) => ipcRenderer.invoke('collect:itemLite', offerId),
  searchCompany: (name) => ipcRenderer.invoke('collect:searchCompany', name),
  auxFile: (op, name, data) => ipcRenderer.invoke('collect:auxFile', op, name, data),
  // 热点选品（关键词→1688月销排序→评分→Top N）
  hotpickSearch: (params) => ipcRenderer.invoke('hotpick:search', params),
  // 商品库（上传列表）
  listGoods: (filter) => ipcRenderer.invoke('goods:list', filter),
  updateGoods: (id, patch) => ipcRenderer.invoke('goods:update', id, patch),
  removeGoods: (id) => ipcRenderer.invoke('goods:remove', id),
  clearGoods: (status) => ipcRenderer.invoke('goods:clear', status),
  addToUploadList: (items) => ipcRenderer.invoke('goods:addBatch', items),
  addToUploadListLite: (items) => ipcRenderer.invoke('goods:addBatchLite', items),
  ensureImages: (ids) => ipcRenderer.invoke('goods:ensureImages', ids),
  // 队列
  addQueue: (goodsIds) => ipcRenderer.invoke('queue:add', goodsIds),
  startQueue: () => ipcRenderer.invoke('queue:start'),
  pauseQueue: () => ipcRenderer.invoke('queue:pause'),
  queueStatus: () => ipcRenderer.invoke('queue:status'),
  queueStats: () => ipcRenderer.invoke('queue:stats'),
  // 记录
  getRecords: (n) => ipcRenderer.invoke('records:get', n),
  // 店铺管理（历史采集店铺）
  listShops: () => ipcRenderer.invoke('shops:list'),
  removeShop: (id) => ipcRenderer.invoke('shops:remove', id),
  // 店铺后台信息（千牛中心：运费模板/退货地址）
  sellerSync: (opts) => ipcRenderer.invoke('seller:sync', opts),
  sellerInfo: () => ipcRenderer.invoke('seller:info'),
  shopStores: () => ipcRenderer.invoke('tao:shopStores'),
  // 日志
  recentLogs: (n) => ipcRenderer.invoke('logs:recent', n),
  // 调试
  testPublish: (goodsId) => ipcRenderer.invoke('debug:testPublish', goodsId),
  apiDiag: (cmd, arg) => ipcRenderer.invoke('debug:apiDiag', cmd, arg),
  chuangyiDiag: () => ipcRenderer.invoke('debug:chuangyiDiag'),
  debugRelation: (params) => ipcRenderer.invoke('debug:relation', params),
  openWorkbench: () => ipcRenderer.invoke('debug:openPage'),
  // 其他
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  exportGoods: () => ipcRenderer.invoke('app:exportGoods'),
  // 工具功能
  categorySearch: (kw) => ipcRenderer.invoke('tao:categorySearch', kw),
  getShopCats: () => ipcRenderer.invoke('tao:shopCats'),
  deleteItems: (ids) => ipcRenderer.invoke('item:delete', ids),
  // 供应商管理（退货地址 / 失联下架）
  listSuppliers: () => ipcRenderer.invoke('suppliers:list'),
  syncSuppliersFromGoods: () => ipcRenderer.invoke('suppliers:syncFromGoods'),
  upsertSupplier: (data) => ipcRenderer.invoke('suppliers:upsert', data),
  removeSupplier: (id) => ipcRenderer.invoke('suppliers:remove', id),
  markSupplierGhost: (id) => ipcRenderer.invoke('suppliers:markGhost', id),
  delistBySupplier: (id) => ipcRenderer.invoke('suppliers:delistBySupplier', id),
  importGoods: () => ipcRenderer.invoke('app:importGoods'),
  pickTextFile: () => ipcRenderer.invoke('app:pickTextFile'),
  clearImageCache: () => ipcRenderer.invoke('app:clearImageCache'),
  // 查重（卖家中心 1688铺货商品 + 在售商家编码双数据源）
  dupCheck: () => ipcRenderer.invoke('check:dup'),
  dupReset: () => ipcRenderer.invoke('check:dupReset'),
  // AI 整店运营
  aiConfigGet: () => ipcRenderer.invoke('ai:configGet'),
  aiConfigSave: (cfg) => ipcRenderer.invoke('ai:configSave', cfg),
  aiTest: (cfg) => ipcRenderer.invoke('ai:test', cfg),
  aiOperate: (opts) => ipcRenderer.invoke('ai:operate', opts),
  aiApplyTitles: (list) => ipcRenderer.invoke('ai:applyTitles', list),
  aiExportReport: (report) => ipcRenderer.invoke('ai:exportReport', report),
  aiRecommendSettings: () => ipcRenderer.invoke('ai:recommendSettings'),
  // AI 托管运营
  hostConfigGet: () => ipcRenderer.invoke('host:configGet'),
  hostConfigSave: (patch) => ipcRenderer.invoke('host:configSave', patch),
  hostStatus: () => ipcRenderer.invoke('host:status'),
  hostRun: () => ipcRenderer.invoke('host:run'),
  hostRecords: (limit) => ipcRenderer.invoke('host:records', limit),
  // 主进程推送
  on: (channel, cb) => {
    const allow = ['queue:progress', 'log:push', 'queue:stats', 'collect:progress', 'acc:patrol', 'acc:startup-expired', 'app:disclaimer-needed', 'suppliers:updated'];
    if (!allow.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
