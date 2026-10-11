// ============================================================
// 简易盯盘台 Pro - 核心逻辑
// 多数据源 + 品类识别 + 搜索联想 + 迷你走势图 + 成交量异动
// ============================================================

'use strict';

// ============================================================
// 1. 常量与配置
// ============================================================
const STORAGE_KEY = 'simple_stock_monitor_v2';
const DEMO_MODE_KEY = 'simple_stock_monitor_demo';

// 品类定义
const CATEGORY = {
  STOCK_A: 'stock_a',     // A股
  INDEX: 'index',         // 指数
  ETF: 'etf',             // ETF
  CONVERTIBLE: 'cb',      // 可转债
  FUND: 'fund',           // 场外基金
  HK: 'hk',               // 港股
  UNKNOWN: 'unknown'
};

const CATEGORY_NAME = {
  [CATEGORY.STOCK_A]: '股票',
  [CATEGORY.INDEX]: '指数',
  [CATEGORY.ETF]: 'ETF',
  [CATEGORY.CONVERTIBLE]: '转债',
  [CATEGORY.FUND]: '基金',
  [CATEGORY.HK]: '港股',
  [CATEGORY.UNKNOWN]: '其他'
};

// 轮询间隔配置（毫秒）
const POLL_INTERVALS = {
  normal: 300,     // 正常区间 - 交易时间 0.3 秒
  close: 200,      // 接近阈值
  veryClose: 150,  // 非常接近阈值
  closed: 300000   // 非交易时段：5 分钟一次，避免空转
};

// 阈值接近判定（百分比）
const THRESHOLD_CLOSE_PCT = 1;
const THRESHOLD_VERY_CLOSE_PCT = 0.3;

// 量比属分钟级慢变量，无需跟随行情高频刷新
const VOL_RATIO_TTL = 15000;

// ============================================================
// 2. 全局状态
// ============================================================
let state = {
  targets: [],
  logs: [],
  settings: {
    soundEnabled: true,
    notifEnabled: false,
    demoMode: false,
    reviewOpen: false
  },
  notifPermission: 'default',
  activeCategory: 'all',
  sortByChange: false,
  marketIndices: [],
  _pollTimer: null,
  _marketTimer: null,
  _lastPrices: {},
  _sparkCache: {}
};

// 大盘指数列表
const MARKET_INDICES = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399001', name: '深证成指' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000300', name: '沪深300' },
  { code: 'sh000688', name: '科创50' },
];

// 热门标的预设
const HOT_TARGETS = [
  { group: '热门ETF', items: [
    { code: 'sh510300', name: '沪深300ETF' },
    { code: 'sh510500', name: '中证500ETF' },
    { code: 'sh588000', name: '科创50ETF' },
    { code: 'sz159915', name: '创业板ETF' },
    { code: 'sh512100', name: '中证1000ETF' },
  ]},
  { group: '热门基金', items: [
    { code: '110011', name: '易方达优质精选' },
    { code: '005827', name: '易方达蓝筹精选' },
    { code: '163406', name: '兴全合润' },
    { code: '519066', name: '汇添富蓝筹稳健' },
  ]},
  { group: '热门股票', items: [
    { code: 'sh600519', name: '贵州茅台' },
    { code: 'sz300750', name: '宁德时代' },
    { code: 'sh601318', name: '中国平安' },
    { code: 'sz000858', name: '五粮液' },
  ]},
];

// ============================================================
// 3. 品类识别器
//
// 判定分两条路径，边界明确：
//   A. 带市场前缀（sh/sz/hk）→ 本地号段规则，可靠，直接判定。
//   B. 无前缀纯数字         → 本地规则不可靠，必须走权威数据源。
//
// 为什么 B 必须走接口（实测东方财富 suggest 接口的 QuoteID 字段）：
//   000001 → 0.000001 平安银行 / 1.000001 上证指数 / 150.000001 华夏成长混合
//   519066 → 1.519066 添富蓝筹(场内LOF) / 150.519066 汇添富蓝筹稳健(场外)
//   163406 → 0.163406 兴全合润LOF / 150.163406 兴全合润混合A
// 场内外基金号段系统性重叠，任何纯正则判定都会出错，
// 因此无前缀输入一律由 resolveByRemote() 向数据源问明归属。
// ============================================================

// 拆分代码 → { market, num, explicit }
function splitCode(rawCode) {
  const code = String(rawCode || '').trim().toLowerCase();
  if (code.startsWith('hk')) return { market: 'hk', num: code.slice(2), explicit: true };
  if (code.startsWith('sh')) return { market: 'sh', num: code.slice(2), explicit: true };
  if (code.startsWith('sz')) return { market: 'sz', num: code.slice(2), explicit: true };
  // 港股 5 位数字（如 00700）只可能是港股，无歧义
  if (/^0\d{4}$/.test(code)) return { market: 'hk', num: code, explicit: true };
  return { market: '', num: code, explicit: false };
}

// 带前缀时按「市场 + 号段」判定。号段在单个市场内不重叠，可靠。
function classifyExplicit(market, num) {
  if (market === 'hk') return CATEGORY.HK;
  if (!/^\d{6}$/.test(num)) return CATEGORY.UNKNOWN;

  // 指数：沪市 000xxx，深市 399xxx。两市号段需结合市场才能区分，
  // 因为 sh000001 是指数而 sz000001 是 A 股。
  if (market === 'sh' && num.startsWith('000')) return CATEGORY.INDEX;
  if (market === 'sz' && num.startsWith('399')) return CATEGORY.INDEX;

  // 可转债：沪市 110/111/113/118，深市 123/127/128
  if (/^(110|111|113|118|123|127|128)/.test(num)) return CATEGORY.CONVERTIBLE;

  // ETF/LOF：沪市 51x/52x/56x/58x，深市 15x/16x/18x
  if (market === 'sh' && /^(51|52|56|58)/.test(num)) return CATEGORY.ETF;
  if (market === 'sz' && /^(15|16|18)/.test(num)) return CATEGORY.ETF;

  // A股：沪市主板 600/601/603/605、科创板 688/689、B股 900；
  //      深市主板 000/001/002/003、创业板 300/301
  if (market === 'sh' && /^(60|68|90)/.test(num)) return CATEGORY.STOCK_A;
  if (market === 'sz' && /^(00[0-3]|30[01])/.test(num)) return CATEGORY.STOCK_A;

  return CATEGORY.UNKNOWN;
}

// 无前缀时本地无法判定品类，返回 UNKNOWN 交由数据源解析。
// 仅对「本地可确定市场且品类唯一」的少数号段给出快速判定，用于
// 接口不可用时的降级显示，不作为最终结论。
function classifyHeuristic(num) {
  if (!/^\d{6}$/.test(num)) return CATEGORY.UNKNOWN;
  // 深市指数 399xxx：沪深两市只有深市使用 399 号段，无重叠
  if (num.startsWith('399')) return CATEGORY.INDEX;
  return CATEGORY.UNKNOWN;
}

function detectCategory(rawCode) {
  const { market, num, explicit } = splitCode(rawCode);
  if (explicit) return classifyExplicit(market, num);
  return classifyHeuristic(num);
}

function isExplicitCode(rawCode) {
  return splitCode(rawCode).explicit;
}

function normalizeCode(rawCode) {
  const { market, num, explicit } = splitCode(rawCode);
  if (explicit) return market + num;
  return num;
}

// ============================================================
// 4. 多数据源引擎
// ============================================================

// --- JSONP 工具 ---
function jsonp(url, callbackName, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout'));
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      if (window[callbackName]) delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP error'));
    };

    script.src = url;
    document.body.appendChild(script);
  });
}

// --- 天天基金适配器（场外基金估值）---
class FundAdapter {
  constructor() {
    this.baseUrl = 'https://fundgz.1234567.com.cn/js/';
  }

  async fetch(code) {
    const pureCode = code.replace(/^[a-z]+/, '');
    const url = this.baseUrl + pureCode + '.js?rt=' + Date.now();

    // 天天基金接口的回调名固定为 jsonpgz，调用方无法自定义。
    // 多个基金并发请求时后一个会覆盖前一个的全局回调，
    // 导致响应被丢弃。此处串行化以保证回调不冲突。
    this._chain = this._chain || Promise.resolve();
    const run = this._chain.then(() => this._fetchOne(pureCode, url));
    // 无论成败都要让链继续，避免一次失败卡死后续请求
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async _fetchOne(pureCode, url) {
    const cbName = 'jsonpgz';

    try {
      const data = await jsonp(url, cbName, 6000);
      if (!data || !data.fundcode) return null;

      const price = parseFloat(data.gsz) || 0;
      const prevClose = parseFloat(data.dwjz) || 0;

      return {
        code: pureCode,
        name: data.name || '',
        price: price,
        prevClose: prevClose,
        // 原实现 change 硬编码为 0，导致涨跌额恒为 0
        change: prevClose > 0 ? price - prevClose : 0,
        changePct: parseFloat(data.gszzl) || 0,
        open: 0,
        high: 0,
        low: 0,
        volume: 0,
        amount: 0,
        time: data.gztime || '',
        category: CATEGORY.FUND,
        isFundEstimate: true
      };
    } catch (e) {
      return null;
    }
  }
}

// --- 腾讯财经适配器（主数据源）---
// 批量请求分片：一次请求过多代码会生成超长 URL（部分代理会截断），
// 且自选数十只时响应时间显著上升。按 BATCH_SIZE 分片后串行请求，
// 既控制单请求规模，也天然限制并发。
const BATCH_SIZE = 40;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- K线源抗 WAF 配置（须定义在类外，不能写在 class 体内）---
const KLINE_HOSTS = ['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn'];
const KLINE_MIN_GAP_MS = 1500;              // 两次 K线请求的最小间隔
const KLINE_CACHE_TTL = 30 * 60 * 1000;     // K线缓存有效期
const KLINE_WAF_BACKOFF_MAX = 10 * 60 * 1000;

class TencentAdapter {

  // 对外入口：自动分片
  async fetch(codes) {
    if (!codes || codes.length === 0) return {};

    const batches = chunkArray(codes, BATCH_SIZE);
    if (batches.length === 1) return this._fetchBatch(codes);

    const merged = {};
    for (const batch of batches) {
      try {
        const r = await this._fetchBatch(batch);
        Object.assign(merged, r);
      } catch (e) {
        // 单片失败不影响其余分片
        console.warn('腾讯分片请求失败', batch.length, e.message);
      }
    }
    return merged;
  }

  async _fetchBatch(codes) {
    const url = this.baseUrl + codes.join(',');
    const script = document.createElement('script');
    script.charset = 'GBK';
    const results = {};

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('tencent timeout'));
      }, 5000);

      function cleanup() {
        clearTimeout(timer);
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      script.onload = () => {
        try {
          codes.forEach(code => {
            const varName = 'v_' + code;
            const val = window[varName];
            if (val) {
              results[code] = this.parseTencentData(code, val);
              delete window[varName];
            }
          });
          cleanup();
          resolve(results);
        } catch (e) {
          cleanup();
          reject(e);
        }
      };

      script.onerror = () => {
        cleanup();
        reject(new Error('tencent script error'));
      };

      script.src = url + '&_=' + Date.now();
      document.body.appendChild(script);
    });
  }

  // 日K线源（腾讯）。
  //
  // WAF 实测结论（2026-10-11，多次重复验证）：
  //   · 只要带 param 参数即可能触发腾讯 WAF，返回 501 跳转页
  //   · 两个域名 web.ifzq / ifzq 都会被拦，不存在"好域名"
  //   · **触发条件是请求频率累积**，而非域名本身：
  //     低频请求可正常返回，连续高频则必被封
  //   · 该接口不支持 JSONP（cb/callback/jsoncallback 均无效），
  //     且 web.ifzq 带 CORS 头 *，故用 fetch + web 域名
  //
  //   5) WAF 命中后指数退避，冷却期间直接用缓存

  constructor() {
    this.baseUrl = 'https://qt.gtimg.cn/q=';
    this._klineChain = Promise.resolve();
    this._klineLastAt = 0;
    this._klineHostIdx = 0;
    this._klineCache = new Map();   // key: `${symbol}|${count}|${fq}`
    this._klineWafUntil = 0;
    this._klineWafStreak = 0;
  }

  // 全局串行 + 最小间隔节流
  async _throttledFetch(url, symbol) {
    const run = async () => {
      // 距上次请求不足最小间隔时，等待补足
      const wait = this._klineLastAt + KLINE_MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      this._klineLastAt = Date.now();
      const host = KLINE_HOSTS[this._klineHostIdx % KLINE_HOSTS.length];
      this._klineHostIdx++;
      const full = url.replace('__HOST__', host);

      const resp = await fetch(full, { cache: 'no-store' });
      const text = await resp.text();
      return { text, host };
    };

    // 串行化：无论前一个成功与否，链都要继续
    const task = this._klineChain.then(run, run);
    this._klineChain = task.then(() => {}, () => {});
    return task;
  }

  async fetchKline(code, count = 60) {
    return this._fetchKlineRaw(code, count, 'qfq');
  }

  // 后复权K线：用于计算除权因子，识别除权除息并校正触发价
  async fetchKlineHfq(code, count = 60) {
    return this._fetchKlineRaw(code, count, 'hfq');
  }

  async _fetchKlineRaw(code, count, fq) {
    const symbol = normalizeCode(code);
    if (!/^(sh|sz)\d{6}$/.test(symbol)) return [];

    const cacheKey = `${symbol}|${count}|${fq}`;
    const cached = this._klineCache.get(cacheKey);

    // 命中新鲜缓存，零请求
    if (cached && Date.now() - cached.time < KLINE_CACHE_TTL) {
      return cached.data;
    }

    // WAF 冷却期内：宁可用过期缓存，也不继续触发封禁
    if (Date.now() < this._klineWafUntil) {
      if (cached) return cached.data;
      return [];
    }

    const url = `https://__HOST__/appstock/app/fqkline/get` +
                `?param=${symbol},day,,,${count},${fq}&_=${Date.now()}`;

    let text;
    try {
      const r = await this._throttledFetch(url, symbol);
      text = r.text;
    } catch (e) {
      return cached ? cached.data : [];
    }

    // WAF 返回 501 跳转页（HTML），据此识别并退避
    if (!text || !text.trim().startsWith('{')) {
      this._klineWafStreak++;
      const backoff = Math.min(
        KLINE_MIN_GAP_MS * Math.pow(2, this._klineWafStreak),
        KLINE_WAF_BACKOFF_MAX
      );
      this._klineWafUntil = Date.now() + backoff;
      markSource('kline', false, 'WAF');
      return cached ? cached.data : [];
    }

    this._klineWafStreak = 0;

    let rows;
    try {
      const data = JSON.parse(text);
      if (!data || data.code !== 0 || !data.data || !data.data[symbol]) {
        return cached ? cached.data : [];
      }
      const node = data.data[symbol];
      rows = (fq === 'hfq' ? node.hfqday : node.qfqday) || node.day || [];
    } catch (e) {
      return cached ? cached.data : [];
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return cached ? cached.data : [];
    }

    markSource('kline', true, '');

    // 行格式：[日期, 开, 收, 高, 低, 成交量(手)]
    const result = rows.map(r => ({
      date: r[0],
      open: parseFloat(r[1]) || 0,
      close: parseFloat(r[2]) || 0,
      high: parseFloat(r[3]) || 0,
      low: parseFloat(r[4]) || 0,
      // 腾讯 K 线成交量单位为「手」，统一换算为「股」
      volume: lotsToShares(r[5], CATEGORY.STOCK_A),
      amount: 0
    }));

    this._klineCache.set(cacheKey, { data: result, time: Date.now() });
    return result;
  }

  parseTencentData(code, rawStr) {
    if (!rawStr || rawStr.trim() === '') return null;
    const fields = rawStr.split('~');
    if (fields.length < 39) return null;

    const cat = detectCategory(code);
    const price = parseFloat(fields[3]) || 0;
    const prevClose = parseFloat(fields[4]) || 0;

    // 涨跌额/涨跌幅由本项目自行计算，不直接采信接口字段，
    // 避免接口在不同市场下口径不一致（实测指数与个股均有差异）。
    const change = prevClose > 0 ? price - prevClose : 0;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      code: code,
      name: fields[1] || '',
      price: price,
      prevClose: prevClose,
      open: parseFloat(fields[5]) || 0,
      high: parseFloat(fields[33]) || 0,
      low: parseFloat(fields[34]) || 0,
      // 量纲校准：手 → 股，万元 → 元
      volume: lotsToShares(fields[36] || fields[6], cat),
      amount: wanToYuan(fields[37]),
      change: change,
      changePct: changePct,
      time: fields[30] || '',
      category: cat,
      pe: parseFloat(fields[39]) || 0,
      turnoverRate: parseFloat(fields[38]) || 0,
      amplitude: parseFloat(fields[43]) || 0,
      // 涨跌停价（实测 fields[47]/[48] 与「昨收×涨跌幅限制」完全吻合）
      limitUp: parseFloat(fields[47]) || 0,
      limitDown: parseFloat(fields[48]) || 0
    };
  }

  // 涨跌停状态。
  // 用于识别「一字板」场景：此时价格被封在涨跌停价上不再变动，
  // 依赖价格穿越的提醒会永久静默失效，需改由涨停状态驱动。
  static limitState(price, limitUp, limitDown) {
    const p = parseFloat(price);
    if (!isFinite(p) || p <= 0) return 'none';

    const up = parseFloat(limitUp);
    const dn = parseFloat(limitDown);
    // 容差取最小价差的 0.3%，覆盖不同品种的最小变动价位
    const tol = Math.max(p * 0.003, 0.01);

    if (isFinite(up) && up > 0 && Math.abs(p - up) <= tol) return 'limitUp';
    if (isFinite(dn) && dn > 0 && Math.abs(p - dn) <= tol) return 'limitDown';
    return 'none';
  }
}

