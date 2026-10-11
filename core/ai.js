/**
 * AI 整店运营引擎
 * - 多服务商兼容（OpenAI / DeepSeek / 通义千问 / Kimi / 智谱GLM / 豆包方舟 / 自定义），统一 OpenAI 兼容 /chat/completions 协议
 * - 无 Key 时可用「演示模式」：本地规则引擎（违禁词库/标题长度/价格异常）跑通全流程
 * - 一键运营：商品盘点 → AI 批量诊断（标题优化/违禁词/卖点/详情建议）→ 结构化报告
 * - 安全边界：AI 只产出「建议」，不直接改店铺线上商品；标题应用需用户点「应用优化」写回本地商品库
 */

// 服务商预设（均支持 OpenAI 兼容 chat/completions）
const PROVIDERS = {
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  qwen: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  moonshot: { name: 'Kimi(Moonshot)', base: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  zhipu: { name: '智谱GLM', base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'] },
  doubao: { name: '豆包方舟(火山引擎)', base: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-lite-32k', 'doubao-seed-1-6-250615'] },
  custom: { name: '自定义(OpenAI兼容)', base: '', models: [] },
};

// 常见广告法/平台违禁词库（宽松匹配，供诊断与演示模式使用）
const FORBIDDEN_WORDS = [
  '全网最低', '最低价', '绝对', '顶级', '第一', '首选', '唯一', '权威', '国家级',
  '最佳', '最强', '最优', '最高级', '极致', '100%', '纯天然', '无副作用', '根治',
  '永不', '包治', '特效', '万能', '祖传', '立刻见效', '立竿见影', '全网第一', '销量第一',
  '明星同款', '央视', '国家免检', '最便宜', '全国首创', '领跑者', '领导者', '金牌', '皇冠',
];

// 演示模式的通用替换建议（词 → 推荐表述）
const DEMO_REPLACES = {
  '第一': '优选', '最佳': '优选', '顶级': '高配', '最低价': '实惠价', '绝对': '确定',
  '全网': '', '100%': '高含量', '纯天然': '自然成分', '特效': '高效', '万能': '多用途',
};

class AiEngine {
  constructor({ store, logger } = {}) {
    this.store = store;
    this.logger = logger;
  }

  getConfig() {
    return (this.store && this.store.settings && this.store.settings.ai) || {};
  }

  saveConfig(cfg) {
    if (!this.store) return { ok: false, message: 'store 不可用' };
    this.store.settings.ai = { ...this.getConfig(), ...cfg };
    this.store._debounceSave();
    return { ok: true };
  }

  /** 测试连接：发一条极短消息验证 Key/模型/地址 */
  async test(cfg) {
    const c = { ...this.getConfig(), ...(cfg || {}) };
    if (!c.apiKey) return { ok: false, message: '请先填写 API Key' };
    if (!c.baseURL) return { ok: false, message: '请填写接口地址(Base URL)' };
    if (!c.model) return { ok: false, message: '请填写模型名' };
    const start = Date.now();
    try {
      const reply = await this.chat(c, [{ role: 'user', content: '只回复两个字：连接成功' }], { maxTokens: 20, timeoutMs: 30000 });
      return { ok: true, reply: String(reply).slice(0, 80), ms: Date.now() - start };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  /** OpenAI 兼容 chat/completions（非流式） */
  async chat(cfg, messages, { temperature = 0.7, maxTokens = 4096, timeoutMs = 120000 } = {}) {
    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    const url = base + '/chat/completions';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (cfg.apiKey || ''),
        },
        body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: maxTokens, stream: false }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`AI接口 ${res.status}：${t.slice(0, 300)}`);
      }
      const j = await res.json();
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('AI 返回内容为空');
      return content;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('AI 请求超时（' + Math.round(timeoutMs / 1000) + 's），请检查网络或换模型');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 一键整店运营
   * @param items 商品清单 [{id, offerId, title, price, status, source}]
   * @param opts { mode: 'auto'|'ai'|'demo', batch: 批大小, onProgress(detail) }
   */
  async operate(items, opts = {}) {
    const cfg = this.getConfig();
    const mode = opts.mode || (cfg.apiKey ? 'ai' : 'demo');
    const batch = Math.max(1, Math.min(50, opts.batch || 20));
    const onProgress = opts.onProgress || (() => {});
    const list = (items || []).filter(it => it && it.title).slice(0, 500);
    if (!list.length) return { ok: false, message: '没有可分析的商品（先去采集或登录店铺）' };

    // 演示模式：本地规则引擎（无 Key 也可跑通全流程）
    if (mode === 'demo' || (mode === 'auto' && !cfg.apiKey)) {
      return this._demoOperate(list, { onProgress });
    }
    if (mode === 'auto') return this._aiOperate(list, cfg, batch, onProgress);
    return this._aiOperate(list, cfg, batch, onProgress);
  }

  // ---------- AI 模式 ----------
  async _aiOperate(list, cfg, batch, { onProgress }) {
    if (!cfg.apiKey) return { ok: false, message: '请先配置 AI Key（或在运营设置选「演示模式」）' };
    if (!cfg.baseURL) return { ok: false, message: '请填写接口地址（Base URL）' };
    if (!cfg.model) return { ok: false, message: '请填写模型名' };

    const results = [];
    const total = list.length;
    for (let i = 0; i < list.length; i += batch) {
      const chunk = list.slice(i, i + batch);
      onProgress(`AI 分析中 ${Math.min(i + chunk.length, total)}/${total} …`);
      const payload = chunk.map((it, k) => ({ index: k, title: it.title, price: it.price != null ? it.price : '' }));
      const messages = [
        { role: 'system', content: '你是资深淘宝电商运营专家，精通标题优化、广告法违禁词、卖点提炼。只输出 JSON，不要输出任何解释。' },
        { role: 'user', content: this._buildPrompt(JSON.stringify(payload)) },
      ];
      let parsed = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await this.chat(cfg, messages, { maxTokens: 8192, timeoutMs: 180000 });
          parsed = this._parseJsonLoose(raw);
          if (parsed && Array.isArray(parsed.items)) break;
        } catch (e) {
          if (attempt === 0) onProgress('AI 返回解析失败，重试一次…');
          else throw e;
        }
      }
      if (!parsed || !Array.isArray(parsed.items)) throw new Error('AI 输出格式不正确（未得到商品数组）');
      const byIndex = new Map(parsed.items.map(x => [Number(x.index), x]));
      chunk.forEach((it, k) => {
        const r = byIndex.get(k) || {};
        results.push({
          id: it.id, offerId: it.offerId, title: it.title, price: it.price, status: it.status, source: it.source,
          optimizedTitle: String(r.optimizedTitle || it.title).slice(0, 60),
          forbiddenWords: Array.isArray(r.forbiddenWords) ? r.forbiddenWords : [],
          issues: Array.isArray(r.issues) ? r.issues : [],
          salesPoints: String(r.salesPoints || ''),
          descSuggestion: String(r.descSuggestion || ''),
        });
      });
    }
    return this._buildReport(results, { mode: 'ai', provider: cfg.providerName || cfg.model, model: cfg.model });
  }

  // ---------- 演示模式（本地规则引擎） ----------
  _demoOperate(list, { onProgress }) {
    onProgress('演示模式：本地规则诊断中…');
    const results = list.map(it => {
      const issues = [];
      const forbiddenWords = [];
      const t = it.title || '';
      if (t.length > 30) issues.push(`标题过长(${t.length}字)，建议 30 字内`);
      if (t.length < 8) issues.push('标题过短，信息量不足');
      for (const w of FORBIDDEN_WORDS) {
        if (t.includes(w)) { forbiddenWords.push(w); }
      }
      if (forbiddenWords.length) issues.push('命中广告法违禁词：' + forbiddenWords.join('/'));
      if (it.price == null || it.price <= 0) issues.push('无价格或价格为 0，请核实');
      if (it.status === 'failed') issues.push('上次发布失败，请先重试发布');
      if (!issues.length) issues.push('无明显问题');
      // 演示模式的"优化标题"：去违禁词（演示用简单替换，正式用 AI）
      let optimizedTitle = t;
      for (const [w, rep] of Object.entries(DEMO_REPLACES)) {
        if (optimizedTitle.includes(w)) optimizedTitle = optimizedTitle.split(w).join(rep);
      }
      if (optimizedTitle.length > 30) optimizedTitle = optimizedTitle.slice(0, 30);
      const tail = optimizedTitle === t ? '' : '（演示：仅演示用词替换，正式优化请配 AI Key）';
      return {
        id: it.id, offerId: it.offerId, title: t, price: it.price, status: it.status, source: it.source,
        optimizedTitle: optimizedTitle === t ? '' : optimizedTitle,
        forbiddenWords, issues,
        salesPoints: '',
        descSuggestion: '',
        demoNote: tail,
      };
    });
    return this._buildReport(results, { mode: 'demo', provider: '本地规则引擎', model: '演示模式（无需Key）' });
  }

  _buildReport(results, meta) {
    let forbidden = 0, longTitle = 0, priceIssue = 0, failed = 0;
    for (const r of results) {
      const its = r.issues || [];
      if (its.some(x => /违禁词/.test(x))) forbidden++;
      if (its.some(x => /过长/.test(x))) longTitle++;
      if (its.some(x => /价格/.test(x))) priceIssue++;
      if (r.status === 'failed') failed++;
    }
    return {
      ok: true,
      mode: meta.mode,
      provider: meta.provider,
      model: meta.model,
      stats: { total: results.length, forbidden, longTitle, priceIssue, failed },
      items: results,
    };
  }

  _parseJsonLoose(raw) {
    const s = String(raw || '').trim();
    try { return JSON.parse(s); } catch (_) {}
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    // 去代码块围栏
    const m2 = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m2) { try { return JSON.parse(m2[1]); } catch (_) {} }
    return null;
  }

  _buildPrompt(body) {
    return `下面是本店商品列表 JSON：
${body}

请对每个商品分析并输出 JSON（字段严格使用英文）：
{"items":[{"index":0,"optimizedTitle":"优化后的标题(≤30字，保留核心卖点+类目词，去掉无效词/违禁词)","forbiddenWords":["命中的违禁词"],"issues":["问题描述"],"salesPoints":"2-3个卖点，顿号分隔","descSuggestion":"50字内详情卖点文案"}]}
要求：index 与输入一致；无违禁词时 forbiddenWords 为空数组；无问题时 issues 写"无明显问题"。`;
  }

  /**
   * AI推荐上传设置参数
   * 根据商品库的商品信息（标题/价格/类目分布），让AI推荐合适的上传配置
   * @param items 商品库样本 [{title, price, source}]
   * @returns {ok, recommendations, message}
   */
  async recommendSettings(items) {
    const cfg = this.getConfig();
    if (!cfg.apiKey) {
      // 演示模式：本地规则推荐
      return this._demoRecommend(items || []);
    }
    if (!cfg.baseURL || !cfg.model) return { ok: false, message: '请先完善AI配置（接口地址+模型名）' };

    const list = (items || []).filter(it => it && it.title).slice(0, 100);
    if (!list.length) return { ok: false, message: '商品库为空，请先采集商品' };

    // 商品信息摘要（只取标题+价格，减少token）
    const summary = list.map(it => ({
      title: String(it.title || '').slice(0, 60),
      price: it.price != null ? it.price : '',
    }));

    const messages = [
      {
        role: 'system',
        content: '你是资深淘宝电商运营专家，精通1688到淘宝的铺货策略。根据商品信息推荐最优上架设置参数。只输出JSON，不要任何解释。',
      },
      {
        role: 'user',
        content: `以下是1688采集到的商品样本（标题+成本价）：
${JSON.stringify(summary)}

请根据这些商品的特征，推荐淘宝上架设置参数，输出JSON：
{
  "pricePercent": 35,
  "priceMode": "percent",
  "titleRebuild": true,
  "brandOther": true,
  "brandName": "",
  "day7": true,
  "stock": 99,
  "uploadWay": 2,
  "categoryKey": "推荐的类目关键词",
  "shipTemplate": "推荐的运费模板名",
  "filterTitle": true,
  "reason": "推荐理由简述"
}

字段说明：
- pricePercent: 加价百分比(15~80)，低价商品加价高、高价商品加价低
- priceMode: "percent"=百分比加价 | "fixed"=固定加价 | "stepped"=阶梯加价
- titleRebuild: 是否自动重组标题(去除1688批发词)
- brandOther: 是否将品牌改为other/其他(避免侵权)
- brandName: 自定义品牌名(空则不设)
- day7: 是否开启7天无理由退货
- stock: 推荐库存数量(50~200)
- uploadWay: 0=立即上架 | 2=放入仓库(推荐先入仓库)
- categoryKey: 根据商品类目推荐的淘宝分类关键词
- shipTemplate: 运费模板名(不确定时留空)
- filterTitle: 是否过滤重复标题
- reason: 推荐理由(50字内)

要求：根据商品价格区间和类目特征给出合理建议，低价小商品加价比例适当提高。`,
      },
    ];

    try {
      const raw = await this.chat(cfg, messages, { maxTokens: 2048, temperature: 0.3, timeoutMs: 60000 });
      const parsed = this._parseJsonLoose(raw);
      if (!parsed) return { ok: false, message: 'AI返回格式无法解析' };
      return { ok: true, recommendations: parsed, message: 'AI推荐完成' };
    } catch (e) {
      return { ok: false, message: 'AI推荐失败: ' + e.message };
    }
  }

  /** 演示模式：本地规则推荐上传设置 */
  _demoRecommend(items) {
    const list = items || [];
    if (!list.length) return { ok: false, message: '商品库为空，请先采集商品' };
    // 统计价格分布
    const prices = list.map(it => Number(it.price)).filter(p => isFinite(p) && p > 0);
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    // 低价商品加价高，高价加价低
    let percent = 35;
    if (avg > 0) {
      if (avg <= 10) percent = 50;
      else if (avg <= 50) percent = 35;
      else if (avg <= 200) percent = 22;
      else percent = 15;
    }
    // 从标题提取类目关键词
    let categoryKey = '';
    const titles = list.map(it => String(it.title || ''));
    const commonWords = {};
    for (const t of titles) {
      const words = t.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      for (const w of words) { commonWords[w] = (commonWords[w] || 0) + 1; }
    }
    const sorted = Object.entries(commonWords).sort((a, b) => b[1] - a[1]);
    if (sorted.length) categoryKey = sorted[0][0];

    return {
      ok: true,
      recommendations: {
        pricePercent: percent,
        priceMode: 'percent',
        titleRebuild: true,
        brandOther: true,
        brandName: '',
        day7: true,
        stock: 99,
        uploadWay: 2,
        categoryKey,
        shipTemplate: '',
        filterTitle: true,
        reason: `演示模式：基于${list.length}个商品分析，平均成本¥${avg.toFixed(1)}，推荐加价${percent}%`,
      },
      message: '演示模式推荐完成（配置AI Key后可获得更精准推荐）',
    };
  }
}

module.exports = { AiEngine, PROVIDERS, FORBIDDEN_WORDS };