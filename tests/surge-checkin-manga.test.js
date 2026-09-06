'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScript } = require('./helpers/surge-harness');

const filename = path.join(__dirname, '../surge-modules/scripts/bilibili-manga.js');
const key = 'BILI_COMICS_CHECKIN';
const fixedNow = '2026-09-06T03:00:00.000Z';
const cookie = 'SESSDATA=synthetic-session-only; bili_jct=synthetic-csrf; DedeUserID=1001';
const defaultProduct = { id: 42, title: '【超特惠】限量-0点秒杀', real_cost: 100, remain_amount: 8 };

function stored(account = {}, root = {}) {
  return { [key]: JSON.stringify({ account: { 1001: { cookie, ...account } }, ...root }) };
}

function textOf(result) { return result.logs.join('\n'); }
function dataOf(result) { return JSON.parse(result.store[key]); }
function exchanges(result) { return result.requests.filter((request) => /\/Exchange(?:\?|$)/.test(request.url)); }
function verifyFinished(result) {
  assert.equal(result.doneCount, 1);
  assert.equal(JSON.stringify(result.doneValue), '{}');
  assert.doesNotMatch(textOf(result) + JSON.stringify(result.notifications), /synthetic-session-only|synthetic-csrf/);
}

function shop(options = {}) {
  return (_method, request) => {
    if (request.url.endsWith('/ListProduct')) return { body: { code: 0, data: options.products || [defaultProduct] } };
    if (request.url.endsWith('/GetUserPoint')) return { body: { code: 0, data: { point: options.points === undefined ? 1050 : options.points } } };
    if (request.url.endsWith('/Exchange')) return options.exchange || { body: { code: 0 } };
    throw new Error('测试遇到未预期的接口');
  };
}

test('网页登录请求捕获必要 Cookie，不要求 x-bili-mid，并保留账号和兑换历史', async () => {
  const other = { cookie: 'SESSDATA=another-synthetic', lastSuccessDate: '2026-09-05' };
  const store = stored({ cookie: 'SESSDATA=old-synthetic', lastSuccessDate: '2026-09-05', access_key: 'legacy-synthetic', custom: 7 });
  const initial = JSON.parse(store[key]);
  initial.account[2002] = other;
  initial.ProductNum = 3;
  initial.unrelated = { enabled: true };
  store[key] = JSON.stringify(initial);
  const result = await runScript(filename, {
    store,
    request: { url: 'https://manga.bilibili.com/', headers: { cOoKiE: cookie + '; analytics=omit-me', 'user-AGENT': 'Synthetic Browser' } },
  });
  verifyFinished(result);
  const data = dataOf(result);
  assert.equal(data.account[1001].cookie, cookie);
  assert.equal(data.account[1001].userAgent, 'Synthetic Browser');
  assert.equal(data.account[1001].lastSuccessDate, '2026-09-05');
  assert.equal(data.account[1001].access_key, 'legacy-synthetic');
  assert.equal(data.account[1001].custom, 7);
  assert.deepEqual(data.account[2002], other);
  assert.deepEqual(data.unrelated, initial.unrelated);
  assert.equal(data.ProductNum, 3);
  assert.equal(result.requests.length, 0);
  assert.match(textOf(result), /登录凭据已保存/);
});

test('非本站、无 UID、无 SESSDATA 和畸形 Cookie 不覆盖凭据', async () => {
  for (const request of [
    { url: 'https://manga.bilibili.com.evil.invalid/', headers: { Cookie: cookie } },
    { url: 'https://manga.bilibili.com/', headers: { Cookie: 'SESSDATA=synthetic-session-only' } },
    { url: 'https://manga.bilibili.com/', headers: { Cookie: 'DedeUserID=1001' } },
    { url: 'https://manga.bilibili.com/', headers: { Cookie: 'DedeUserID=1001; SESSDATA=bad\r\nvalue' } },
  ]) {
    const store = stored();
    const before = store[key];
    const result = await runScript(filename, { store, request });
    verifyFinished(result);
    assert.equal(store[key], before);
    assert.equal(result.requests.length, 0);
  }
});

test('旧 App access_key 捕获可用，稀疏 Cookie 不覆盖已有完整凭据', async () => {
  const result = await runScript(filename, {
    store: stored(),
    request: { url: 'https://app.bilibili.com/x/v2/account/myinfo?access_key=synthetic-access', headers: { 'x-bili-mid': '1001', Cookie: 'DedeUserID=1001' } },
  });
  verifyFinished(result);
  assert.equal(dataOf(result).account[1001].cookie, cookie);
  assert.equal(dataOf(result).account[1001].access_key, 'synthetic-access');
});