// ============================================================
// 4.5 量纲校准层
//
// 实测结论（腾讯 qt.gtimg.cn，2026-10-11，均以「均价≈现价」验证）：
//   fields[6]  / fields[36]  成交量，单位「手」，A股 1 手 = 100 股
//   fields[37]               成交额，单位「万元」
//   fields[9]                并非成交额（实测等于现价），不可使用
//
//   验证示例（贵州茅台）：成交量 35111 手、成交额 445322 万元
//     均价 = 4,453,223,189 元 ÷ (35111 × 100 股) = 1268.33 元 ≈ 现价 1263.00 ✓
//
// 本项目内部统一口径：volume 单位为「股」，amount 单位为「元」。
// 各数据源在适配器入口完成换算，渲染层与规则层不再关心原始量纲。
// ============================================================

const SHARES_PER_LOT = 100;          // A 股 1 手 = 100 股
const WAN = 10000;                   // 1 万元

// 手 → 股。港股无「手」概念，其成交量本身即为股数，不换算。
function lotsToShares(lots, category) {
  const n = parseFloat(lots);
  if (!isFinite(n) || n === 0) return 0;
  if (category === CATEGORY.HK) return n;
  return n * SHARES_PER_LOT;
}

// 万元 → 元
function wanToYuan(wan) {
  const n = parseFloat(wan);
  if (!isFinite(n) || n === 0) return 0;
  return n * WAN;
}

// --- 除权除息处理 ---
//
// 问题：用户设置的触发价是「除权前」的名义价。若次日除权，
// 实际价格会向下跳空（如 10 送 10 后从 20 变 10），
// 原本「跌破 18」的提醒会在除权瞬间被错误触发。
//
// 解法：腾讯同时提供前复权(qfqday)与后复权(hfqday)数据，
// 二者比值即为复权因子。实测茅台后复权/前复权 = 7.055570，
// 说明区间内发生过多次分红送转。
//
// 用法：除权因子 = hfq_close / qfq_close（同一根K线）
//      除权后实际价 = 名义触发价 / 因子  → 转换为可比较的复权口径
function calcAdjustFactor(qfqClose, hfqClose) {
  const q = parseFloat(qfqClose);
  const h = parseFloat(hfqClose);
  if (!isFinite(q) || !isFinite(h) || q <= 0 || h <= 0) return 1;
  return h / q;
}

// 把除权前的触发价换算到除权后的口径。
// factor 为「后复权/前复权」比值；1 表示区间内无除权。
function adjustPriceForExDividend(nominalPrice, factor) {
  const p = parseFloat(nominalPrice);
  const f = parseFloat(factor);
  if (!isFinite(p) || p <= 0) return p;
  if (!isFinite(f) || f <= 0 || Math.abs(f - 1) < 1e-9) return p;
  return p / f;
}

// 判断区间内是否发生过除权除息（因子偏离 1 即说明有）
function hasExDividend(factor) {
  const f = parseFloat(factor);
  return isFinite(f) && Math.abs(f - 1) > 1e-9;
}

// 成交量格式化。内部值已是「股」，此处只做量级缩写，不做换算。
// 保留 1 位小数以区分「手」口径下的细微差异。
function formatVolume(shares) {
  const v = parseFloat(shares);
  if (!isFinite(v) || v === 0) return '--';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿股';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + '万股';
  return Math.round(v) + '股';
}

// 成交额格式化。内部值已是「元」。
function formatAmount(yuan) {
  const v = parseFloat(yuan);
  if (!isFinite(v) || v === 0) return '--';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return Math.round(v) + '';
}

// --- 东方财富适配器（备用 + K线 + 搜索）---
class EastMoneyAdapter {
  constructor() {
    this.baseUrl = 'https://push2delay.eastmoney.com/api/qt/ulist.np/get';
    this.klineUrl = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
    this.searchUrl = 'https://searchapi.eastmoney.com/api/suggest/get';
  }

  codeToSecid(code) {
    const pureCode = code.replace(/^[a-z]+_?/, '');
    const cat = detectCategory(code);

    if (cat === CATEGORY.HK) {
      return '116.' + pureCode;
    }

    // 市场前缀是唯一可靠依据。原先对指数与个股写了完全相同的
    // return 分支（条件判断无任何作用），实际靠前缀兜住。
    if (code.startsWith('sh')) return '1.' + pureCode.replace(/^sh/, '');
    if (code.startsWith('sz')) return '0.' + pureCode.replace(/^sz/, '');

    // 无前缀时按号段推断市场
    if (/^[69]/.test(pureCode)) return '1.' + pureCode;
    if (/^[03]/.test(pureCode)) return '0.' + pureCode;

    return '0.' + pureCode;
  }

  // 对外入口：自动分片，单片失败不影响其余分片
  async fetch(codes) {
    if (!codes || codes.length === 0) return {};

    const batches = chunkArray(codes, BATCH_SIZE);
    if (batches.length === 1) return await this._fetchBatch(codes);

    const merged = {};
    for (const batch of batches) {
      try {
        Object.assign(merged, await this._fetchBatch(batch));
      } catch (e) {
        console.warn('东财分片请求失败', batch.length, e.message);
      }
    }
    return merged;
  }

  async _fetchBatch(codes) {
    const secids = codes.map(c => this.codeToSecid(c)).join(',');
    const cbName = 'em_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const url = `${this.baseUrl}?fltt=2&invt=2&fields=f2,f3,f4,f5,f6,f7,f8,f12,f14,f15,f16,f17,f18&secids=${encodeURIComponent(secids)}&cb=${cbName}&_=${Date.now()}`;

    try {
      const data = await jsonp(url, cbName, 8000);
      const results = {};

      if (data && data.data && data.data.diff) {
        data.data.diff.forEach((item, idx) => {
          const origCode = codes[idx] || codes[0];
          const cat = detectCategory(origCode);

          const price = parseFloat(item.f2) || 0;
          const change = parseFloat(item.f4) || 0;
          const changePct = parseFloat(item.f3) || 0;

          // 接口未直接给昨收。原先用 price/(1+涨幅) 反推，
          // 在 price 为 0（停牌/无数据）时会得到 Infinity/NaN，
          // 进而污染涨跌幅计算。此处改为由「涨跌额」正向推算，
          // 并在 price 缺失时回退为 0。
          const prevClose = (price !== 0 && isFinite(price / (1 + changePct / 100)))
            ? price / (1 + changePct / 100)
            : 0;

          results[origCode] = {
            code: origCode,
            name: item.f14 || '',
            price: price,
            prevClose: prevClose,
            change: change,
            changePct: changePct,
            open: parseFloat(item.f17) || 0,
            high: parseFloat(item.f15) || 0,
            low: parseFloat(item.f16) || 0,
            // 东财 f5 成交量单位为「手」，f6 成交额单位为「元」
            volume: lotsToShares(item.f5, cat),
            amount: parseFloat(item.f6) || 0,
            volRatio: parseFloat(item.f8) || 0,
            amplitude: parseFloat(item.f7) || 0,
            time: '',
            category: cat
          };
        });
      }

      return results;
    } catch (e) {
      return {};
    }
  }

  async fetchKline(code, klt = 101, lmt = 60) {
    const secid = this.codeToSecid(code);
    const cbName = 'em_kline_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const fields1 = 'f1,f2,f3,f4,f5,f6';
    const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
    const url = `${this.klineUrl}?secid=${secid}&klt=${klt}&fqt=1&lmt=${lmt}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=${fields1}&fields2=${fields2}&end=20500101&cb=${cbName}&_=${Date.now()}`;

    try {
      const data = await jsonp(url, cbName, 10000);
      if (!data || !data.data || !data.data.klines) return [];

      return data.data.klines.map(line => {
        const parts = line.split(',');
        return {
          date: parts[0],
          open: parseFloat(parts[1]) || 0,
          close: parseFloat(parts[2]) || 0,
          high: parseFloat(parts[3]) || 0,
          low: parseFloat(parts[4]) || 0,
          // 东财 K 线成交量单位为「手」，统一换算为「股」
          volume: lotsToShares(parts[5], CATEGORY.STOCK_A),
          amount: parseFloat(parts[6]) || 0
        };
      });
    } catch (e) {
      return [];
    }
  }

