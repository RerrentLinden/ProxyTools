/*
谷粉学术每日签到脚本 - Surge专用版

脚本说明：
1. 用于谷粉学术(bbs.yuyingufen.com)的每日自动签到
2. 支持自动获取Cookie和定时签到功能
3. 签到结果通过通知反馈

更新时间：2025-01-09
脚本作者：@RerrentLinden
*/

// 基础配置
const NAME = '谷粉学术';
const SIGN_URL = 'https://bbs.yuyingufen.com/daily/sign';
const COOKIE_KEY = 'gfscholarCookies';  // 改为复数，因为要存储多个Cookie
const COOKIE_PREFIX = '7BsM_2132';  // Cookie前缀
const TIMEOUT = 5000;

// 需要获取的Cookie列表
const REQUIRED_COOKIES = [
    'auth',
    'saltkey',
    'sid',
    'ulastactivity'
];

// 工具函数封装
const $ = {
    name: NAME,
    msg: (title, subtitle = '', body = '') => $notification.post(title, subtitle, body),
    store: {
        read: (key) => {
            const data = $persistentStore.read(key);
            try {
                return data ? JSON.parse(data) : null;
            } catch (e) {
                return null;
            }
        },
        write: (val, key) => {
            try {
                return $persistentStore.write(JSON.stringify(val), key);
            } catch (e) {
                return false;
            }
        }
    }
};

// 生成请求头
const getHeaders = (cookies) => {
    const cookieString = Object.entries(cookies)
        .map(([key, value]) => `${COOKIE_PREFIX}_${key}=${value}`)
        .join('; ');

    return {
        'Cookie': cookieString,
        'Accept': 'application/json, */*',
        'Accept-Language': 'zh-CN,zh',
        'Referer': 'https://bbs.yuyingufen.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
    };
};

// 签到函数
const sign = () => {
    const cookies = $.store.read(COOKIE_KEY);
    if (!cookies) {
        $.msg(NAME, '❌ 签到失败', '请先获取Cookie');
        return $done();
    }

    $httpClient.post({
        url: SIGN_URL,
        headers: getHeaders(cookies),
        timeout: TIMEOUT
    }, (error, response, data) => {
        let subtitle = '', body = '';
        
        try {
            if (error) throw new Error('网络请求异常');
            
            const result = JSON.parse(data);
            if (result.success) {
                subtitle = '🎉 签到成功';
                body = result.message || '签到完成';
            } else {
                subtitle = '📢 签到失败';
                body = result.message || '可能已经签到过了';
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

    // 解析所有Cookie
    const cookies = {};
    let cookiesUpdated = false;

    REQUIRED_COOKIES.forEach(cookieName => {
        const pattern = new RegExp(`${COOKIE_PREFIX}_${cookieName}=([^;]+)`);
        const match = setCookie.match(pattern);
        if (match) {
            cookies[cookieName] = match[1];
            cookiesUpdated = true;
        }
    });

    if (!cookiesUpdated) {
        return $done();
    }

    const oldCookies = $.store.read(COOKIE_KEY) || {};
    const hasChanges = REQUIRED_COOKIES.some(
        name => cookies[name] && cookies[name] !== oldCookies[name]
    );

    if (!hasChanges) {
        $.msg(NAME, '📢 Cookie未变化', '');
    } else if ($.store.write(cookies, COOKIE_KEY)) {
        $.msg(NAME, '✅ Cookie获取成功', `成功获取 ${Object.keys(cookies).length} 个Cookie`);
    } else {
        $.msg(NAME, '❌ Cookie获取失败', '存储错误');
    }
    
    $done();
};

// 入口函数
(() => typeof $request !== 'undefined' && $request.method === 'GET' ? getCookie() : sign())();