test('签到校验业务状态，使用秒级超时且不转发重定向', async () => {
  const result = await runScript(filename, { store: stored({ userAgent: 'Synthetic Browser' }), http: () => ({ body: { code: 0 } }) });
  verifyFinished(result);
  assert.match(textOf(result), /签到成功/);
  assert.equal(result.requests.length, 1);
  const request = result.requests[0];
  assert.match(request.url, /activity\.v1\.Activity\/ClockIn\?platform=ios$/);
  assert.equal(request.method, 'post');
  assert.equal(request.headers.Cookie, cookie);
  assert.equal(request.headers['User-Agent'], 'Synthetic Browser');
  assert.equal(JSON.parse(request.body).csrf, 'synthetic-csrf');
  assert.ok(request.timeout > 0 && request.timeout <= 8);
  assert.equal(request['auto-redirect'], false);
  assert.equal(request['auto-cookie'], false);
});

test('Surge Mac 实测契约使用 platform=ios，不能重复签到是明确独立结果', async () => {
  const result = await runScript(filename, {
    store: stored(),
    http: (_method, request) => request.url.endsWith('?platform=ios')
      ? { status: 200, body: { code: 1, msg: '不能重复签到~' } }
      : { status: 400, body: { code: 'invalid_argument', msg: 'platform must be valid', meta: { argument: 'platform' } } },
  });
  verifyFinished(result);
  assert.match(textOf(result), /今日已签到/);
  assert.doesNotMatch(textOf(result), /签到成功/);
});

test('网络、HTTP、登录及未知业务响应不误报成功且不删除过期账号', async () => {
  const cases = [
    [{ error: 'connection synthetic-session-only' }, /网络请求失败/],
    [{ status: 503, body: { code: 0 } }, /HTTP 请求失败/],
    [{ status: 302, headers: { Location: 'https://evil.invalid/' } }, /重定向/],
    [{ status: 403 }, /站点验证/],
    [{ status: 429 }, /访问限制/],
    [{ status: 401 }, /登录失效/],
    [{ body: { code: -101 } }, /登录失效/],
    [{ body: { code: 1, msg: 'uid must > 0' } }, /登录失效/],
    [{ body: '<html>Login</html>' }, /响应不是预期 JSON/],
    [{ body: { data: { ok: true } } }, /响应缺少有效业务状态/],
    [{ body: { code: '0' } }, /响应缺少有效业务状态/],
    [{ body: { code: 7, msg: 'synthetic-session-only' } }, /签到失败/],
  ];
  for (const [response, expected] of cases) {
    const store = stored({ lastSuccessDate: '2026-09-05' });
    const before = store[key];
    const result = await runScript(filename, { store, http: () => response });
    verifyFinished(result);
    assert.match(textOf(result), expected);
    assert.doesNotMatch(textOf(result), /签到成功|今日已签到/);
    assert.equal(store[key], before);
    assert.equal(result.requests.length, 1);
  }
});

test('无凭据及畸形存储不发网络请求，原始存储保留', async () => {
  for (const raw of [undefined, '{broken', '[]', '{"account":[]}', '{"account":{"1001":{}}}']) {
    const store = raw === undefined ? {} : { [key]: raw };
    const before = store[key];
    const result = await runScript(filename, { store });
    verifyFinished(result);
    assert.equal(result.requests.length, 0);
    assert.equal(store[key], before);
    assert.match(textOf(result), /凭据|存储/);
  }
});

test('多账号独立执行，失败账号不会被删除', async () => {
  const store = stored({}, { account: { 1001: { cookie }, 2002: { cookie: 'SESSDATA=expired-synthetic' } } });
  const before = store[key];
  const result = await runScript(filename, { store, http: (_method, request) => ({ body: { code: request.headers.Cookie === cookie ? 0 : -101 } }) });
  verifyFinished(result);
  assert.match(textOf(result), /账号 1：签到成功/);
  assert.match(textOf(result), /账号 2：登录失效/);
  assert.equal(store[key], before);
});

test('兑换默认模拟，查询商品和积分但绝不调用 Exchange 或修改历史', async () => {
  const store = stored({ exchangePending: { state: 'pending' }, lastSuccessDate: '2026-09-06' });
  const before = store[key];
  const result = await runScript(filename, { store, argument: 'action=exchange', http: shop(), now: fixedNow });
  verifyFinished(result);
  assert.equal(result.requests.length, 2);
  assert.equal(exchanges(result).length, 0);
  assert.equal(store[key], before);
  assert.match(textOf(result), /模拟查询完成，未兑换.*当前积分 1050.*库存 8.*单价 100.*计划数量 8.*总积分 800/);
});