  async search(keyword, maxCount = 10) {
    const cbName = 'em_search_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const type = '14';
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=${type}&token=D43BF722C8E33BDC906FB84D85E326E8&count=${maxCount}&cb=${cbName}&_=${Date.now()}`;

    try {
      const data = await jsonp(url, cbName, 5000);
      if (!data || !data.QuotationCodeTable || !data.QuotationCodeTable.Data) return [];

      return data.QuotationCodeTable.Data.map(item => ({
        code: item.Code || '',
        name: item.Name || '',
        market: item.MarketType || item.Market || '',
        type: item.SecurityType || '',
        typeName: item.SecurityTypeName || '',
        quoteId: item.QuoteID || ''
      })).filter(item => isSupportedMarket(item.market)).slice(0, maxCount);
    } catch (e) {
      return [];
    }
  }
}

// 支持的市场。实测取值：
//   1=上交所  0=深交所  6=场外基金  105=美股  116=港股  155/156=英股
// 原实现只放行 1/0/105/116，导致 MarketType=6 的场外基金被整体丢弃，
// 「热门基金」预设因此全部搜不到。
function isSupportedMarket(market) {
  return ['0', '1', '6', '105', '116'].includes(String(market));
}

// QuoteID 是数据源给出的权威归属，格式为「市场号.代码」，直接据此
// 推导规范代码与品类，不依赖本地正则猜测。
//   0.xxxxxx → 深市    1.xxxxxx → 沪市    116.xxxxx → 港股
//   150.xxxxx → 场外基金
function resolveByQuoteId(item) {
  const quoteId = String(item.quoteId || '');
  const m = quoteId.match(/^(\d+)\.(.+)$/);
  if (!m) return null;

  const [, marketNo, num] = m;
  let code = null;
  let category = CATEGORY.UNKNOWN;

  if (marketNo === '0') {
    code = 'sz' + num;
    category = classifyExplicit('sz', num);
  } else if (marketNo === '1') {
    code = 'sh' + num;
    category = classifyExplicit('sh', num);
  } else if (marketNo === '116') {
    code = 'hk' + num;
    category = CATEGORY.HK;
  } else if (marketNo === '150') {
    // 场外基金：保持纯 6 位，FundAdapter 按此请求估值接口
    code = num;
    category = CATEGORY.FUND;
  } else {
    return null;
  }

  if (category === CATEGORY.UNKNOWN) return null;
  return { code, name: item.name, category };
}

// --- 行情聚合器 ---
class QuoteAggregator {
  constructor() {
    this.tencent = new TencentAdapter();
    this.eastmoney = new EastMoneyAdapter();
    this.fund = new FundAdapter();
    this.tencentFailCount = 0;
    this.useBackup = false;
    this._volRatioAt = 0;
  }

  async fetchAll(targets, onPartialResult = null) {
    if (!targets || targets.length === 0) return {};

    const stockTargets = [];
    const fundTargets = [];

    targets.forEach(t => {
      const cat = t.category || detectCategory(t.code);
      if (cat === CATEGORY.FUND && !t.code.startsWith('sh') && !t.code.startsWith('sz')) {
        fundTargets.push(t);
      } else {
        stockTargets.push(t);
      }
    });

    const results = {};

    const stockPromise = stockTargets.length > 0 ? 
      this.fetchStocks(stockTargets, onPartialResult) : Promise.resolve({});
    const fundPromise = fundTargets.length > 0 ? 
      this.fetchFunds(fundTargets, onPartialResult) : Promise.resolve({});

    const [stockResults, fundResults] = await Promise.all([stockPromise, fundPromise]);
    Object.assign(results, stockResults, fundResults);

    return results;
  }

  async fetchStocks(targets, onPartialResult = null) {
    const codes = targets.map(t => normalizeCode(t.code));
    const merged = {};

    try {
      const tcResult = await this.tencent.fetch(codes);
      markSource('tencent', Object.keys(tcResult).length > 0, 'empty response');
      if (Object.keys(tcResult).length > 0) {
        this.tencentFailCount = 0;
        for (const k in tcResult) {
          if (tcResult[k]) merged[k] = tcResult[k];
        }
      } else {
        this.tencentFailCount++;
        throw new Error('Tencent returned empty');
      }
    } catch (e) {
      markSource('tencent', false, e.message);
      console.error('Tencent fetch failed, trying EastMoney', e);
      try {
        const emResult = await this.eastmoney.fetch(codes);
        markSource('eastmoney', Object.keys(emResult).length > 0, 'empty response');
        for (const k in emResult) {
          if (emResult[k]) merged[k] = emResult[k];
        }
        // 腾讯已失败，本轮不再重复请求东财补充量比
        return merged;
      } catch (e2) {
        markSource('eastmoney', false, e2.message);
        console.error('EastMoney also failed', e2);
        return merged;
      }
    }

    // 腾讯成功时，按需补充东财的量比（volRatio）。
    // 原实现每轮都无条件请求东财，仅为取这一个字段，
    // 使单轮请求量翻倍；又因轮询间隔最短 150ms，
    // 实际放大约 13 次/秒，一个交易日可达近 10 万次请求。
    // 量比是分钟级慢变量，改为按 VOL_RATIO_TTL 缓存刷新即可。
    if (this._volRatioDue()) {
      try {
        const emResult = await this.eastmoney.fetch(codes);
        for (const k in emResult) {
          if (emResult[k] && emResult[k].volRatio && merged[k]) {
            merged[k].volRatio = emResult[k].volRatio;
          }
        }
        this._volRatioAt = Date.now();
      } catch (e) {
        console.error('EastMoney volRatio fetch failed', e);
      }
    }

    return merged;
  }

  // 量比刷新节流：默认 15 秒一次，且仅在交易时段请求
  _volRatioDue() {
    if (!this._volRatioAt) return true;
    if (Date.now() - this._volRatioAt < VOL_RATIO_TTL) return false;
    return isInTradingHours();
  }

  async fetchFunds(targets) {
    const results = {};
    for (const t of targets) {
      try {
        const data = await this.fund.fetch(t.code);
        if (data) {
          results[t.code] = data;
        }
      } catch (e) {}
    }
    return results;
  }

  // K线取数：东财为主、腾讯为备。
  // 任一可用即返回，避免单一数据源故障导致走势图整体空白。
  async fetchKline(code, klt = 101, lmt = 60) {
    const primary = await this.eastmoney.fetchKline(code, klt, lmt);
    if (primary && primary.length > 0) return primary;

    const fallback = await this.tencent.fetchKline(code, lmt);
    if (fallback && fallback.length > 0) return fallback;

    return [];
  }

  // 复权因子 = 后复权收盘 / 前复权收盘
  // 二者比值偏离 1 即说明区间内发生过除权除息。
  // 用于把「除权前名义价」的触发价换算到当前可比较的口径。
  async fetchAdjustFactor(code, lmt = 120) {
    const [qfq, hfq] = await Promise.all([
      this.tencent.fetchKline(code, lmt),
      this.tencent.fetchKlineHfq(code, lmt)
    ]);
    if (!qfq || qfq.length === 0 || !hfq || hfq.length === 0) return 1;

    // 按日期对齐，取同一根K线的收盘价比值
    const hfqByDate = new Map(hfq.map(k => [k.date, k.close]));
    for (const k of qfq) {
      const h = hfqByDate.get(k.date);
      if (h != null && k.close > 0 && h > 0) {
        return calcAdjustFactor(k.close, h);
      }
    }
    return 1;
  }

  async search(keyword) {
    return this.eastmoney.search(keyword);
  }
}

const quoteAggregator = new QuoteAggregator();

// ============================================================
// 5. 本地存储
// ============================================================
let _saveCounter = 0;
let _lastSaveTime = 0;
const SAVE_INTERVAL_COUNT = 5;
const SAVE_INTERVAL_TIME = 30000;

function saveState(force = false) {
  if (!force) {
    _saveCounter++;
    const now = Date.now();
    if (_saveCounter < SAVE_INTERVAL_COUNT && now - _lastSaveTime < SAVE_INTERVAL_TIME) {
      return;
    }
    _saveCounter = 0;
    _lastSaveTime = now;
  }
  
  const data = {
    targets: state.targets,
    logs: state.logs.slice(-100),
    settings: state.settings
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);

      // 结构校验：损坏或旧版本存档可能缺字段/类型不符，
      // 此处逐项归一，避免脏数据流入渲染与规则判定
      state.targets = Array.isArray(data.targets) ? data.targets : [];
      state.logs = Array.isArray(data.logs) ? data.logs : [];
      state.settings = Object.assign(state.settings,
        (data.settings && typeof data.settings === 'object') ? data.settings : {});

      state.targets.forEach(t => {
        if (!t || typeof t !== 'object') return;
        if (!t.category) t.category = detectCategory(t.code);
        // rules 缺失会让渲染层的 .filter 抛错并中断整个轮询
        if (!Array.isArray(t.rules)) t.rules = [];
        if (!t.id) t.id = 'r_' + Math.random().toString(36).slice(2, 10);
      });
      // 过滤掉非对象的脏条目，避免后续遍历崩溃
      state.targets = state.targets.filter(t => t && typeof t === 'object' && t.code);
    }
  } catch (e) {
    console.error('load state error', e);
    // 存档损坏时退回干净状态，而不是让页面带着半残数据运行
    state.targets = [];
    state.logs = [];
  }
}

// ============================================================
// 6. 智能轮询调度器
// ============================================================

// --- 数据源健康度 ---
// 起因：实测东方财富 push2his / push2delay 两个域名对本机
// socket hang up，而腾讯正常。原实现只在 console 打日志，
// 用户看到的是「走势图空白」却不知原因，缺少可观测性。
// 这里显式记录每个数据源的成败状态，并在状态栏透出。
const SOURCE_HEALTH = {
  tencent: { name: '腾讯财经', ok: 0, fail: 0, lastError: '', lastOkAt: 0 },
  eastmoney: { name: '东方财富', ok: 0, fail: 0, lastError: '', lastOkAt: 0 },
  fund: { name: '天天基金', ok: 0, fail: 0, lastError: '', lastOkAt: 0 },
  kline: { name: 'K线走势', ok: 0, fail: 0, lastError: '', lastOkAt: 0 }
};

function markSource(key, success, errMsg) {
  const h = SOURCE_HEALTH[key];
  if (!h) return;
  if (success) {
    h.ok++;
    h.lastOkAt = Date.now();
  } else {
    h.fail++;
    h.lastError = errMsg || 'unknown';
  }
}

function getSourceLabel() {
  const t = SOURCE_HEALTH.tencent;
  const e = SOURCE_HEALTH.eastmoney;

  if (t.ok > 0 && t.fail === 0) return { text: '腾讯财经', level: 'ok' };
  if (t.fail > 0 && t.ok > 0) return { text: '腾讯(不稳定)', level: 'warn' };
  if (t.fail > 0 && t.ok === 0) {
    return e.ok > 0
      ? { text: '东方财富(备用)', level: 'warn' }
      : { text: '数据源全不可用', level: 'error' };
  }
  return { text: '待连接', level: 'muted' };
}

// 交易时段判定。
//
// 交易日历来源：上证指数(sh000001)日K线 —— 有K线的日期即为交易日。
// 该口径权威且自洽，实测 2025-06~2026-10 区间可正确识别全部 25 个
// 法定休市日（国庆 7 天、春节 6 天等）。
//
// 未加载到日历时退化为「按工作日」判定并在状态栏标注，
// 避免因日历缺失而把真实交易日误判为休市。
const CALENDAR = {
  days: new Set(),      // YYYY-MM-DD 集合
  loaded: false,
  lastDate: null,       // 日历覆盖到的最后一天
  source: '未加载'
};

function fmtDateKey(date) {
  return date.getFullYear() + '-' +
         String(date.getMonth() + 1).padStart(2, '0') + '-' +
         String(date.getDate()).padStart(2, '0');
}

// 从日K线行中提取交易日。行格式为 [日期, ...]。
function ingestCalendar(klines) {
  if (!Array.isArray(klines) || klines.length === 0) return false;
  let added = 0;
  for (const k of klines) {
    const d = k && k.date;
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!CALENDAR.days.has(d)) { CALENDAR.days.add(d); added++; }
    if (!CALENDAR.lastDate || d > CALENDAR.lastDate) CALENDAR.lastDate = d;
  }
  if (CALENDAR.days.size > 0) {
    CALENDAR.loaded = true;
    CALENDAR.source = '上证指数日K线';
  }
  return added > 0;
}

// 日历加载：优先本地缓存，过期则从数据源增量拉取
const CALENDAR_CACHE_KEY = 'simple_stock_monitor_calendar';
const CALENDAR_TTL = 12 * 60 * 60 * 1000; // 12 小时

function saveCalendarCache() {
  try {
    localStorage.setItem(CALENDAR_CACHE_KEY, JSON.stringify({
      days: Array.from(CALENDAR.days),
      lastDate: CALENDAR.lastDate,
      ts: Date.now()
    }));
  } catch (e) { /* 容量超限时静默降级，不影响主功能 */ }
}

function loadCalendarCache() {
  try {
    const raw = localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.days) || data.days.length === 0) return false;
    // 超过 TTL 视为过期，仅用于「先按旧日历跑起来」，随后异步刷新
    data.days.forEach(d => CALENDAR.days.add(d));
    CALENDAR.lastDate = data.lastDate;
    CALENDAR.loaded = true;
    CALENDAR.source = '本地缓存';
    return Date.now() - (data.ts || 0) < CALENDAR_TTL;
  } catch (e) {
    return false;
  }
}

let _calendarFetching = false;
async function refreshCalendar() {
  if (_calendarFetching) return;
  _calendarFetching = true;
  try {
    // 拉约 14 个月，覆盖当前及下一年初的节假日安排
    const klines = await quoteAggregator.tencent.fetchKline('sh000001', 330);
    if (klines && klines.length > 0) {
      ingestCalendar(klines);
      saveCalendarCache();
    }
  } catch (e) {
    console.warn('交易日历加载失败，退化为按工作日判定', e);
  } finally {
    _calendarFetching = false;
  }
}

// 判断某日是否为交易日。
// 日历未覆盖到该日期时退化为「工作日即交易日」，宁可多轮询也不误停。
function isTradingDay(date) {
  if (date.getDay() === 0 || date.getDay() === 6) return false;
  if (!CALENDAR.loaded) return true;

  const key = fmtDateKey(date);
  if (CALENDAR.lastDate && key > CALENDAR.lastDate) return true; // 超出覆盖范围
  return CALENDAR.days.has(key);
}

function isHoliday(date) {
  return !isTradingDay(date);
}

function getTradingSession(now = new Date()) {
  if (!isTradingDay(now)) return 'closed';

  const time = now.getHours() * 60 + now.getMinutes();

  const auctionStart = 9 * 60 + 15;
  const auctionEnd = 9 * 60 + 25;
  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;

  if (time >= auctionStart && time <= auctionEnd) return 'auction';
  if (time > auctionEnd && time < morningStart) return 'closed';  // 9:25-9:30 空档
  if (time >= morningStart && time <= morningEnd) return 'morning';
  if (time > morningEnd && time < afternoonStart) return 'closed'; // 午休
  if (time >= afternoonStart && time <= afternoonEnd) return 'afternoon';
  return 'closed';
}

function isInTradingHours(now = new Date()) {
  const session = getTradingSession(now);
  return session === 'morning' || session === 'afternoon' || session === 'auction';
}

function getPollInterval() {
  if (state.targets.length === 0) return POLL_INTERVALS.normal;

  if (!isInTradingHours()) {
    return POLL_INTERVALS.closed;
  }

  let minDistance = Infinity;

  state.targets.forEach(t => {
    if (!t.price || !t.rules || t.rules.length === 0) return;
    t.rules.forEach(rule => {
      if (rule.type !== 'price') return;
      const dist = Math.abs(t.price - rule.value) / rule.value * 100;
      if (dist < minDistance) minDistance = dist;
    });
  });

  let base;
  if (minDistance <= THRESHOLD_VERY_CLOSE_PCT) base = POLL_INTERVALS.veryClose;
  else if (minDistance <= THRESHOLD_CLOSE_PCT) base = POLL_INTERVALS.close;
  else base = POLL_INTERVALS.normal;

  // 连续失败时指数退避，避免数据源故障期间持续高频重试
  return applyBackoff(base);
}

// --- 请求退避 ---
// 起因：数据源持续失败时，原实现仍按最短间隔 150ms 重试，
// 既无意义又会对数据源造成额外压力。此处按连续失败次数指数退避，
// 成功一次即清零。
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;

let _consecutiveFailures = 0;

function applyBackoff(baseInterval) {
  if (_consecutiveFailures <= 0) return baseInterval;
  const backoff = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, _consecutiveFailures - 1),
    BACKOFF_MAX_MS
  );
  return Math.max(baseInterval, backoff);
}

function markPollResult(success) {
  if (success) _consecutiveFailures = 0;
  else _consecutiveFailures++;
}

function scheduleNextPoll() {
  if (state._pollTimer) {
    clearTimeout(state._pollTimer);
    state._pollTimer = null;
  }

  if (state.settings.demoMode) return;

  const interval = getPollInterval();
  state._pollTimer = setTimeout(pollQuotes, interval);
}

// 把行情写入标的并触发规则判定。
// 原实现在 handleQuoteData 与 pollQuotes 中各写了一遍字段赋值，
// 两份都遗漏了 pe / volRatio / amplitude / turnoverRate，
// 导致详情弹窗中量比、振幅、市盈率恒为「--」。
function applyQuote(t, quote) {
  t._fetchState = 'ok';
  t.name = quote.name || t.name;
  t.price = quote.price;
  t.prevClose = quote.prevClose;
  t.change = quote.change;
  t.changePct = quote.changePct;
  t.open = quote.open;
  t.high = quote.high;
  t.low = quote.low;
  // volume 内部统一为「股」，amount 统一为「元」
  t.volume = quote.volume;
  t.amount = quote.amount;
  t.time = quote.time;
  t.category = quote.category || t.category;

  // 以下字段可能缺失（如东财不可用时无 volRatio），
  // 用 undefined 判断以免把已有的有效值覆盖为 0
  if (quote.pe !== undefined) t.pe = quote.pe;
  if (quote.amplitude !== undefined) t.amplitude = quote.amplitude;
  if (quote.turnoverRate !== undefined) t.turnoverRate = quote.turnoverRate;
  if (quote.limitUp !== undefined) t.limitUp = quote.limitUp;
  if (quote.limitDown !== undefined) t.limitDown = quote.limitDown;

  // 涨跌停状态：一字板时价格被封住不再变动，
  // 依赖价格穿越的提醒会永久静默失效，需单独识别并提示
  const limitState = TencentAdapter.limitState(
    t.price, quote.limitUp !== undefined ? quote.limitUp : t.limitUp,
                  quote.limitDown !== undefined ? quote.limitDown : t.limitDown
  );
  if (limitState !== 'none') t.limitState = limitState;
  else if (t.limitState) t.limitState = undefined;

  // 量比优先用数据源值；缺失时由 K 线自算，
  // 保证「成交量异动提醒」不依赖单一数据源
  if (quote.volRatio) {
    t.volRatio = quote.volRatio;
  } else {
    const klines = t._klineData || (state._sparkCache[t.code] || {}).data;
    const computed = calcVolRatio(klines, t.volume);
    if (computed > 0) t.volRatio = computed;
  }

  checkLimitAlert(t);
  checkVolumeAlert(t);
  checkPriceRules(t);
}

// 涨跌停提醒：价格到达涨跌停板时触发一次。
// 与价格穿越提醒互补——封板时价格不再变化，只有状态能反映异动。
// 同一状态持续期间只提醒一次（涨停/跌停各一次），避免反复打扰。
function checkLimitAlert(t) {
  if (!t.rules || t.rules.length === 0) return;

  // limitState 是由价格与涨跌停价推导出的派生值，不应依赖调用方预先设置。
  // 此处就地推导一次，保证任何入口调用都能正确判定封板状态。
  const state2 = t.limitState || TencentAdapter.limitState(
    t.price, t.limitUp, t.limitDown
  );
  if (!state2 || state2 === 'none') return;

  // 仅当该标的设置了价格类提醒时才提示，
  // 因为涨跌停提醒是对「价格不穿越」场景的补充
  const hasPriceRule = t.rules.some(r =>
    r.type === 'price' || r.type === 'price_range' || r.type === 'pct_change');
  if (!hasPriceRule) return;

  if (t._lastLimitAlert === state2) return;
  t._lastLimitAlert = state2;

  const label = state2 === 'limitUp' ? '封涨停板' : '封跌停板';
  const pseudoRule = { type: 'limit', value: null };

  // 涨跌停没有「穿越」语义，直接生成提醒
  const log = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    code: t.code,
    name: t.name || t.code,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    type: 'limit',
    message: `${t.name || t.code} ${label} ${formatPrice(state2 === 'limitUp' ? t.limitUp : t.limitDown)}`,
    price: t.price,
    changePct: t.changePct,
    triggerAt: Date.now(),
    triggerPrice: t.price,
    outcome: { valid: false, direction: 'unknown', pct: 0 }
  };

  state.logs.unshift(log);
  if (state.logs.length > 200) state.logs = state.logs.slice(0, 200);

  showToast(log.message, state2 === 'limitUp' ? 'warn' : 'info');
  playAlertSound();
  sendDesktopNotification(t, pseudoRule, label);
  flashCard(t.code);
  renderLogs();
  renderReviewPanel();
  saveState();
}

function handleQuoteData(quotes) {
  let hasUpdate = false;
  state.targets.forEach(t => {
    const quote = quotes[t.code] || quotes[normalizeCode(t.code)];
    if (quote) {
      hasUpdate = true;
      applyQuote(t, quote);
      if (!state._sparkCache[t.code]) loadSparkline(t);
    }
  });

  if (hasUpdate) {
    updateCardData();
    renderStatusBar();
  }
}

async function pollQuotes() {
  if (state.settings.demoMode) return;
  if (state.targets.length === 0) {
    scheduleNextPoll();
    return;
  }

  if (state._polling) return;
  state._polling = true;

  try {
    const quotes = await quoteAggregator.fetchAll(state.targets);
    let got = 0;

    state.targets.forEach(t => {
      const quote = quotes[t.code] || quotes[normalizeCode(t.code)];

      if (quote) {
        got++;
        applyQuote(t, quote);
        if (!state._sparkCache[t.code]) loadSparkline(t);
      } else if (t._fetchState !== 'ok') {
        t._fetchState = t._fetchState === 'loading' ? 'no_data' : 'loading';
      }
    });

    // 全部标的都取不到数据视为本轮失败，触发退避
    markPollResult(got > 0);

    updateReviewOutcomes();
    saveState();
    updateCardData();
    renderStatusBar();
  } catch (e) {
    markPollResult(false);
    console.error('poll error', e);
  } finally {
    state._polling = false;
    scheduleNextPoll();
  }
}

// ============================================================
// 7. 价格/成交量异动判定（边界穿越防重复）
// ============================================================
function checkPriceRules(t) {
  if (!t.rules || t.price == null) return;

  t.rules.forEach(rule => {
    if (rule.type === 'price') {
      checkSinglePriceRule(t, rule);
    } else if (rule.type === 'price_range') {
      checkRangePriceRule(t, rule);
    } else if (rule.type === 'pct_change') {
      checkPctChangeRule(t, rule);
    }
  });
}

function checkPctChangeRule(t, rule) {
  if (t.changePct == null) return;

  const threshold = rule.pctThreshold;
  const isUp = threshold > 0;
  const reached = isUp ? t.changePct >= threshold : t.changePct <= threshold;

  if (reached && !rule._lastTriggered) {
    rule._lastTriggered = true;
    const direction = isUp ? `涨幅达${threshold}%` : `跌幅达${Math.abs(threshold)}%`;
    triggerAlert(t, rule, direction, 'price');
  } else if (!reached && rule._lastTriggered) {
    rule._lastTriggered = false;
  }
}

function checkSinglePriceRule(t, rule) {
  if (rule._lastSide == null) {
    rule._lastSide = t.price >= rule.value ? 1 : -1;
    return;
  }

  const currentSide = t.price >= rule.value ? 1 : -1;
  if (currentSide !== rule._lastSide) {
    rule._lastSide = currentSide;
    const direction = currentSide === 1 ? '向上突破' : '向下跌破';
    triggerAlert(t, rule, direction, 'price');
  }
}

function checkRangePriceRule(t, rule) {
  const inRange = t.price >= rule.lower && t.price <= rule.upper;
  
  if (rule._lastInRange == null) {
    rule._lastInRange = inRange;
    return;
  }

  if (inRange !== rule._lastInRange) {
    rule._lastInRange = inRange;
    const direction = inRange ? '进入价格区间' : '离开价格区间';
    triggerAlert(t, rule, `${direction} [${formatPrice(rule.lower)}-${formatPrice(rule.upper)}]`, 'price');
  }
}

function checkVolumeAlert(t) {
  if (!t.volume || !t.rules) return;

  // 量比可能因 K 线尚未返回而缺失（loadSparkline 为异步）。
  // 此处按需补算，避免首轮行情因量比未就绪而漏判量比异动。
  let volRatio = parseFloat(t.volRatio) || 0;
  if (volRatio <= 0) {
    const klines = t._klineData || (state._sparkCache[t.code] || {}).data;
    volRatio = calcVolRatio(klines, t.volume);
    if (volRatio > 0) t.volRatio = volRatio;
  }

  t.rules.forEach(rule => {
    if (rule.type !== 'volume') return;

    if (rule.volRatioThreshold && volRatio >= rule.volRatioThreshold) {
      if (!rule._lastVolumeAlert || Date.now() - rule._lastVolumeAlert > 300000) {
        rule._lastVolumeAlert = Date.now();
        triggerAlert(t, rule, `量比达${volRatio.toFixed(1)}倍`, 'volume');
      }
    }
  });
}

// 按规则类型拼接触发描述。
// direction 已包含触发方向与关键数值，此处只补充规则设定的目标值。
function buildAlertMessage(rule, direction) {
  switch (rule.type) {
    case 'price':
      return `${direction} ${formatPrice(rule.value)}`;
    case 'price_range':
      return `${direction} [${formatPrice(rule.lower)}-${formatPrice(rule.upper)}]`;
    case 'pct_change':
      return `${direction}`;
    case 'volume':
      return `${direction}`;
    default:
      return `${direction}`;
  }
}

function triggerAlert(target, rule, direction, alertType) {
  const log = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    code: target.code,
    name: target.name || target.code,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    type: alertType,
    // 消息按规则类型生成。原实现统一拼接 rule.value，
    // 而涨跌幅规则与量比规则没有 value 字段，导致日志尾部出现空文本。
    message: `${target.name || target.code} ${buildAlertMessage(rule, direction)}`,
    price: target.price,
    changePct: target.changePct,
    // 复盘统计所需字段：触发时刻与触发价（基准）
    triggerAt: Date.now(),
    triggerPrice: target.price,
    outcome: { valid: false, direction: 'unknown', pct: 0 }
  };

  state.logs.unshift(log);
  if (state.logs.length > 200) state.logs = state.logs.slice(0, 200);

  showToast(log.message, alertType === 'price' ? 'alert' : 'info');
  playAlertSound();
  sendDesktopNotification(target, rule, direction);
  flashCard(target.code);

  renderLogs();
  renderReviewPanel();
  saveState();
}

// 复盘结果更新：每轮行情后结算观察窗口已完成的记录。
//
// 关键约束：一条记录只结算一次，结算后冻结。
// 原实现对每条已完成的记录都用「当前价格」重算，
// 导致价格变化时历史记录的结果被反复改写——
// 4 条不同结果的记录最终全部显示成同一数值，复盘统计完全失真。
function updateReviewOutcomes(now = Date.now()) {
  let changed = false;

  for (const log of state.logs) {
    if (!log || !log.triggerAt) continue;

    // 已结算的记录不再改动
    if (log.outcome && log.outcome.valid && log.outcome.settledAt) continue;

    if (!isReviewComplete(log, now)) {
      // 窗口未走完：保持「观察中」，不写入无效结果
      continue;
    }

    // 窗口已完成：取「当前价」结算一次并冻结
    const target = state.targets.find(t => t.code === log.code);
    const laterPrice = target && target.price != null ? target.price : log.price;
    const outcome = judgeOutcome(log.triggerPrice, laterPrice);
    outcome.settledAt = now;
    log.outcome = outcome;
    changed = true;
  }

  if (changed) {
    renderLogs();
    renderReviewPanel();
    saveState();
  }
}

// ============================================================
// 8. 通知系统
// ============================================================
function checkNotifPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

function requestNotifPermission() {
  if (!('Notification' in window)) return Promise.reject('unsupported');
  return Notification.requestPermission().then(perm => {
    state.notifPermission = perm;
    state.settings.notifEnabled = perm === 'granted';
    saveState();
    return perm;
  });
}

function sendDesktopNotification(target, rule, direction) {
  if (!state.settings.notifEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    const pct = target.changePct != null
      ? `${target.changePct >= 0 ? '+' : ''}${target.changePct.toFixed(2)}%`
      : '--';

    // 标题按异动类型区分，不再一律叫「价格异动」
    const kindLabel = {
      price: '价格异动',
      price_range: '价格异动',
      pct_change: '涨跌幅异动',
      volume: '成交量异动',
      limit: '涨跌停异动'
    }[rule.type] || '标的异动';

    // 原实现对所有规则都拼接 formatPrice(rule.value)，
    // 量比/涨跌幅规则无 value 字段时会显示为 NaN
    const body = `${buildAlertMessage(rule, direction)}\n` +
                 `当前价: ${formatPrice(target.price)} (${pct})`;

    const n = new Notification(`${kindLabel}: ${target.name || target.code}`, { body });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {}
}

// --- 提示音 ---
let audioCtx = null;
function playAlertSound() {
  if (!state.settings.soundEnabled) return;

  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3);

    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

// 量比计算：当日累计成交量 ÷ 过去 N 日每日平均成交量。
//
// 原实现完全依赖东方财富 f8 字段取量比，而实测该域名对本机
// socket hang up，导致「成交量异动提醒」这一功能实际从未触发过。
// 现改为本地自算，数据源只需 K 线（已有腾讯降级源）。
//
// 口径校验（2026-10-11 实测，贵州茅台）：
//   前 5 日均量 = 29864 手，当日累计 35111 手
//   自算量比 = 35111 / 29864 = 1.18
//   腾讯接口 fields[49] 同日同标的 = 1.18  → 两者完全吻合
const VOL_RATIO_DAYS = 5;

// 从 K 线数据计算量比。klines 需按日期升序，最后一行为最新。
// excludeLast=true 时剔除最后一根（用于历史均量，避免把当日算进基准）。
function calcVolRatio(klines, currentVolume, days = VOL_RATIO_DAYS) {
  if (!Array.isArray(klines) || klines.length < 2) return 0;

  const todayVol = parseFloat(currentVolume);
  if (!isFinite(todayVol) || todayVol <= 0) return 0;

  const hist = klines.slice(0, -1).slice(-days);
  if (hist.length === 0) return 0;

  let sum = 0;
  let n = 0;
  for (const k of hist) {
    const v = parseFloat(k && k.volume);
    // 停牌日成交量为 0，计入均量会拉低基准，使量比虚高
    if (isFinite(v) && v > 0) { sum += v; n++; }
  }
  if (n === 0) return 0;

  return todayVol / (sum / n);
}

// --- Toast ---
function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-show');
  });

  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- 卡片高亮闪烁 ---
function flashCard(code) {
  const card = document.querySelector(`[data-code="${code}"]`);
  if (card) {
    card.classList.add('card-flash');
    setTimeout(() => card.classList.remove('card-flash'), 2000);
  }
}

// ============================================================
// 9. 迷你走势图（Sparkline）
// ============================================================
// 复权因子：用于识别除权除息并校正触发价。
// 仅在无因子时计算一次（factor=1 视为未知），成功后写入标的。
async function ensureAdjustFactor(target) {
  if (target._adjustFactor !== undefined && target._adjustFactor > 0) return;
  if (!/^(sh|sz)\d{6}$/.test(normalizeCode(target.code))) return;

  try {
    const factor = await quoteAggregator.fetchAdjustFactor(target.code, 120);
    if (factor > 0) {
      target._adjustFactor = factor;
      target._exDividend = hasExDividend(factor);
    }
  } catch (e) { /* 拿不到因子时保持未定义，按未除权处理 */ }
}

// 把该标的下所有「名义价」类型的触发规则换算到当前复权口径。
// 区间提醒与涨跌幅不受影响（前者为相对区间，后者为百分比）。
function adjustRulesForExDividend(target) {
  const factor = target._adjustFactor;
  if (!factor || Math.abs(factor - 1) < 1e-9) return false;
  if (!target.rules || target.rules.length === 0) return false;

  let changed = false;
  for (const rule of target.rules) {
    if (rule.type === 'price' && isFinite(rule.value)) {
      // 记录原始名义价，仅换算一次，避免重复应用因子
      if (rule._nominalValue === undefined) rule._nominalValue = rule.value;
      const adjusted = adjustPriceForExDividend(rule._nominalValue, factor);
      if (Math.abs(adjusted - rule.value) > 1e-6) {
        rule.value = adjusted;
        changed = true;
      }
    } else if (rule.type === 'price_range' && isFinite(rule.lower) && isFinite(rule.upper)) {
      if (rule._nominalLower === undefined) {
        rule._nominalLower = rule.lower;
        rule._nominalUpper = rule.upper;
      }
      const nl = adjustPriceForExDividend(rule._nominalLower, factor);
      const nu = adjustPriceForExDividend(rule._nominalUpper, factor);
      if (Math.abs(nl - rule.lower) > 1e-6 || Math.abs(nu - rule.upper) > 1e-6) {
        rule.lower = nl;
        rule.upper = nu;
        changed = true;
      }
    }
  }
  return changed;
}

async function loadSparkline(target) {
  const cat = target.category || detectCategory(target.code);
  if (cat === CATEGORY.FUND) return;

  const cacheKey = target.code;
  if (state._sparkCache[cacheKey] && Date.now() - state._sparkCache[cacheKey].time < 300000) {
    return state._sparkCache[cacheKey].data;
  }

  // 记录「已尝试取 K线」，用于区分「加载中」与「确实取不到」
  target._klineTriedAt = target._klineTriedAt || Date.now();

  try {
    const data = await quoteAggregator.fetchKline(target.code, 101, 60);
    if (data && data.length > 0) {
      state._sparkCache[cacheKey] = { data, time: Date.now() };
      target._klineData = data;

      // K 线是量比自算的基准，此处数据到齐后补算一次量比，
      // 否则首轮行情到达时因缺 K 线而无法给出量比
      const vr = calcVolRatio(data, target.volume);
      if (vr > 0) target.volRatio = vr;

      // 复权因子与走势图数据同源，一并获取；
      // 若发生除权除息，按新口径重置规则的穿越基准位置
      await ensureAdjustFactor(target);
      if (adjustRulesForExDividend(target)) {
        // 换算后必须重置穿越基准，否则会把「口径变化」误判为「价格穿越」
        resetRuleBaselines(target);
        target._rulesAdjustedAt = Date.now();
      }

      // 卡片可能已在增量渲染分支中更新过（该分支不重绘 canvas），
      // 此处显式重绘以确保走势图可见。
      redrawSparklines();
    } else {
      // 取不到数据时立即更新占位提示，无需等下一轮轮询
      updateCardSparkline(target);
    }
    return data;
  } catch (e) {
    updateCardSparkline(target);
    return [];
  }
}

// 规则穿越基准重置：只记录当前位置，不触发提醒。
// 用于口径变化（如除权）或规则新增后避免误触发。
function resetRuleBaselines(target) {
  if (!target.rules) return;
  for (const rule of target.rules) {
    if (rule.type === 'price') {
      rule._lastSide = target.price >= rule.value ? 1 : -1;
    } else if (rule.type === 'price_range') {
      rule._lastInRange = target.price >= rule.lower && target.price <= rule.upper;
    } else if (rule.type === 'pct_change') {
      // 涨跌幅按昨收计算，除权不影响其相对基准
      const threshold = rule.pctThreshold;
      rule._lastTriggered = (threshold > 0)
        ? target.changePct >= threshold
        : target.changePct <= threshold;
    }
  }
}

function getColorValue(cssVar) {
  const style = getComputedStyle(document.documentElement);
  return style.getPropertyValue(cssVar).trim();
}

function drawSparkline(canvas, data, color) {
  if (!canvas || !data || data.length < 2) return;
  if (typeof canvas === 'string') {
    canvas = document.getElementById(canvas);
    if (!canvas) return;
  }

  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const prices = data.map(d => d.close || d.price || 0);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const stepX = w / (prices.length - 1);

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';

  prices.forEach((p, i) => {
    const x = i * stepX;
    const y = h - ((p - min) / range) * (h - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.stroke();

  const rgbaColor = hexToRgba(color, 0.2);
  const rgbaColorTransparent = hexToRgba(color, 0);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, rgbaColor);
  grad.addColorStop(1, rgbaColorTransparent);

  // 填充区域必须重新描一遍折线再闭合到基线。
  // 原实现 beginPath() 后直接 lineTo(w,h) → lineTo(0,h)，
  // 起点被重置到曲线首点之外，实际填的是一个三角形，曲线下方并未填充。
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = i * stepX;
    const y = h - ((p - min) / range) * (h - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function hexToRgba(hex, alpha) {
  if (hex.startsWith('rgb')) return hex;
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function updateCardSparkline(target) {
  const card = document.querySelector(`[data-code="${target.code}"]`);
  if (!card) return;

  const canvas = card.querySelector('.sparkline-canvas');
  if (!canvas) return;

  // 占位提示与绘制互斥：取不到数据时也要刷新提示
  const hint = card.querySelector('.spark-placeholder');

  const data = target._klineData || state._sparkCache[target.code]?.data;
  if (!data || data.length < 2) {
    if (hint) hint.innerHTML = klineUnavailableHint(target);
    return;
  }

  const isUp = target.changePct >= 0;
  const color = isUp ? getColorValue('--up') : getColorValue('--down');
  drawSparkline(canvas, data, color);

  // 画出来了就移除占位提示
  if (hint) hint.innerHTML = '';
}

// ============================================================
// 10. 搜索联想
// ============================================================
let searchTimer = null;
let lastSearchKeyword = '';

function onSearchInput(e) {
  const keyword = e.target.value.trim();

  if (searchTimer) clearTimeout(searchTimer);

  if (keyword.length === 0) {
    hideSearchDropdown();
    return;
  }

  if (keyword.length < 2) return;

  searchTimer = setTimeout(() => doSearch(keyword), 300);
}

async function doSearch(keyword) {
  lastSearchKeyword = keyword;
  try {
    const results = await quoteAggregator.search(keyword);
    if (keyword !== lastSearchKeyword) return;
    showSearchDropdown(results);
  } catch (e) {
    console.error('search error', e);
  }
}

function showSearchDropdown(results) {
  let dropdown = document.getElementById('searchDropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'searchDropdown';
    dropdown.className = 'search-dropdown';
    document.querySelector('.search-box').appendChild(dropdown);
  }

  if (!results || results.length === 0) {
    dropdown.innerHTML = '<div class="search-item search-empty">未找到匹配结果</div>';
    dropdown.style.display = 'block';
    return;
  }

  // 用 QuoteID 解析出规范代码与品类，展示规范代码而非裸数字，
  // 让用户能明确区分 000001 是平安银行还是上证指数。
  const parsed = results.map(item => ({ item, resolved: resolveByQuoteId(item) }))
                        .filter(x => x.resolved);

  if (parsed.length === 0) {
    dropdown.innerHTML = '<div class="search-item search-empty">未找到匹配结果</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = parsed.map(({ item, resolved }) => `
      <div class="search-item" data-code="${resolved.code}" data-name="${escapeHtml(resolved.name)}" data-category="${resolved.category}">
        <span class="search-code">${resolved.code}</span>
        <span class="search-name">${escapeHtml(resolved.name)}</span>
        <span class="search-cat">${CATEGORY_NAME[resolved.category] || ''}</span>
      </div>
    `).join('');

  dropdown.querySelectorAll('.search-item').forEach(el => {
    el.addEventListener('click', () => {
      addTarget(el.dataset.code, el.dataset.name, el.dataset.category);
      hideSearchDropdown();
      document.getElementById('searchInput').value = '';
    });
  });

  dropdown.style.display = 'block';
}

// 所有插入 innerHTML 的外部文本（标的名称来自数据源）必须转义，
// 否则数据源返回含尖括号的内容会破坏 DOM 结构。
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hideSearchDropdown() {
  const dropdown = document.getElementById('searchDropdown');
  if (dropdown) dropdown.style.display = 'none';
}

// 搜索结果的品类一律以 QuoteID 为准，不再用 SecurityType 猜。
// 实测 SecurityType 的取值并不稳定（同一 ETF 在不同接口版本下
// 返回 3 或 8），而 QuoteID 的市场号段是确定的。
function getSearchItemCategory(item) {
  const resolved = resolveByQuoteId(item);
  return resolved ? resolved.category : CATEGORY.UNKNOWN;
}

// ============================================================
// 11. 目标管理
// ============================================================

// 添加标的。
// 带市场前缀 → 本地号段规则即可定品类，直接入列（快路径，无网络往返）。
// 无前缀纯数字 → 号段存在场内外重叠，必须先向数据源问明归属再入列，
//                  否则会把场外基金错当 ETF、把上证指数错当平安银行。
async function addTarget(code, name = '', category = null) {
  const raw = String(code || '').trim();
  if (!raw) return;

  let finalCode = normalizeCode(raw);
  let finalName = name;
  let finalCat = category;

  if (!isExplicitCode(raw)) {
    const resolved = await resolveByRemote(raw);
    if (!resolved) {
      showToast(`未找到代码 ${raw} 对应的标的`, 'warn');
      return;
    }
    finalCode = resolved.code;
    finalName = name || resolved.name;
    finalCat = resolved.category;

    // 数据源可能返回多个同名候选（如 000001 = 平安银行 / 上证指数 / 华夏成长）。
    // 纯数字输入无法由用户区分，此处按「场内优先」取首个候选并提示歧义。
    if (resolved.ambiguous) {
      showToast(`${raw} 匹配到 ${resolved.name}，如需其他同名标的请搜索名称`, 'info');
    }
  }

  if (!finalCat || finalCat === CATEGORY.UNKNOWN) {
    showToast(`无法识别 ${raw} 的品类，请检查代码是否正确`, 'warn');
    return;
  }

  if (state.targets.find(t => t.code === finalCode)) {
    showToast('该标的已在列表中', 'warn');
    return;
  }

  const target = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    code: finalCode,
    name: finalName || finalCode,
    category: finalCat,
    price: null,
    changePct: 0,
    rules: [],
    _fetchState: 'loading'
  };

  state.targets.push(target);
  saveState();
  renderCategoryTabs();
  renderTargets();
  pollQuotes();
}

// 向数据源问明无前缀代码的归属。返回规范代码 + 名称 + 品类。
// 同一代码若对应多个候选，标记 ambiguous，由调用方提示用户。
async function resolveByRemote(rawNum) {
  let results = [];
  try {
    results = await quoteAggregator.search(rawNum, 10);
  } catch (e) {
    results = [];
  }

  const candidates = results
    .map(resolveByQuoteId)
    .filter(Boolean);

  if (candidates.length === 0) return null;

  // 同一代码的多个候选，取第一个（接口已按相关度排序）
  const picked = candidates[0];
  return {
    ...picked,
    ambiguous: candidates.length > 1
  };
}

function removeTarget(id) {
  state.targets = state.targets.filter(t => t.id !== id);
  saveState();
  renderTargets();
}

function addPriceRule(targetId, value) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;

  t.rules.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: 'price',
    value: parseFloat(value),
    _lastSide: null
  });

  saveState();
  renderTargets();
}

function addVolumeRule(targetId, volRatio) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;

  t.rules.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: 'volume',
    volRatioThreshold: parseFloat(volRatio) || 2,
    avgVolume: 0,
    _lastVolumeAlert: 0
  });

  saveState();
  renderTargets();
}

function addRangeRule(targetId, lower, upper) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;

  t.rules.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: 'price_range',
    lower: parseFloat(lower),
    upper: parseFloat(upper),
    _lastInRange: null
  });

  saveState();
  renderTargets();
}

function addPctChangeRule(targetId, pctThreshold) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;

  t.rules.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: 'pct_change',
    pctThreshold: parseFloat(pctThreshold),
    _lastTriggered: false
  });

  saveState();
  renderTargets();
}

function removeRule(targetId, ruleId) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;
  if (!Array.isArray(t.rules)) t.rules = [];
  t.rules = t.rules.filter(r => r.id !== ruleId);
  saveState();
  renderTargets();
}

// ============================================================
// 12. 渲染层
// ============================================================
function renderAll() {
  renderMarketBar();
  renderCategoryTabs();
  updateCardData();
  renderLogs();
  renderStatusBar();
}

let _lastRenderTime = 0;
const RENDER_THROTTLE_MS = 500;

// K线数据就绪时需要立即重绘走势图。
// 增量渲染分支只更新文字字段，不会重绘 canvas，
// 而 updateCardData 有 500ms 节流，导致 K线晚于首次渲染返回时
// 走势图始终空白。此函数独立于节流，直接重绘。
function redrawSparklines() {
  state.targets.forEach(t => {
    if (t._klineData || state._sparkCache[t.code]) {
      updateCardSparkline(t);
    }
  });
}

function updateCardData(force = false) {
  const now = Date.now();
  if (!force && now - _lastRenderTime < RENDER_THROTTLE_MS) return;
  _lastRenderTime = now;

  const grid = document.getElementById('cardGrid');
  if (!grid) return;

  const targets = getSortedTargets(getFilteredTargets());

  if (targets.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <p>${state.targets.length === 0 ? '暂无自选标的' : '该分类暂无标的'}</p>
        <p class="empty-hint">在上方搜索框输入代码或名称添加</p>
      </div>
    `;
    return;
  }

