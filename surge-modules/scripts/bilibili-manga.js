/*
 * 哔哩哔哩漫画：Surge Mac 原生签到、网页登录凭据捕获及积分兑换。
 * 接口及旧存储兼容性参考 NobyDa/Script 的 Manga.js、ExchangePoints.js。
 * 本实现独立编写，不加载第三方代码；来源说明见 ../SOURCES.md。
 */
(function () {
  'use strict';
  const STORE_KEY = 'BILI_COMICS_CHECKIN';
  const LOCK_KEY = 'BILI_COMICS_EXCHANGE_LOCK';
  const ORIGIN = 'https://manga.bilibili.com';
  const DEADLINE = Date.now() + 50000;
  let finished = false;
  let lease = '';
  let action = typeof $request !== 'undefined' ? 'capture' : 'checkin';

  function report(status, body, accountNumber) {
    const subtitle = status + (accountNumber ? ' · 账号 ' + accountNumber : '');
    console.log('哔哩哔哩漫画：' + subtitle + '\n' + body);
    try { $notification.post('哔哩哔哩漫画', subtitle, body); }
    catch (_) { console.log('哔哩哔哩漫画：通知发送失败'); }
  }

  function failureStatus() {
    return action === 'capture' ? 'Cookie 更新失败' : action === 'exchange' ? '兑换失败' : '签到失败';
  }

  function fail(message, retryable) {
    const error = new Error(message);
    error.safeMessage = message;
    error.retryable = !!retryable;
    return error;
  }

  function readData() {
    const raw = $persistentStore.read(STORE_KEY);
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch (_) { throw fail('账号存储格式异常，已保留原数据。'); }
    if (!isObject(data) || (data.account !== undefined && !isObject(data.account))) {
      throw fail('账号存储结构异常，已保留原数据。');
    }
    return data;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // 每次更新都重读，避免覆盖捕获脚本或其他账号刚写入的内容。
  function updateAccount(uid, change) {
    const data = readData();
    if (!data.account) data.account = {};
    const account = data.account[uid] || {};
    if (!isObject(account)) throw fail('账号数据异常，已保留原数据。');
    change(account);
    data.account[uid] = account;
    if (!$persistentStore.write(JSON.stringify(data), STORE_KEY)) {
      throw fail('账号存储写入失败，已停止后续操作。');
    }
  }

  function parseArguments() {
    const values = {};
    const raw = typeof $argument === 'string' ? $argument : '';
    if (raw.trim().startsWith('{')) {
      try {
        const object = JSON.parse(raw);
        if (!isObject(object)) throw new Error();
        return object;
      } catch (_) { throw fail('脚本参数 JSON 格式无效。'); }
    }
    raw.split('&').filter(Boolean).forEach(function (entry) {
      const equals = entry.indexOf('=');
      if (equals < 1) throw fail('脚本参数格式无效。');
      try { values[entry.slice(0, equals)] = decodeURIComponent(entry.slice(equals + 1)); }
      catch (_) { throw fail('脚本参数编码无效。'); }
    });
    return values;
  }

  function integer(value, fallback, min, max, label) {
    const actual = value === undefined ? fallback : value;
    if (!/^\d+$/.test(String(actual))) throw fail(label + '必须是整数。');
    const number = Number(actual);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw fail(label + '须在 ' + min + '–' + max + ' 之间。');
    }
    return number;
  }

  function boolean(value) {
    if (value === undefined || value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw fail('dry_run 只接受 true 或 false。');
  }

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(function (key) { return key.toLowerCase() === name; });
    return key ? String(headers[key]) : '';
  }

  function cookies(raw) {
    const result = {};
    String(raw || '').split(';').forEach(function (part) {
      const equals = part.indexOf('=');
      if (equals > 0) result[part.slice(0, equals).trim()] = part.slice(equals + 1).trim();
    });
    return result;
  }

  function capture() {
    if (typeof $request === 'undefined') throw fail('凭据捕获须由浏览器请求触发。');
    const url = String($request.url || '');
    if (!/^https:\/\/(?:manga\.bilibili\.com\/(?:$|\?|account(?:\/|\?|$)|twirp\/)|app\.bilibili\.com\/x\/v\d+\/account\/myinfo(?:\?|$))/.test(url)) {
      return;
    }
    const values = cookies(header($request.headers, 'cookie'));
    const uid = values.DedeUserID || header($request.headers, 'x-bili-mid');
    const access = /[?&]access_key=([A-Za-z0-9_-]+)(?:&|$)/.exec(url);
    const appRequest = /^https:\/\/app\.bilibili\.com\//.test(url);
    if (!/^[1-9]\d*$/.test(uid) || (!values.SESSDATA && !(appRequest && access))) return;
    const cookie = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']
      .filter(function (name) { return values[name] && !/[\r\n]/.test(values[name]); })
      .map(function (name) { return name + '=' + values[name]; }).join('; ');
    if (values.SESSDATA && /[\r\n]/.test(values.SESSDATA)) return;
    const agent = header($request.headers, 'user-agent');
    let changed = false;
    updateAccount(uid, function (account) {
      changed = (!!cookie && account.cookie !== cookie) || (!!access && account.access_key !== access[1]);
      if (values.SESSDATA) account.cookie = cookie;
      if (appRequest && access) account.access_key = access[1];
      if (agent && !/[\r\n]/.test(agent)) account.userAgent = agent;
    });
    if (changed) report('Cookie 更新成功', '后续签到和积分兑换将使用最新登录信息', Object.keys(readData().account).indexOf(uid) + 1);
  }

  function today() {
    const date = new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function acquireLease() {
    const raw = $persistentStore.read(LOCK_KEY);
    if (raw) {
      let lock;
      try { lock = JSON.parse(raw); } catch (_) { throw fail('兑换执行锁格式异常，请检查存储。'); }
      if (!isObject(lock) || !Number.isFinite(lock.until)) throw fail('兑换执行锁结构异常，请检查存储。');
      if (lock.until > Date.now()) throw fail('已有积分兑换任务执行中，本次跳过。');
    }
    lease = Date.now() + '-' + Math.random().toString(36).slice(2);
    if (!$persistentStore.write(JSON.stringify({ token: lease, until: Date.now() + 90000 }), LOCK_KEY)) {
      lease = '';
      throw fail('无法建立兑换执行锁，未发出兑换请求。');
    }
  }

  function releaseLease() {
    if (!lease) return;
    try {
      const lock = JSON.parse($persistentStore.read(LOCK_KEY) || '{}');
      if (lock.token === lease) $persistentStore.write(null, LOCK_KEY);
    } catch (_) { console.log('兑换执行锁未清理，将在有效期后释放。'); }
  }

  function request(account, path, payload) {
    const remaining = DEADLINE - Date.now();
    if (remaining < 100) return Promise.reject(fail('已达到 50 秒总执行时限。'));
    const timeout = Math.min(8, remaining / 1000);
    const headers = { 'Content-Type': 'application/json', Referer: ORIGIN + '/', Origin: ORIGIN };
    if (typeof account.cookie === 'string') headers.Cookie = account.cookie;
    if (typeof account.userAgent === 'string') headers['User-Agent'] = account.userAgent;
    const body = Object.assign({}, payload);
    const csrf = cookies(account.cookie).bili_jct;
    if (csrf) { body.csrf = csrf; body.csrf_token = csrf; }
    // 优先使用捕获的网页登录态，保留旧 App access_key 账号兼容性。
    let url = ORIGIN + path;
    if (!cookies(account.cookie).SESSDATA && account.access_key) {
      url += (url.indexOf('?') < 0 ? '?' : '&') + 'access_key=' + encodeURIComponent(account.access_key);
    }
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () { finish(fail('网络请求超时。', true)); }, timeout * 1000);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (typeof clearTimeout === 'function') clearTimeout(timer);
        error ? reject(error) : resolve(value);
      }
      try {
        $httpClient.post({ url: url, headers: headers, body: JSON.stringify(body), timeout: timeout, 'auto-redirect': false, 'auto-cookie': false }, function (error, response, raw) {
          if (error) return finish(fail('网络请求失败。', true));
          const status = Number(response && response.status);
          if (status === 401) return finish(fail('登录失效，请重新打开漫画网页捕获凭据。'));
          if (status === 403 || status === 412 || status === 429) return finish(fail('站点验证或访问限制（HTTP ' + status + '）。'));
          if (status >= 300 && status < 400) return finish(fail('站点返回重定向，未转发登录凭据。'));
          if (status < 200 || status >= 300 || !Number.isFinite(status)) return finish(fail('HTTP 请求失败（' + (Number.isFinite(status) ? status : '无状态') + '）。', status >= 500));
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { return finish(fail('响应不是预期 JSON，可能是登录页或验证拦截。')); }
          if (!isObject(parsed) || !Number.isInteger(parsed.code)) return finish(fail('响应缺少有效业务状态，未判定为成功。'));
          const message = String(parsed.msg || parsed.message || '');
          if (parsed.code === -101 || /uid must > 0|未登录|登录失效|登陆失效|not login/i.test(message)) {
            return finish(fail('登录失效，请重新打开漫画网页捕获凭据。'));
          }
          finish(null, parsed);
        });
      } catch (_) { finish(fail('网络请求未能完成。', true)); }
    });
  }

  async function query(account, endpoint) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await request(account, '/twirp/pointshop.v1.Pointshop/' + endpoint, {});
        if (result.code !== 0) throw fail('商城查询失败（业务代码 ' + result.code + '）。');
        return result.data;
      } catch (error) {
        if (!error.retryable || attempt === 1) throw error;
      }
    }
  }

  async function balanceText(account) {
    try {
      const balance = await query(account, 'GetUserPoint');
      const point = balance && balance.point;
      if (!/^-?\d+$/.test(String(point)) || !Number.isSafeInteger(Number(point))) throw fail('积分余额格式异常。');
      return '当前余额：' + Number(point) + ' 积分';
    } catch (_) {
      return '当前余额：查询失败';
    }
  }

  async function checkin(account) {
    // 该 API 要求 platform=ios；Surge Mac 实测拒绝 web，与脚本运行系统无关。
    const result = await request(account, '/twirp/activity.v1.Activity/ClockIn?platform=ios', {});
    if (result.code !== 0 && result.code !== 1) throw fail('签到失败（业务代码 ' + result.code + '）。');
    return { status: result.code === 0 ? '签到成功' : '今日已签到', body: await balanceText(account) };
  }

  function exchangeOptions(args, data) {
    const name = args.product_name !== undefined ? args.product_name : (args.ProductName !== undefined ? args.ProductName : (data.ProductName || '【超特惠】限量-0点秒杀'));
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\r\n]/.test(name)) throw fail('商品名称必须是 1–200 个字符。');
    return {
      name: name,
      number: integer(args.product_num !== undefined ? args.product_num : (args.ProductNum !== undefined ? args.ProductNum : data.ProductNum), 0, 0, 1000000, '兑换数量'),
      attempts: integer(args.attempts !== undefined ? args.attempts : (args.ExchangeNum !== undefined ? args.ExchangeNum : data.ExchangeNum), 100, 1, 100, '尝试次数'),
      dryRun: boolean(args.dry_run)
    };
  }

  function nonnegative(value, label) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail(label + '格式异常。');
    return Number(value);
  }

  async function exchange(uid, account, options) {
    const date = today();
    if (!options.dryRun) {
      if (account.exchangePending) return { status: '兑换未执行', body: '原因：存在待确认的兑换结果，请先在网站核对交易' };
      if (account.lastSuccessDate === date) return { status: '兑换未执行', body: '原因：今日已兑换成功，跳过真实兑换' };
      if (account.lastInsufficientDate === date) return { status: '兑换未执行', body: '原因：今日已记录积分不足，跳过真实兑换' };
    }
    const products = await query(account, 'ListProduct');
    if (!Array.isArray(products)) throw fail('商品列表结构异常。');
    const balance = await query(account, 'GetUserPoint');
    if (!isObject(balance)) throw fail('积分响应结构异常。');
    const points = nonnegative(balance.point, '积分');
    const product = products.find(function (item) { return isObject(item) && item.title === options.name; });
    if (!product) return { status: options.dryRun ? '试运行完成' : '兑换未执行', body: '当前余额：' + points + ' 积分\n原因：目标商品未上架' };
    const cost = nonnegative(product.real_cost, '商品积分价格');
    const stock = nonnegative(product.remain_amount, '商品库存');
    const id = nonnegative(product.id, '商品 ID');
    if (!id) throw fail('商品 ID 无效，无法发起兑换。');
    const affordable = cost === 0 ? stock : Math.floor(points / cost);
    const count = Math.min(options.number || affordable, affordable, stock);
    if (!Number.isSafeInteger(count * cost)) throw fail('积分总成本超过安全整数范围。');
    const detail = '当前余额：' + points + ' 积分\n商品库存：' + stock + '\n商品单价：' + cost + ' 积分\n计划数量：' + count + '\n计划消耗：' + count * cost + ' 积分';
    if (options.dryRun) return { status: '试运行完成', body: detail + '\n执行模式：只读，不兑换' };
    if (!stock) return { status: '兑换未执行', body: '当前余额：' + points + ' 积分\n原因：商品库存为零' };
    if (!affordable) {
      updateAccount(uid, function (current) { current.lastInsufficientDate = date; });
      return { status: '兑换未执行', body: '当前余额：' + points + ' 积分\n原因：积分不足' };
    }
    const transaction = { date: date, productId: id, quantity: count, points: count * cost, startedAt: Date.now(), state: 'pending' };
    for (let attempt = 0; attempt < options.attempts; attempt++) {
      // 在交易前保存。崩溃、断网或超时后保留 pending，下一次 cron 不会盲目重发。
      updateAccount(uid, function (current) { current.exchangePending = transaction; });
      let result;
      try {
        result = await request(account, '/twirp/pointshop.v1.Pointshop/Exchange', { product_id: id, product_num: count, point: count * cost });
      } catch (error) {
        throw fail('兑换结果不确定，已停止重试并锁定后续真实兑换；请先在网站核对交易。' + (error.safeMessage || ''));
      }
      if (result.code === 0) {
        updateAccount(uid, function (current) {
          current.lastSuccessDate = date;
          current.lastExchange = Object.assign({}, transaction, { state: 'success' });
          delete current.exchangePending;
          delete current.lastInsufficientDate;
        });
        return { status: '兑换成功', body: await balanceText(account) + '\n本次兑换：' + count + '\n本次消耗：' + count * cost + ' 积分' };
      }
      // 明确的业务拒绝无需保留未决交易；仅明确限流/未开始消息允许有界重试。
      updateAccount(uid, function (current) { delete current.exchangePending; });
      const message = String(result.msg || result.message || '');
      const retry = /^(请求过于频繁|请求太频繁|操作太频繁|活动未开始|系统繁忙，请稍后再试)[。！!]?$/i.test(message);
      if (!retry || attempt + 1 >= options.attempts) throw fail('兑换被拒绝（业务代码 ' + result.code + '；已尝试 ' + (attempt + 1) + ' 次）。');
      if (Date.now() + 250 >= DEADLINE) throw fail('已达到 50 秒总执行时限，停止重试。');
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
  }

  async function main() {
    const args = parseArguments();
    action = args.action || action;
    if (action === 'capture') return capture();
    if (action !== 'checkin' && action !== 'exchange') throw fail('不支持的 action 参数。');
    const data = readData();
    const options = action === 'exchange' ? exchangeOptions(args, data) : null;
    const ids = Object.keys(data.account || {});
    if (!ids.length) throw fail('尚无登录凭据，请打开已登录的漫画网页。');
    if (options && !options.dryRun) acquireLease();
    for (let index = 0; index < ids.length; index++) {
      if (Date.now() >= DEADLINE) { report(failureStatus(), '原因：已达到 50 秒总执行时限，剩余账号未执行', index + 1); break; }
      try {
        const account = readData().account[ids[index]];
        if (!isObject(account) || (!cookies(account.cookie).SESSDATA && !account.access_key)) throw fail('登录凭据缺失；保留原账号，请重新捕获。');
        const result = action === 'checkin' ? await checkin(account) : await exchange(ids[index], account, options);
        report(result.status, result.body, index + 1);
      } catch (error) { report(failureStatus(), '原因：' + (error.safeMessage || '脚本执行失败'), index + 1); }
    }
  }

  Promise.resolve().then(main).catch(function (error) {
    report(failureStatus(), '原因：' + (error.safeMessage || '脚本执行异常'));
  }).finally(function () {
    if (finished) return;
    finished = true;
    releaseLease();
    $done({});
  });
})();