test('售罄和未上架商品仍查询积分，模拟模式不写入积分不足状态', async () => {
  for (const products of [[{ ...defaultProduct, remain_amount: 0 }], []]) {
    const store = stored();
    const before = store[key];
    const result = await runScript(filename, { store, argument: 'action=exchange&dry_run=true', http: shop({ products, points: 0 }) });
    verifyFinished(result);
    assert.equal(result.requests.length, 2);
    assert.equal(exchanges(result).length, 0);
    assert.equal(store[key], before);
    assert.match(textOf(result), /当前积分 0/);
  }
});

test('数量上限、余额与库存共同决定兑换数，零价格不会产生 Infinity', async () => {
  for (const [args, product, points, expectedCount, expectedPoints] of [
    ['product_num=2', defaultProduct, 1050, 2, 200],
    ['product_num=9', defaultProduct, 350, 3, 300],
    ['product_num=0', { ...defaultProduct, remain_amount: 2 }, 1050, 2, 200],
    ['product_num=0', { ...defaultProduct, real_cost: 0, remain_amount: 4 }, 0, 4, 0],
  ]) {
    const result = await runScript(filename, { store: stored(), argument: 'action=exchange&dry_run=false&' + args, http: shop({ products: [product], points }), now: fixedNow });
    verifyFinished(result);
    assert.equal(exchanges(result).length, 1);
    const payload = JSON.parse(exchanges(result)[0].body);
    assert.equal(payload.product_num, expectedCount);
    assert.equal(payload.point, expectedPoints);
    assert.match(textOf(result), /兑换成功/);
  }
});

test('参数范围及布尔值严格验证，错误不发请求', async () => {
  for (const args of ['product_num=-1', 'product_num=1.5', 'product_num=1000001', 'product_num=abc', 'attempts=0', 'attempts=101', 'attempts=2.5', 'dry_run=0', 'dry_run=', 'product_name=', 'product_name=%ZZ']) {
    const result = await runScript(filename, { store: stored(), argument: 'action=exchange&' + args });
    verifyFinished(result);
    assert.equal(result.requests.length, 0, args);
    assert.doesNotMatch(textOf(result), /成功/);
  }
});

test('旧参数与根存储设置兼容，显式数量零保留最大值语义', async () => {
  for (const argument of ['action=exchange&ProductNum=2&ExchangeNum=3&ProductName=fixture', '{"action":"exchange","product_num":2,"attempts":3,"product_name":"fixture","dry_run":true}']) {
    const result = await runScript(filename, { store: stored(), argument, http: shop({ products: [{ ...defaultProduct, title: 'fixture' }] }) });
    verifyFinished(result);
    assert.match(textOf(result), /计划数量 2/);
  }
  const result = await runScript(filename, { store: stored({}, { ProductNum: '3', ExchangeNum: '2', ProductName: 'fixture' }), argument: 'action=exchange&product_num=0', http: shop({ products: [{ ...defaultProduct, title: 'fixture' }] }) });
  verifyFinished(result);
  assert.match(textOf(result), /计划数量 8/);
});

test('商城只读查询最多尝试两次', async () => {
  let calls = 0;
  const result = await runScript(filename, { store: stored(), argument: 'action=exchange', http: () => { calls++; return { status: 503 }; } });
  verifyFinished(result);
  assert.equal(calls, 2);
  assert.equal(exchanges(result).length, 0);
  assert.match(textOf(result), /HTTP 请求失败/);
});

test('商城非预期结构及未认证响应不进入交易', async () => {
  for (const overrides of [
    { products: { list: [defaultProduct] } },
    { products: [{ ...defaultProduct, id: 0 }] },
    { products: [{ ...defaultProduct, real_cost: -1 }] },
    { products: [{ ...defaultProduct, remain_amount: 'many' }] },
    { points: '100oops' },
  ]) {
    const result = await runScript(filename, { store: stored(), argument: 'action=exchange&dry_run=false', http: shop(overrides) });
    verifyFinished(result);
    assert.equal(exchanges(result).length, 0);
    assert.doesNotMatch(textOf(result), /兑换成功/);
  }
});

test('已成功和旧积分不足日期阻止重复真实兑换', async () => {
  for (const flags of [{ lastSuccessDate: '2026-09-06' }, { lastInsufficientDate: '2026-09-06' }, { exchangePending: { date: '2026-09-05' } }]) {
    const result = await runScript(filename, { store: stored(flags), argument: 'action=exchange&dry_run=false', now: fixedNow });
    verifyFinished(result);
    assert.equal(result.requests.length, 0);
    assert.match(textOf(result), /跳过|待确认/);
  }
});