  const existingIds = new Set();
  grid.querySelectorAll('.card').forEach(c => existingIds.add(c.dataset.id));

  const targetIds = new Set(targets.map(t => t.id));
  const needsRebuild = [...targetIds].some(id => !existingIds.has(id)) ||
                       [...existingIds].some(id => !targetIds.has(id));

  if (needsRebuild) {
    grid.innerHTML = targets.map(t => renderCard(t)).join('');
    targets.forEach(t => {
      if (t._klineData || state._sparkCache[t.code]) {
        updateCardSparkline(t);
      }
    });
    bindCardEvents();
  } else {
    targets.forEach(t => {
      const card = grid.querySelector(`.card[data-id="${t.id}"]`);
      if (!card) return;

      const fetchState = t._fetchState || 'loading';
      const isUp = t.changePct >= 0;
      const colorClass = isUp ? 'up' : 'down';
      const priceText = t.price ? formatPrice(t.price) : '--';
      const pctNum = Number(t.changePct);
      const pctText = Number.isFinite(pctNum) ? `${isUp ? '+' : ''}${pctNum.toFixed(2)}%` : '--';

      card.className = `card ${colorClass}`;

      const priceEl = card.querySelector('.card-price');
      const pctEl = card.querySelector('.card-pct');
      if (priceEl) {
        priceEl.textContent = priceText;
        priceEl.className = `card-price ${colorClass}`;
      }
      if (pctEl) {
        pctEl.textContent = pctText;
        pctEl.className = `card-pct ${colorClass}`;
      }

      const volSpan = card.querySelector('.card-meta span:nth-child(1)');
      const amtSpan = card.querySelector('.card-meta span:nth-child(2)');
      if (volSpan) volSpan.textContent = `量: ${formatVolume(t.volume)}`;
      if (amtSpan) amtSpan.textContent = `额: ${formatAmount(t.amount)}`;

      const nameEl = card.querySelector('.card-name');
      if (nameEl) {
        if (fetchState === 'no_data') nameEl.textContent = '暂无行情数据';
        else if (fetchState === 'error') nameEl.textContent = '行情请求失败';
        else if (t.name) nameEl.textContent = t.name;
      }

      const timeEl = card.querySelector('.card-time');
      if (timeEl) {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        timeEl.textContent = `${h}:${m}:${s}`;
      }

      // 增量分支不重绘 canvas，需同步走势图占位提示，
      // 否则 K线取不到时用户看到的是一片空白而无任何说明
      const hintBox = card.querySelector('.spark-placeholder');
      if (hintBox) hintBox.innerHTML = klineUnavailableHint(t);
    });
  }
}

