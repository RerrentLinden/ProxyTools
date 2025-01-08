/*
谷粉学术每日签到脚本 - Surge专用版

脚本说明：
1. 用于谷粉学术(bbs.yuyingufen.com)的每日自动签到
2. 支持自动获取Cookie和定时签到功能
3. 签到结果通过通知反馈

基于科研通签到脚本重构
更新时间：2025-01-09
脚本作者：@RerrentLinden

脚本遵循开源协议，转载请注明出处
*/

// 基础配置
const NAME = '谷粉学术';
const SIGN_URL = 'https://bbs.yuyingufen.com/plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1&inajax=1';  // Discuz论坛签到接口
const COOKIE_KEY = 'gfscholarCookie';  // 存储Cookie的键名
const COOKIE_NAMES = ['auth', 'saltkey'];  // 必要的Cookie名称前缀
const AUTH_PREFIX = '7BaM_2132_';  // Cookie名称前缀
const TIMEOUT = 5000;  // 超时时间(毫秒)

// 工具函数封装
const $ = {
    name: NAME,
    // 通知函数
    msg: (title, subtitle = '', body = '') => $notification.post(title, subtitle, body),
    // 存储操作
    store: {
        read: (key) => $persistentStore.read(key),
        write: (val, key) => $persistentStore.write(val, key)
    }
};

// 生成请求头
const getHeaders = (cookieObj) => {
    // 组装完整的Cookie字符串
    const cookieStr = Object.entries(cookieObj)
        .map(([key, value]) => `${AUTH_PREFIX}${key}=${value}`)
        .join('; ');

    return {
        'Cookie': cookieStr,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://bbs.yuyingufen.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
    };
};

// 签到函数
const sign = () => {
    const cookieStr = $.store.read(COOKIE_KEY);
    if (!cookieStr) {
        $.msg(NAME, '❌ 签到失败', '请先获取Cookie');
        return $done();
    }

    const cookieObj = JSON.parse(cookieStr);
    
    $httpClient.get({
        url: SIGN_URL,
        headers: getHeaders(cookieObj),
        timeout: TIMEOUT
    }, (error, response, data) => {
        let subtitle = '', body = '';
        
        try {
            if (error) throw new Error('网络请求异常');
            
            // Discuz论坛返回的是特殊格式，需要正则匹配处理
            if (data.includes('签到成功')) {
                subtitle = '🎉 签到成功';
                // 尝试提取积分信息
                const pointsMatch = data.match(/获得\s*(\d+)\s*积分/);
                const points = pointsMatch ? pointsMatch[1] : '未知';
                body = `获得${points}积分`;
            } else if (data.includes('已经签到')) {
                subtitle = '📢 重复签到';
                body = '今日已签到';
            } else {
                throw new Error('签到失败');
            }
        } catch (e) {
            subtitle = '❌ 签到失败';
            body = e.message || '未知错误';
        }
        
        $.msg(NAME, subtitle, body);
        $done();
    });
};

// Cookie获取函数
const getCookie = () => {
    if (!$response?.headers) {
        $.msg(NAME, '❌ Cookie获取失败', '无响应数据');
        return $done();
    }

    const setCookie = $response.headers['Set-Cookie'] || $response.headers['set-cookie'];
    if (!setCookie) return $done();

    const cookieObj = {};
    let isUpdated = false;

    // 遍历所需的Cookie名称
    COOKIE_NAMES.forEach(name => {
        const match = setCookie.match(new RegExp(`${AUTH_PREFIX}${name}=([^;]+)`));
        if (match) {
            cookieObj[name] = match[1];
            isUpdated = true;
        }
    });

    if (!isUpdated) return $done();

    const oldCookieStr = $.store.read(COOKIE_KEY);
    const oldCookieObj = oldCookieStr ? JSON.parse(oldCookieStr) : {};
    const newCookieObj = { ...oldCookieObj, ...cookieObj };
    
    if (JSON.stringify(oldCookieObj) === JSON.stringify(newCookieObj)) {
        $.msg(NAME, '📢 Cookie未变化', '');
    } else if ($.store.write(JSON.stringify(newCookieObj), COOKIE_KEY)) {
        $.msg(NAME, '✅ Cookie获取成功', '');
    } else {
        $.msg(NAME, '❌ Cookie获取失败', '存储错误');
    }
    
    $done();
};

// 入口函数
(() => typeof $request !== 'undefined' && $request.method === 'GET' ? getCookie() : sign())();