test('成功兑换记录一次，保留其他账号、旧配置和捕获期间刷新字段', async () => {
  const store = stored({ custom: 7 }, { ProductNum: 2, unrelated: true });
  const handler = shop();
  const result = await runScript(filename, {
    store, argument: 'action=exchange&dry_run=false', now: fixedNow,
    http: (method, request) => {
      if (request.url.endsWith('/Exchange')) {
        const current = JSON.parse(store[key]);
        assert.equal(current.account[1001].exchangePending.state, 'pending');
        current.account[1001].browserRefresh = true;
        current.account[2002] = { cookie: 'SESSDATA=other-fixture' };
        store[key] = JSON.stringify(current);
      }
      return handler(method, request);
    },
  });
  verifyFinished(result);
  const data = dataOf(result);
  assert.equal(data.account[1001].lastSuccessDate, '2026-09-06');
  assert.equal(data.account[1001].lastExchange.quantity, 2);
  assert.equal(data.account[1001].exchangePending, undefined);
  assert.equal(data.account[1001].browserRefresh, true);
  assert.equal(data.account[1001].custom, 7);
  assert.equal(data.account[2002].cookie, 'SESSDATA=other-fixture');
  assert.equal(data.unrelated, true);
  assert.equal(data.ProductNum, 2);
  const again = await runScript(filename, { store, argument: 'action=exchange&dry_run=false', http: shop(), now: fixedNow });
  verifyFinished(again);
  assert.equal(exchanges(again).filter((request) => request.headers.Cookie === cookie).length, 0);
  assert.match(textOf(again), /账号 1：今日已兑换成功/);
});

test('交易网络失败、HTTP错误及未知响应保存待确认状态，不重试也不在下个 cron 重发', async () => {
  for (const exchangeResponse of [{ error: 'timeout' }, { status: 503 }, { body: '<html>unknown</html>' }, { body: { unexpected: true } }, { status: 401 }]) {
    const store = stored();
    const result = await runScript(filename, { store, argument: 'action=exchange&dry_run=false&attempts=100', http: shop({ exchange: exchangeResponse }), now: fixedNow });
    verifyFinished(result);
    assert.equal(exchanges(result).length, 1);
    assert.match(textOf(result), /兑换结果不确定/);
    assert.equal(dataOf(result).account[1001].exchangePending.state, 'pending');
    const again = await runScript(filename, { store, argument: 'action=exchange&dry_run=false', now: '2026-09-07T03:00:00.000Z' });
    verifyFinished(again);
    assert.equal(again.requests.length, 0);
    assert.match(textOf(again), /待确认/);
  }
});

test('仅明确可重试拒绝受 attempts 限制，未知业务错误不重试', async () => {
  const result = await runScript(filename, { store: stored(), argument: 'action=exchange&dry_run=false&attempts=3', http: shop({ exchange: { body: { code: 9, msg: '请求过于频繁' } } }) });
  verifyFinished(result);
  assert.equal(exchanges(result).length, 3);
  assert.match(textOf(result), /已尝试 3 次/);
  assert.equal(dataOf(result).account[1001].exchangePending, undefined);
  const unknown = await runScript(filename, { store: stored(), argument: 'action=exchange&dry_run=false&attempts=100', http: shop({ exchange: { body: { code: 9, msg: '未知业务错误' } } }) });
  verifyFinished(unknown);
  assert.equal(exchanges(unknown).length, 1);
  assert.match(textOf(unknown), /兑换被拒绝/);
});

test('运行中的兑换锁阻止 cron 重叠，模拟查询不受交易锁阻断', async () => {
  const store = stored();
  store.BILI_COMICS_EXCHANGE_LOCK = JSON.stringify({ token: 'another-run', until: new Date(fixedNow).getTime() + 30000 });
  const blocked = await runScript(filename, { store, argument: 'action=exchange&dry_run=false', now: fixedNow });
  verifyFinished(blocked);
  assert.equal(blocked.requests.length, 0);
  assert.match(textOf(blocked), /已有积分兑换任务/);
  assert.equal(JSON.parse(store.BILI_COMICS_EXCHANGE_LOCK).token, 'another-run');
  const dry = await runScript(filename, { store, argument: 'action=exchange', http: shop(), now: fixedNow });
  verifyFinished(dry);
  assert.equal(dry.requests.length, 2);
  assert.equal(JSON.parse(store.BILI_COMICS_EXCHANGE_LOCK).token, 'another-run');
});