function getFilteredTargets() {
  if (state.activeCategory === 'all') return state.targets;
  return state.targets.filter(t => t.category === state.activeCategory);
}

function getSortedTargets(targets) {
  if (!state.sortByChange) return targets;
  return [...targets].sort((a, b) => {
    const aPct = a.changePct || 0;
    const bPct = b.changePct || 0;
    return bPct - aPct;
  });
}

function renderTargets() {
  const grid = document.getElementById('cardGrid');
  if (!grid) return;

  const targets = getSortedTargets(getFilteredTargets());

  if (targets.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <p>${state.targets.length === 0 ? '暂无自选标的' : '该分类暂无标的'}</p>
        <p class="empty-hint">在上方搜索框输入代码或名称添加</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = targets.map(t => renderCard(t)).join('');

  targets.forEach(t => {
    if (t._klineData || state._sparkCache[t.code]) {
      updateCardSparkline(t);
    }
  });

  bindCardEvents();
}

// 走势图缺失时的占位提示。
// K线源被腾讯 WAF 风控时会取不到数据，若不给提示，
// 用户会以为图表渲染坏了，实际只是数据源受限。
function klineUnavailableHint(t) {
  if (t._klineData || state._sparkCache[t.code]) return '';
  if (t.category === CATEGORY.FUND) return '';
  // 走势数据与行情数据是两回事：行情正常但 K线被风控时同样需要提示，
  // 故此处不以 _fetchState（行情加载状态）作为判断依据
  if (!t._klineTriedAt) return '';   // 尚未尝试过，不提示
  return '<span class="spark-hint">走势数据暂不可用</span>';
}

function renderCard(t) {
  const fetchState = t._fetchState || 'loading';
  const isUp = Number(t.changePct) >= 0;
  const colorClass = isUp ? 'up' : 'down';
  const priceText = t.price ? formatPrice(t.price) : '--';
  // changePct 可能为 null/字符串/NaN，!= null 只挡 null|undefined，
  // 对非数值仍会抛「toFixed is not a function」，故必须用 isFinite 判定
  const pctNum = Number(t.changePct);
  const pctText = Number.isFinite(pctNum) ? `${isUp ? '+' : ''}${pctNum.toFixed(2)}%` : '--';
  const volText = formatVolume(t.volume);
  const catLabel = CATEGORY_NAME[t.category] || '';

  let nameText = t.name || '加载中…';
  if (fetchState === 'no_data') nameText = '暂无行情数据';
  if (fetchState === 'error') nameText = '行情请求失败';

  // rules 可能缺失或含 null 元素（老版本存档、损坏数据、并发写入的中间态）。
  // 既要防「不是数组」，也要防「数组里有 null」——后者会在读 .type 时抛错
  // 并中断整个轮询，故此处同时做类型过滤。
  const rules = (Array.isArray(t.rules) ? t.rules : [])
    .filter(r => r && typeof r === 'object');
  const priceRules = rules.filter(r => r.type === 'price');
  const pctRules = rules.filter(r => r.type === 'pct_change');
  const rangeRules = rules.filter(r => r.type === 'price_range');
  const volRules = rules.filter(r => r.type === 'volume');

  return `
    <div class="card ${colorClass} ${t.limitState ? 'card-limit' : ''}" data-code="${t.code}" data-id="${t.id}">
      <div class="card-header">
        <div class="card-title">
          <span class="card-name">${escapeHtml(nameText)}</span>
          <span class="card-cat-tag">${escapeHtml(catLabel)}</span>
          ${t.limitState ? `<span class="card-limit-tag">${t.limitState === 'limitUp' ? '涨停' : '跌停'}</span>` : ''}
          ${t._exDividend ? '<span class="card-ex-tag" title="区间内发生过除权除息，触发价已按当前口径换算">含权</span>' : ''}
        </div>
        <button class="card-detail" data-id="${t.id}" title="详情">ⓘ</button>
        <button class="card-delete" data-id="${t.id}" title="删除">×</button>
      </div>
      <div class="card-body">
        <div class="card-price ${colorClass}">${priceText}</div>
        <div class="card-pct ${colorClass}">${pctText}</div>
      </div>
      <div class="card-spark">
        <canvas class="sparkline-canvas" width="200" height="40"></canvas>
        <div class="spark-placeholder">${klineUnavailableHint(t)}</div>
      </div>
      <div class="card-meta">
        <span>量: ${volText}</span>
        <span>额: ${formatAmount(t.amount)}</span>
        <span class="card-time">--:--:--</span>
      </div>
      <div class="card-rules">
        ${priceRules.map(r => `
          <span class="rule-tag rule-price">
            价格 ${formatPrice(r.value)}
            <button class="rule-del" data-tid="${t.id}" data-rid="${r.id}">×</button>
          </span>
        `).join('')}
        ${pctRules.map(r => `
          <span class="rule-tag rule-pct">
            ${r.pctThreshold > 0 ? '涨' : '跌'}${Math.abs(r.pctThreshold)}%
            <button class="rule-del" data-tid="${t.id}" data-rid="${r.id}">×</button>
          </span>
        `).join('')}
        ${rangeRules.map(r => `
          <span class="rule-tag rule-range">
            区间 ${formatPrice(r.lower)}-${formatPrice(r.upper)}
            <button class="rule-del" data-tid="${t.id}" data-rid="${r.id}">×</button>
          </span>
        `).join('')}
        ${volRules.map(r => `
          <span class="rule-tag rule-volume">
            量比≥${r.volRatioThreshold}
            <button class="rule-del" data-tid="${t.id}" data-rid="${r.id}">×</button>
          </span>
        `).join('')}
        <button class="rule-add" data-id="${t.id}">+ 添加提醒</button>
      </div>
    </div>
  `;
}

function bindCardEvents() {
  document.querySelectorAll('.card-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTarget(btn.dataset.id);
    });
  });

  document.querySelectorAll('.rule-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showRuleModal(btn.dataset.id);
    });
  });

  document.querySelectorAll('.rule-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRule(btn.dataset.tid, btn.dataset.rid);
    });
  });

  document.querySelectorAll('.card-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDetailModal(btn.dataset.id);
    });
  });
}

function renderLogs() {
  const panel = document.getElementById('logPanel');
  if (!panel) return;

  if (state.logs.length === 0) {
    panel.innerHTML = '<div class="log-empty">暂无异动记录</div>';
    return;
  }

  panel.innerHTML = state.logs.slice(0, 50).map(log => {
    const isUp = log.changePct >= 0;
    const colorClass = isUp ? 'up' : 'down';
    const typeIcon = { volume: '📊', limit: '🚦' }[log.type] || '🔔';

    // 复盘结果：显示触发后的实际走向与幅度
    let reviewHtml = '<span class="log-review pending">观察中</span>';
    if (log.outcome && log.outcome.valid) {
      const pct = log.outcome.pct;
      const cls = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
      const arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '—');
      reviewHtml = `<span class="log-review ${cls}" title="触发后 ${REVIEW_WINDOW_MIN} 分钟涨跌幅">${arrow} ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
    }

    return `
      <div class="log-item">
        <span class="log-time">${log.time}</span>
        <span class="log-icon">${typeIcon}</span>
        <span class="log-name">${escapeHtml(log.name)}</span>
        <span class="log-msg">${escapeHtml(log.message)}</span>
        <span class="log-price ${colorClass}">${formatPrice(log.price)}</span>
        ${reviewHtml}
      </div>
    `;
  }).join('');
}

// 复盘面板：整体胜率与分组统计
function renderReviewPanel() {
  const panel = document.getElementById('reviewPanel');
  if (!panel) return;

  const s = summarizeLogs(state.logs);

  if (s.total === 0) {
    panel.innerHTML = '<div class="review-empty">暂无复盘数据</div>';
    return;
  }

  const winRateText = s.winRate === null
    ? '<span class="review-na">暂无可判定记录</span>'
    : `<span class="review-winrate ${s.winRate >= 50 ? 'good' : 'bad'}">${s.winRate.toFixed(1)}%</span>`;

  const typeNames = { price: '价格提醒', price_range: '区间提醒', pct_change: '涨跌幅提醒', volume: '量比异动', limit: '涨跌停' };

  const typeRows = Object.keys(s.byType).map(k => {
    const b = s.byType[k];
    const decided = b.win + b.loss;
    const rate = decided > 0 ? (b.win / decided * 100).toFixed(0) + '%' : '—';
    return `<tr>
      <td>${typeNames[k] || k}</td>
      <td>${b.count}</td>
      <td class="${b.win > 0 ? 'up' : ''}">${b.win}</td>
      <td class="${b.loss > 0 ? 'down' : ''}">${b.loss}</td>
      <td>${rate}</td>
      <td class="${b.avgPct >= 0 ? 'up' : 'down'}">${b.avgPct >= 0 ? '+' : ''}${b.avgPct.toFixed(2)}%</td>
    </tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="review-summary">
      <div class="review-metric">
        <span class="review-label">触发总数</span>
        <span class="review-value">${s.total}</span>
      </div>
      <div class="review-metric">
        <span class="review-label">方向胜率</span>
        <span class="review-value">${winRateText}</span>
      </div>
      <div class="review-metric">
        <span class="review-label">平均涨跌</span>
        <span class="review-value ${s.avgPct >= 0 ? 'up' : 'down'}">${s.avgPct >= 0 ? '+' : ''}${s.avgPct.toFixed(2)}%</span>
      </div>
      <div class="review-metric">
        <span class="review-label">最佳 / 最差</span>
        <span class="review-value">
          <span class="up">${s.bestPct === null ? '--' : '+' + s.bestPct.toFixed(1) + '%'}</span>
          /
          <span class="down">${s.worstPct === null ? '--' : s.worstPct.toFixed(1) + '%'}</span>
        </span>
      </div>
      <div class="review-metric">
        <span class="review-label">观察中</span>
        <span class="review-value">${s.pending}</span>
      </div>
    </div>
    <div class="review-note">
      口径：基准价为触发瞬间价格，观察窗口 ${REVIEW_WINDOW_MIN} 分钟；量比与涨跌停无方向性，不计入胜率。
    </div>
    <table class="review-table">
      <thead>
        <tr><th>类型</th><th>次数</th><th>准</th><th>误</th><th>胜率</th><th>均涨跌</th></tr>
      </thead>
      <tbody>${typeRows}</tbody>
    </table>
  `;
}

function renderStatusBar() {
  const status = document.getElementById('statusBar');
  if (!status) return;

  const count = state.targets.length;

  // 原实现用 (毫秒/1000).toFixed(0) 显示，300ms → "0s"，
  // 亚秒级轮询间隔全部显示为 0，状态栏失去参考价值。
  const intervalMs = getPollInterval();
  const intervalText = intervalMs < 1000
    ? intervalMs + 'ms'
    : (intervalMs / 1000).toFixed(1) + 's';

  const session = getTradingSession();
  const sessionText = {
    auction: '📈 集合竞价',
    morning: '📈 早盘',
    afternoon: '📈 午盘',
    closed: '⏰ 休市'
  }[session] || '⏰ 休市';

  const dateStr = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

  const src = getSourceLabel();

  // 退避中：明确告知用户已降频，避免误以为程序卡死
  const backoffText = _consecutiveFailures > 0
    ? `<span class="src-warn" title="连续 ${_consecutiveFailures} 次获取失败，已自动降低刷新频率">降频中 ×${_consecutiveFailures}</span>`
    : '';

  // 日历状态：休市判定是否可信，取决于真实交易日历是否已加载
  const calText = CALENDAR.loaded
    ? `<span title="交易日历来源：${escapeHtml(CALENDAR.source)}，已收录 ${CALENDAR.days.size} 个交易日">日历 ✓</span>`
    : '<span class="src-muted" title="交易日历未加载，休市判定暂按工作日估算">日历加载中</span>';

  // 走势数据受限提示：腾讯 WAF 按频率封禁，需让用户知道
  //「走势图空白」是数据源受限而非渲染故障
  const kl = SOURCE_HEALTH.kline;
  const klineText = (kl.fail > 0 && kl.ok === 0)
    ? '<span class="src-warn" title="腾讯 K线接口触发风控限流，走势图暂不可用；已启用缓存与退避，恢复后自动继续">走势受限</span>'
    : '';

  status.innerHTML = `
    <span>自选: ${count}只</span>
    <span class="src-${src.level}" title="${
      src.level === 'error'
        ? '所有行情数据源均不可用，功能将无法更新'
        : src.level === 'warn'
          ? '主数据源异常，已切换或尝试切换备用源'
          : '主数据源工作正常'
    }">数据源: ${src.text}</span>
    <span>刷新: ${intervalText}</span>
    ${backoffText}
    <span>${sessionText}</span>
    ${calText}
    ${klineText}
    <span>${dateStr}</span>
    <span>${state.settings.demoMode ? '🎮 演示模式' : '实时模式'}</span>
  `;

  notifySourceOutage();
}

// 数据源不可用属于用户可感知的关键故障，需主动告知而非仅写控制台。
let _sourceAlertShown = false;
function notifySourceOutage() {
  const src = getSourceLabel();
  if (src.level === 'error' && !_sourceAlertShown) {
    _sourceAlertShown = true;
    showToast('所有行情数据源均不可用，请检查网络连接', 'warn');
  } else if (src.level !== 'error' && _sourceAlertShown) {
    _sourceAlertShown = false;
  }
}

function renderMarketBar() {
  const bar = document.getElementById('marketBar');
  if (!bar) return;

  if (state.marketIndices.length === 0) {
    bar.innerHTML = '<div class="market-bar-empty">大盘数据加载中…</div>';
    return;
  }

  bar.innerHTML = state.marketIndices.map(idx => {
    const isUp = idx.changePct >= 0;
    const colorClass = isUp ? 'up' : 'down';
    const pctNum = Number(idx.changePct);
    const pctText = Number.isFinite(pctNum) ? `${isUp ? '+' : ''}${pctNum.toFixed(2)}%` : '--';
    return `
      <div class="market-item ${colorClass}">
        <span class="market-item-name">${idx.name}</span>
        <span class="market-item-price">${formatPrice(idx.price)}</span>
        <span class="market-item-pct">${pctText}</span>
      </div>
    `;
  }).join('');
}

async function pollMarketIndices() {
  if (state.settings.demoMode) return;

  try {
    const codes = MARKET_INDICES.map(m => m.code);
    const results = await quoteAggregator.tencent.fetch(codes);

    state.marketIndices = MARKET_INDICES.map(m => {
      const data = results[m.code];
      if (data) {
        return {
          name: m.name,
          price: data.price,
          changePct: data.changePct,
        };
      }
      return null;
    }).filter(Boolean);

    renderMarketBar();
  } catch (e) {
    console.error('market indices poll error', e);
  }
}

function scheduleMarketPoll() {
  if (state._marketTimer) {
    clearTimeout(state._marketTimer);
  }
  if (state.settings.demoMode) return;

  const interval = isInTradingHours() ? 3000 : 300000;
  state._marketTimer = setTimeout(async () => {
    await pollMarketIndices();
    scheduleMarketPoll();
  }, interval);
}

function renderCategoryTabs() {
  const tabs = document.getElementById('categoryTabs');
  if (!tabs) return;

  const categories = [
    { key: 'all', label: '全部', count: state.targets.length },
    { key: CATEGORY.STOCK_A, label: '股票', count: state.targets.filter(t => t.category === CATEGORY.STOCK_A).length },
    { key: CATEGORY.INDEX, label: '指数', count: state.targets.filter(t => t.category === CATEGORY.INDEX).length },
    { key: CATEGORY.ETF, label: 'ETF', count: state.targets.filter(t => t.category === CATEGORY.ETF).length },
    { key: CATEGORY.CONVERTIBLE, label: '转债', count: state.targets.filter(t => t.category === CATEGORY.CONVERTIBLE).length },
    { key: CATEGORY.FUND, label: '基金', count: state.targets.filter(t => t.category === CATEGORY.FUND).length },
  ];

  tabs.innerHTML = categories.map(cat => `
    <button class="cat-tab ${state.activeCategory === cat.key ? 'active' : ''}" data-cat="${cat.key}">
      ${cat.label}
      <span class="cat-count">${cat.count}</span>
    </button>
  `).join('') + `
    <button class="cat-tab sort-tab ${state.sortByChange ? 'active' : ''}" id="sortToggle" title="按涨跌幅排序">
      ${state.sortByChange ? '↓ 涨跌排序' : '↕ 排序'}
    </button>
  `;

  tabs.querySelectorAll('.cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.id === 'sortToggle') {
        state.sortByChange = !state.sortByChange;
        renderCategoryTabs();
        renderTargets();
        showToast(state.sortByChange ? '已按涨跌幅排序' : '已取消排序', 'info');
        return;
      }
      state.activeCategory = tab.dataset.cat;
      renderCategoryTabs();
      renderTargets();
    });
  });
}

// ============================================================
// 13. 提醒规则弹窗
// ============================================================
function showRuleModal(targetId) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;

  let modal = document.getElementById('ruleModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ruleModal';
    modal.className = 'modal-mask';
    modal.innerHTML = `
      <div class="modal">
        <h3 class="modal-title">添加提醒规则</h3>
        <div class="modal-desc" id="ruleModalName"></div>
        <div class="rule-tabs">
          <button class="rule-tab active" data-type="price">价格提醒</button>
          <button class="rule-tab" data-type="pct_change">涨跌幅提醒</button>
          <button class="rule-tab" data-type="price_range">区间提醒</button>
          <button class="rule-tab" data-type="volume">成交量异动</button>
        </div>
        <div class="rule-form" id="priceRuleForm">
          <label>目标价格</label>
          <input type="number" step="0.01" id="priceRuleValue" placeholder="输入目标价格">
          <div class="rule-hint">当价格穿越此价位时触发提醒</div>
          <div class="quick-alert-row" id="quickPriceAlerts"></div>
        </div>
        <div class="rule-form" id="pctChangeRuleForm" style="display:none">
          <label>涨跌幅阈值</label>
          <div class="quick-alert-row">
            <button class="quick-alert-btn up" data-pct="3">涨3%</button>
            <button class="quick-alert-btn up" data-pct="5">涨5%</button>
            <button class="quick-alert-btn up" data-pct="7">涨7%</button>
            <button class="quick-alert-btn up" data-pct="10">涨10%</button>
          </div>
          <div class="quick-alert-row">
            <button class="quick-alert-btn down" data-pct="-3">跌3%</button>
            <button class="quick-alert-btn down" data-pct="-5">跌5%</button>
            <button class="quick-alert-btn down" data-pct="-7">跌7%</button>
            <button class="quick-alert-btn down" data-pct="-10">跌10%</button>
          </div>
          <input type="number" step="0.1" id="pctChangeValue" placeholder="或自定义涨跌幅（如 5 或 -3）">
          <div class="rule-hint">当日内涨跌幅达到指定值时触发提醒</div>
        </div>
        <div class="rule-form" id="priceRangeRuleForm" style="display:none">
          <label>价格下限</label>
          <input type="number" step="0.01" id="rangeLower" placeholder="输入价格下限">
          <label>价格上限</label>
          <input type="number" step="0.01" id="rangeUpper" placeholder="输入价格上限">
          <div class="rule-hint">当价格进入或离开该区间时触发提醒</div>
        </div>
        <div class="rule-form" id="volumeRuleForm" style="display:none">
          <label>量比阈值</label>
          <input type="number" step="0.1" id="volRuleValue" value="2" placeholder="量比倍数">
          <div class="rule-hint">当成交量达到均量的指定倍数时触发（默认2倍）</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="ruleCancel">取消</button>
          <button class="btn btn-primary" id="ruleConfirm">添加</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  document.getElementById('ruleModalName').textContent = `${t.name} (${t.code})`;

  // 填充价格快捷提醒按钮
  const quickPriceAlerts = document.getElementById('quickPriceAlerts');
  if (quickPriceAlerts && t.price) {
    quickPriceAlerts.innerHTML = `
      <button class="quick-alert-btn" data-pct="1">+1%</button>
      <button class="quick-alert-btn" data-pct="3">+3%</button>
      <button class="quick-alert-btn" data-pct="5">+5%</button>
      <button class="quick-alert-btn" data-pct="-1">-1%</button>
      <button class="quick-alert-btn" data-pct="-3">-3%</button>
      <button class="quick-alert-btn" data-pct="-5">-5%</button>
    `;
    quickPriceAlerts.querySelectorAll('.quick-alert-btn').forEach(btn => {
      btn.onclick = () => {
        const pct = parseFloat(btn.dataset.pct);
        const targetPrice = t.price * (1 + pct / 100);
        document.getElementById('priceRuleValue').value = targetPrice.toFixed(2);
      };
    });
  } else if (quickPriceAlerts) {
    quickPriceAlerts.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">当前无价格数据，请等待行情加载</span>';
  }

  modal.style.display = 'flex';
  modal.hidden = false;

  let currentType = 'price';

  modal.querySelectorAll('.rule-tab').forEach(tab => {
    tab.onclick = () => {
      currentType = tab.dataset.type;
      modal.querySelectorAll('.rule-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('priceRuleForm').style.display = currentType === 'price' ? 'block' : 'none';
      document.getElementById('pctChangeRuleForm').style.display = currentType === 'pct_change' ? 'block' : 'none';
      document.getElementById('priceRangeRuleForm').style.display = currentType === 'price_range' ? 'block' : 'none';
      document.getElementById('volumeRuleForm').style.display = currentType === 'volume' ? 'block' : 'none';
    };
  });

  // 涨跌幅快捷按钮
  modal.querySelectorAll('#pctChangeRuleForm .quick-alert-btn').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('pctChangeValue').value = btn.dataset.pct;
    };
  });

  const cancelBtn = document.getElementById('ruleCancel');
  const confirmBtn = document.getElementById('ruleConfirm');

  cancelBtn.onclick = () => {
    modal.style.display = 'none';
    modal.hidden = true;
  };

  confirmBtn.onclick = () => {
    if (currentType === 'price') {
      const val = parseFloat(document.getElementById('priceRuleValue').value);
      if (!val || val <= 0) {
        showToast('请输入有效的价格', 'warn');
        return;
      }
      addPriceRule(targetId, val);
    } else if (currentType === 'pct_change') {
      const val = parseFloat(document.getElementById('pctChangeValue').value);
      if (!val || val === 0) {
        showToast('请输入有效的涨跌幅', 'warn');
        return;
      }
      addPctChangeRule(targetId, val);
    } else if (currentType === 'price_range') {
      const lower = parseFloat(document.getElementById('rangeLower').value);
      const upper = parseFloat(document.getElementById('rangeUpper').value);
      if (!lower || !upper || lower <= 0 || upper <= 0 || lower >= upper) {
        showToast('请输入有效的价格区间（下限<上限）', 'warn');
        return;
      }
      addRangeRule(targetId, lower, upper);
    } else {
      const val = parseFloat(document.getElementById('volRuleValue').value);
      if (!val || val <= 0) {
        showToast('请输入有效的量比阈值', 'warn');
        return;
      }
      addVolumeRule(targetId, val);
    }
    modal.style.display = 'none';
    modal.hidden = true;
    renderTargets();
    showToast('提醒规则已添加', 'success');
  };

  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
      modal.hidden = true;
    }
  };
}

// ============================================================
// 14. 股票详情弹窗
// ============================================================
function showDetailModal(targetId) {
  const t = state.targets.find(x => x.id === targetId);
  if (!t) return;

  let modal = document.getElementById('detailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'detailModal';
    modal.className = 'modal-mask';
    modal.innerHTML = `
      <div class="modal modal-large">
        <div class="modal-header">
          <h3 class="modal-title" id="detailTitle"></h3>
          <button class="modal-close" id="detailClose">×</button>
        </div>
        <div class="detail-body" id="detailBody"></div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="detailAddRule">添加提醒规则</button>
          <button class="btn btn-ghost" id="detailCloseBtn">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const isUp = t.changePct >= 0;
  const colorClass = isUp ? 'up' : 'down';

  document.getElementById('detailTitle').innerHTML = `
    <span>${escapeHtml(t.name || t.code)}</span>
    <span class="modal-subtitle">${t.code}</span>
    <span class="modal-subtitle">${CATEGORY_NAME[t.category] || ''}</span>
  `;

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-price-row">
      <div class="detail-price ${colorClass}">${t.price ? formatPrice(t.price) : '--'}</div>
      <div class="detail-pct ${colorClass}">${Number.isFinite(Number(t.changePct)) ? (isUp ? '+' : '') + Number(t.changePct).toFixed(2) + '%' : '--'}</div>
    </div>
    <div class="detail-grid">
      <div class="detail-item">
        <span class="detail-label">昨收</span>
        <span class="detail-value">${formatPrice(t.prevClose)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">今开</span>
        <span class="detail-value">${formatPrice(t.open)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">最高</span>
        <span class="detail-value up">${formatPrice(t.high)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">最低</span>
        <span class="detail-value down">${formatPrice(t.low)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">成交量</span>
        <span class="detail-value">${formatVolume(t.volume)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">成交额</span>
        <span class="detail-value">${formatAmount(t.amount)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">换手率</span>
        <span class="detail-value">${t.turnoverRate ? t.turnoverRate.toFixed(2) + '%' : '--'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">涨停价</span>
        <span class="detail-value up">${t.limitUp ? formatPrice(t.limitUp) : '--'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">跌停价</span>
        <span class="detail-value down">${t.limitDown ? formatPrice(t.limitDown) : '--'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">当前状态</span>
        <span class="detail-value">${
          t.limitState === 'limitUp' ? '<span class="limit-tag-up">封涨停</span>'
          : t.limitState === 'limitDown' ? '<span class="limit-tag-down">封跌停</span>'
          : '正常交易'
        }</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">复权因子</span>
        <span class="detail-value">${
          t._adjustFactor && t._adjustFactor > 0
            ? t._adjustFactor.toFixed(4)
            : '<span class="detail-na">计算中</span>'
        }</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">量比</span>
        <span class="detail-value">${
          t.volRatio
            ? t.volRatio.toFixed(2)
            : '<span class="detail-na">计算中</span>'
        }</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">振幅</span>
        <span class="detail-value">${t.amplitude ? t.amplitude.toFixed(2) + '%' : '--'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">市盈率</span>
        <span class="detail-value">${
          // ETF/指数/基金无市盈率概念，显示「不适用」而非 0，
          // 否则 0 会被误读为「市盈率为零」。
          (t.category === CATEGORY.STOCK_A || t.category === CATEGORY.HK)
            ? (t.pe ? t.pe.toFixed(2) : '--')
            : '<span class="detail-na">不适用</span>'
        }</span>
      </div>
    </div>
    <div class="detail-chart">
      <canvas id="detailSparkline" width="400" height="100"></canvas>
    </div>
    <div class="detail-rules">
      <h4>已设置提醒规则</h4>
      <div id="detailRulesList"></div>
    </div>
  `;

  if (t._klineData || state._sparkCache[t.code]) {
    const detailCanvas = document.getElementById('detailSparkline');
    if (detailCanvas) {
      drawSparkline(detailCanvas, t._klineData || state._sparkCache[t.code], isUp ? getColorValue('--up') : getColorValue('--down'));
    }
  }

  const rulesList = document.getElementById('detailRulesList');
  if (t.rules && t.rules.length > 0) {
    rulesList.innerHTML = t.rules.map(r => {
      let text = '';
      if (r.type === 'price') text = `价格提醒: ${formatPrice(r.value)}`;
      else if (r.type === 'pct_change') text = `涨跌幅提醒: ${r.pctThreshold > 0 ? '涨' : '跌'}${Math.abs(r.pctThreshold)}%`;
      else if (r.type === 'price_range') text = `区间提醒: ${formatPrice(r.lower)}-${formatPrice(r.upper)}`;
      else if (r.type === 'volume') text = `量比提醒: ≥${r.volRatioThreshold}倍`;
      return `<div class="detail-rule-item">${escapeHtml(text)}</div>`;
    }).join('');
  } else {
    rulesList.innerHTML = '<div class="detail-empty">暂无提醒规则</div>';
  }

  modal.style.display = 'flex';
  modal.hidden = false;

  document.getElementById('detailClose').onclick = closeDetailModal;
  document.getElementById('detailCloseBtn').onclick = closeDetailModal;
  
  document.getElementById('detailAddRule').onclick = () => {
    closeDetailModal();
    showRuleModal(targetId);
  };

  modal.onclick = (e) => {
    if (e.target === modal) closeDetailModal();
  };
}

function closeDetailModal() {
  const modal = document.getElementById('detailModal');
  if (modal) {
    modal.style.display = 'none';
    modal.hidden = true;
  }
}

// ============================================================
// 15. 演示模式
// ============================================================
function setupDemoMode() {
  if (state.settings.demoMode) {
    startDemoMode();
  }
}

function startDemoMode() {
  // 保存用户原始标的，退出演示时恢复
  state._savedTargets = JSON.parse(JSON.stringify(state.targets));
  
  // 停止轮询定时器
  if (state._pollTimer) {
    clearTimeout(state._pollTimer);
    state._pollTimer = null;
  }

  const demoStocks = [
    { code: 'sh600519', name: '贵州茅台', basePrice: 1700, category: CATEGORY.STOCK_A },
    { code: 'sz300750', name: '宁德时代', basePrice: 230, category: CATEGORY.STOCK_A },
    { code: 'sh000001', name: '上证指数', basePrice: 3100, category: CATEGORY.INDEX },
    { code: 'sh510300', name: '沪深300ETF', basePrice: 3.8, category: CATEGORY.ETF },
    { code: 'sz159915', name: '创业板ETF', basePrice: 2.1, category: CATEGORY.ETF },
  ];

  state.targets = demoStocks.map((s, i) => ({
    id: 'demo_' + i,
    code: s.code,
    name: s.name,
    category: s.category,
    price: s.basePrice,
    prevClose: s.basePrice,
    changePct: 0,
    change: 0,
    volume: 10000000 + Math.random() * 5000000,
    amount: 50000000,
    rules: [
      { id: 'r1_' + i, type: 'price', value: s.basePrice * 1.02, _lastSide: -1 },
      { id: 'r2_' + i, type: 'price', value: s.basePrice * 0.98, _lastSide: 1 },
      { id: 'r3_' + i, type: 'volume', volRatioThreshold: 2, avgVolume: 8000000, _lastVolumeAlert: 0 }
    ],
    _fetchState: 'ok',
    _demoBasePrice: s.basePrice,
    _klineData: generateDemoKline(s.basePrice, 60)
  }));

  state._sparkCache = {};
  state.targets.forEach(t => {
    state._sparkCache[t.code] = { data: t._klineData, time: Date.now() };
  });

  // 演示模式大盘数据
  state.marketIndices = MARKET_INDICES.map(m => ({
    name: m.name,
    price: 3000 + Math.random() * 500,
    changePct: (Math.random() - 0.5) * 2
  }));

  renderTargets();
  renderStatusBar();
  startDemoTick();
}

function generateDemoKline(basePrice, count) {
  const data = [];
  let price = basePrice * 0.95;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * basePrice * 0.02;
    const open = price;
    price = price + change;
    const high = Math.max(open, price) + Math.random() * basePrice * 0.01;
    const low = Math.min(open, price) - Math.random() * basePrice * 0.01;
    const close = price;
    const volume = 5000000 + Math.random() * 5000000;

    data.push({
      date: `202501${String(i + 1).padStart(2, '0')}`,
      open, close, high, low, volume
    });
  }
  return data;
}

let demoTimer = null;
function startDemoTick() {
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    state.targets.forEach(t => {
      const base = t._demoBasePrice;
      const change = (Math.random() - 0.5) * base * 0.005;
      const newPrice = t.price + change;

      const prevClose = t.prevClose;
      const pctChange = ((newPrice - prevClose) / prevClose) * 100;

      t.price = newPrice;
      t.changePct = pctChange;
      t.change = newPrice - prevClose;
      t.volume = t.volume + (Math.random() - 0.4) * 500000;

      if (t._klineData) {
        const lastK = t._klineData[t._klineData.length - 1];
        if (lastK) {
          lastK.close = newPrice;
          lastK.high = Math.max(lastK.high, newPrice);
          lastK.low = Math.min(lastK.low, newPrice);
        }
      }

      checkPriceRules(t);
      checkVolumeAlert(t);
    });

    // 演示模式大盘数据波动
    state.marketIndices.forEach(idx => {
      idx.price += (Math.random() - 0.5) * idx.price * 0.003;
      idx.changePct += (Math.random() - 0.5) * 0.1;
    });

    renderTargets();
    renderMarketBar();
    renderStatusBar();
  }, 2000);
}

function stopDemoMode() {
  // 1. 停止演示定时器
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }

  // 2. 设为 false 并立即更新按钮（必须在最前面，确保按钮一定更新）
  state.settings.demoMode = false;
  updateDemoBtn();

  try {
    // 3. 恢复用户原始标的
    if (state._savedTargets && state._savedTargets.length > 0) {
      state.targets = JSON.parse(JSON.stringify(state._savedTargets));
      state._savedTargets = null;
    } else {
      state.targets = [];
    }

    // 4. 重置卡片状态
    state.targets.forEach(t => {
      t._fetchState = 'loading';
      t._klineData = null;
      t.price = null;
      t.changePct = null;
      t.change = null;
      t.volume = null;
      t.amount = null;
      t.high = null;
      t.low = null;
      t.open = null;
    });
    state._sparkCache = {};

    // 5. 保存并渲染
    saveState();
    renderCategoryTabs();
    renderTargets();
    renderStatusBar();

    // 6. 立即拉取真实数据
    pollQuotes();
    pollMarketIndices();
    scheduleMarketPoll();
  } catch (e) {
    console.error('stopDemoMode error:', e);
    showToast('退出演示模式时出错: ' + e.message, 'warn');
  }

  // 确保按钮最终状态正确
  updateDemoBtn();
}

function toggleDemoMode() {
  if (state.settings.demoMode) {
    stopDemoMode();
    showToast('已退出演示模式，正在加载真实数据…', 'info');
  } else {
    if (demoTimer) clearInterval(demoTimer);
    state.settings.demoMode = true;
    saveState();
    startDemoMode();
    showToast('已进入演示模式，数据为模拟', 'info');
  }
  updateDemoBtn();
  renderStatusBar();
}

// ============================================================
// 15. 工具函数
// ============================================================
function formatPrice(p) {
  const v = parseFloat(p);
  if (!isFinite(v)) return '--';
  if (Math.abs(v) >= 100) return v.toFixed(2);
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

// formatVolume / formatAmount 已移至「4.5 量纲校准层」，
// 此处不再重复定义（旧实现按接口原始量纲直接展示，
// 且不带单位，导致「手」被误读为「股」）。

function renderFabList() {
  const list = document.getElementById('fabList');
  if (!list) return;

  let html = '';
  HOT_TARGETS.forEach(group => {
    html += `<div class="fab-group-title">${group.group}</div>`;
    group.items.forEach(item => {
      const alreadyAdded = state.targets.find(t => t.code === normalizeCode(item.code));
      html += `
        <div class="fab-item" data-code="${item.code}" data-name="${item.name}">
          <div class="fab-item-info">
            <span class="fab-item-name">${escapeHtml(item.name)}</span>
            <span class="fab-item-code">${item.code}</span>
          </div>
          <span class="fab-item-add">${alreadyAdded ? '✓' : '+'}</span>
        </div>
      `;
    });
  });
  list.innerHTML = html;

  list.querySelectorAll('.fab-item').forEach(item => {
    item.addEventListener('click', () => {
      const code = item.dataset.code;
      const name = item.dataset.name;
      const alreadyAdded = state.targets.find(t => t.code === normalizeCode(code));
      if (alreadyAdded) {
        showToast('该标的已在列表中', 'warn');
        return;
      }
      addTarget(code, name);
      showToast(`已添加 ${name}`, 'success');
      renderFabList();
    });
  });
}

// ============================================================
// 15.5 复盘统计
//
// 把每次提醒变成可复盘的记录，回答「提醒准不准」。
// 口径与实现见下方注释；纯函数，已由 .audit/verify_review.py 覆盖。
// ============================================================
// ============================================================
// 复盘统计核心逻辑（纯函数，零外部依赖）
// 同时被 app.js 内联复用与 .audit/verify_review.py 独立测试。

// ============================================================
// 复盘统计
//
// 价值定位：盯盘软件的价值不只��「提醒」，还在于「提醒准不准」。
// 用户设置 10 条提醒、其中 7 条是噪音，长期使用后会失去信任。
// 本模块把每次触发变成一条可复盘的记录，回答三个问题：
//   1. 触发后价格往哪走了（涨/跌/横盘）
//   2. 走了多少（后续 N 分钟的涨跌幅）
//   3. 整体胜率如何（按方向/按规则类型分组）
//
// 口径定义（明确写出，避免歧义）：
//   - 基准价 = 触发瞬间的价格，而非收盘价
//   - 观察窗口 = 触发后 N 分钟（默认 30），按自然时间推进
//   - 涨跌方向 = 相对「触发价」的涨跌幅符号，与提醒方向无关
//   - 「方向胜率」仅统计有明确方向的规则（价格/区间/涨跌幅），
//     量比异动无方向性，不计入胜率
// ============================================================

const REVIEW_WINDOW_MIN = 30;   // 默认观察窗口（分钟）
const REVIEW_FLAT_PCT = 0.3;    // 涨跌幅绝对值低于此值视为「横盘」

// 判定单条记录的方向与幅度
function judgeOutcome(triggerPrice, laterPrice, flatPct = REVIEW_FLAT_PCT) {
  const tp = parseFloat(triggerPrice);
  const lp = parseFloat(laterPrice);

  if (!isFinite(tp) || tp <= 0 || !isFinite(lp) || lp <= 0) {
    return { valid: false, direction: 'unknown', pct: 0 };
  }

  const pct = ((lp - tp) / tp) * 100;
  const abs = Math.abs(pct);

  let direction;
  if (abs < flatPct) direction = 'flat';
  else if (pct > 0) direction = 'up';
  else direction = 'down';

  return { valid: true, direction: direction, pct: pct };
}

// 判定一次触发「是否符合用户预期」。
//
// 关键设计：预期方向由「规则语义」推导，而非由用户手动标注。
//   - 「向上突破 X」      → 预期上涨（突破后应继续走强）
//   - 「向下跌破 X」      → 预期下跌
//   - 「进入价格区间」    → 视为中性，不计胜负
//   - 「涨5%」            → 预期上涨
//   - 「跌3%」            → 预期下跌
//   - 「量比异动」        → 无方向，不计胜负
function expectedDirection(ruleType, message) {
  if (ruleType === 'volume' || ruleType === 'limit') return 'none';
  if (ruleType === 'pct_change') {
    if (message && message.includes('涨')) return 'up';
    if (message && message.includes('跌')) return 'down';
    return 'none';
  }
  if (message && message.includes('向上突破')) return 'up';
  if (message && message.includes('向下跌破')) return 'down';
  if (message && message.includes('离开价格区间')) return 'none';
  return 'none';
}

// 汇总统计
// logs: 复盘记录数组，每条形如
//   { code, name, type, message, triggerPrice, triggerTime, outcome: {valid, direction, pct} }
function summarizeLogs(logs) {
  const list = Array.isArray(logs) ? logs : [];

  const stat = {
    total: list.length,
    evaluated: 0,      // 已完成观察窗口
    pending: 0,        // 观察中
    up: 0, down: 0, flat: 0,
    win: 0, loss: 0, neutral: 0,
    avgPct: 0,
    bestPct: null, worstPct: null,
    bestLog: null, worstLog: null,
    byType: {},
    byCode: {}
  };

  const pcts = [];
  let evald = 0;

  for (const l of list) {
    // 按规则类型分组
    if (!stat.byType[l.type]) {
      stat.byType[l.type] = { count: 0, win: 0, loss: 0, neutral: 0, avgPct: 0, _sum: 0, _n: 0 };
    }
    const bt = stat.byType[l.type];
    bt.count++;

    if (!l.outcome || !l.outcome.valid) { stat.pending++; continue; }

    stat.evaluated++;
    evald++;
    pcts.push(l.outcome.pct);

    if (l.outcome.direction === 'up') stat.up++;
    else if (l.outcome.direction === 'down') stat.down++;
    else stat.flat++;

    bt._sum += l.outcome.pct;
    bt._n++;

    const exp = expectedDirection(l.type, l.message);
    if (exp === 'none') {
      stat.neutral++;
      bt.neutral++;
    } else if (l.outcome.direction === 'flat') {
      // 横盘既非胜也非负，按中性计
      stat.neutral++;
      bt.neutral++;
    } else if (l.outcome.direction === exp) {
      stat.win++;
      bt.win++;
    } else {
      stat.loss++;
      bt.loss++;
    }

    // 按标的分组
    const key = l.code;
    if (!stat.byCode[key]) {
      stat.byCode[key] = { name: l.name || key, count: 0, win: 0, loss: 0, neutral: 0 };
    }
    stat.byCode[key].count++;
    if (exp !== 'none' && l.outcome.direction !== 'flat') {
      if (l.outcome.direction === exp) stat.byCode[key].win++;
      else stat.byCode[key].loss++;
    } else {
      stat.byCode[key].neutral++;
    }

    // 极值记录
    if (stat.bestPct === null || l.outcome.pct > stat.bestPct) {
      stat.bestPct = l.outcome.pct;
      stat.bestLog = l;
    }
    if (stat.worstPct === null || l.outcome.pct < stat.worstPct) {
      stat.worstPct = l.outcome.pct;
      stat.worstLog = l;
    }
  }

  if (pcts.length > 0) {
    stat.avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  }
  for (const k in stat.byType) {
    const b = stat.byType[k];
    b.avgPct = b._n > 0 ? b._sum / b._n : 0;
    delete b._sum;
    delete b._n;
  }

  stat.winRate = (stat.win + stat.loss) > 0
    ? stat.win / (stat.win + stat.loss) * 100
    : null;

  return stat;
}

// 观察窗口进度（0~1），用于展示「还需等待多久」
function windowProgress(log, now = Date.now(), windowMin = REVIEW_WINDOW_MIN) {
  if (!log || !log.triggerAt) return 0;
  const elapsed = now - log.triggerAt;
  return Math.max(0, Math.min(1, elapsed / (windowMin * 60 * 1000)));
}

// 判断一条记录是否已完成观察窗口
function isReviewComplete(log, now = Date.now(), windowMin = REVIEW_WINDOW_MIN) {
  if (!log || !log.triggerAt) return false;
  return now - log.triggerAt >= windowMin * 60 * 1000;
}

// ============================================================
// 16. 事件绑定与初始化
// ============================================================
function bindEvents() {
  // 浮动快捷添加按钮
  const fabBtn = document.getElementById('fabBtn');
  const fabPanel = document.getElementById('fabPanel');
  if (fabBtn && fabPanel) {
    fabPanel.hidden = true;
    fabPanel.style.display = 'none';
    fabBtn.addEventListener('click', () => {
      const isHidden = fabPanel.hidden;
      fabPanel.hidden = !isHidden;
      fabPanel.style.display = isHidden ? 'block' : 'none';
      if (isHidden) renderFabList();
    });
  }

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const val = searchInput.value.trim();
        if (!val) return;
        // 无前缀代码需向数据源问明归属，存在网络往返。
        // 加锁避免连按回车重复提交同一代码。
        if (state._adding) return;
        state._adding = true;
        searchInput.value = '';
        hideSearchDropdown();
        try {
          await addTarget(val);
        } finally {
          state._adding = false;
        }
      }
    });
    searchInput.addEventListener('blur', () => {
      setTimeout(hideSearchDropdown, 200);
    });
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim().length >= 2) {
        doSearch(searchInput.value.trim());
      }
    });
  }

  const soundBtn = document.getElementById('soundToggle');
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      state.settings.soundEnabled = !state.settings.soundEnabled;
      updateSoundBtn();
      saveState();
      showToast('提示音已' + (state.settings.soundEnabled ? '开启' : '关闭'), 'info');
    });
  }

  // demoToggle 已通过 HTML onclick 绑定，无需 addEventListener

  const notifBtn = document.getElementById('notifBtn');
  if (notifBtn) {
    notifBtn.addEventListener('click', async () => {
      try {
        const perm = await requestNotifPermission();
        if (perm === 'granted') {
          showToast('桌面通知已开启', 'success');
        } else {
          showToast('通知权限被拒绝', 'warn');
        }
      } catch (e) {
        showToast('浏览器不支持通知', 'warn');
      }
    });
  }

  const clearLogsBtn = document.getElementById('clearLogs');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', () => {
      state.logs = [];
      saveState();
      renderLogs();
      renderReviewPanel();
      showToast('日志已清空', 'info');
    });
  }

  // 复盘面板开合
  const toggleReviewBtn = document.getElementById('toggleReview');
  const reviewPanel = document.getElementById('reviewPanel');
  if (toggleReviewBtn && reviewPanel) {
    reviewPanel.hidden = true;
    toggleReviewBtn.addEventListener('click', () => {
      const show = reviewPanel.hidden;
      reviewPanel.hidden = !show;
      toggleReviewBtn.classList.toggle('active', show);
      state.settings.reviewOpen = show;
      saveState();
      if (show) renderReviewPanel();
    });
    // 恢复上次展开状态
    if (state.settings.reviewOpen) {
      reviewPanel.hidden = false;
      toggleReviewBtn.classList.add('active');
      renderReviewPanel();
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSearchDropdown();
      const fabPanel = document.getElementById('fabPanel');
      if (fabPanel) fabPanel.hidden = true;
      const modals = document.querySelectorAll('.modal-mask');
      modals.forEach(m => {
        m.style.display = 'none';
        m.hidden = true;
      });
    }

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          document.getElementById('searchInput')?.focus();
          break;
        case 'r':
          e.preventDefault();
          pollQuotes();
          showToast('正在刷新数据...', 'info');
          break;
        case 'l':
          e.preventDefault();
          state.logs = [];
          saveState();
          renderLogs();
          renderReviewPanel();
          showToast('日志已清空', 'info');
          break;
        case 'e':
          e.preventDefault();
          exportData();
          break;
      }
    }
  });
}

function exportData() {
  const data = {
    targets: state.targets.map(t => ({
      code: t.code,
      name: t.name,
      category: t.category,
      rules: t.rules.map(r => ({
        type: r.type,
        value: r.value,
        lower: r.lower,
        upper: r.upper,
        volRatioThreshold: r.volRatioThreshold
      }))
    })),
    logs: state.logs,
    settings: {
      soundEnabled: state.settings.soundEnabled,
      notifEnabled: state.settings.notifEnabled
    },
    // 复盘汇总随导出一并保存，便于事后核对提醒质量
    review: summarizeLogs(state.logs),
    exportTime: new Date().toISOString()
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `盯盘数据_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('数据已导出', 'success');
}

function updateSoundBtn() {
  const btn = document.getElementById('soundToggle');
  if (btn) {
    btn.textContent = state.settings.soundEnabled ? '🔊' : '🔇';
    btn.title = state.settings.soundEnabled ? '关闭提示音' : '开启提示音';
  }
}

function updateDemoBtn() {
  const btn = document.getElementById('demoToggle');
  if (btn) {
    btn.textContent = state.settings.demoMode ? '⏹ 退出演示' : '🎮 演示模式';
  }
}

function init() {
  loadState();

  // 先用缓存日历立即可判，随后异步刷新。
  // 必须在首次 pollQuotes 之前完成，否则首轮会按「未加载」判定。
  const cacheFresh = loadCalendarCache();

  if (state.targets.length === 0 && !state.settings.demoMode) {
    showToast('提示：输入股票代码或名称添加自选，或点击右下角 + 快捷添加', 'info');
  }

  bindEvents();
  updateSoundBtn();
  updateDemoBtn();
  renderCategoryTabs();
  renderTargets();
  renderStatusBar();

  if (state.settings.demoMode) {
    // 页面刷新后进入演示模式：先保存当前真实标的到 _savedTargets，再启动演示
    state._savedTargets = JSON.parse(JSON.stringify(state.targets));
    startDemoMode();
  } else {
    pollQuotes();
    pollMarketIndices();
    scheduleMarketPoll();
  }

  if (!cacheFresh) {
    // 日历过期或缺失：后台刷新，完成后重排轮询使新日历立即生效
    refreshCalendar().then(() => {
      renderStatusBar();
      scheduleNextPoll();
      scheduleMarketPoll();
    });
  }

  setInterval(renderCategoryTabs, 60000);
}

document.addEventListener('DOMContentLoaded', init);
