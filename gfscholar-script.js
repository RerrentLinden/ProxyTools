/*
谷粉学术每日签到脚本 - Surge iOS专用版

脚本说明：
1. 用于谷粉学术(bbs.yuyingufen.com)的每日自动签到
2. 支持在 iOS 设备上通过 Surge 自动获取Cookie
3. 签到结果通过通知反馈

更新说明：优化 iOS 环境下的 Cookie 获取
更新时间：2025-01-09
脚本作者：@RerrentLinden
*/

// 基础配置
const NAME = '谷粉学术';
const SIGN_URL = 'https://bbs.yuyingufen.com/daily/sign';
const COOKIE_KEY = 'gfscholarCookie';
const TIMEOUT = 5000;

// 需要获取的关键 Cookie
const REQUIRED_COOKIES = ['auth', 'saltkey'];

// 工具函数封装
const $ = {
    name: NAME,
    msg: (title, subtitle = '', body = '') => $notification.post(title, subtitle, body),
    store: {
        read: (key) => {
            try {
                const data = $persistentStore.read(key);
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
    },
    // 用于解析 Cookie 字符串
    parseCookies: (cookieStr) => {
        const cookies = {};
        if (!cookieStr) return cookies;
        
        cookieStr.split(/;\s*/).forEach(pair => {
            const [key, value] = pair.split('=');
            if (key && value) {
                cookies[key.trim()] = value.trim();
            }
        });
        return cookies;
    }
};

// 生成请求头
const getHeaders = (cookies) => {
    const cookieString = Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
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
            } else if (result.code === 1) {
                subtitle = '📢 重复签到';
                body = '今日已签到';
            } else {
                throw new Error(result.message || '签到失败');
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
    if (!$request || !$request.headers) {
        $.msg(NAME, '❌ Cookie获取失败', '请求数据不完整');
        return $done();
    }

    // 获取响应头中的 Set-Cookie
    const setCookie = $response.headers['Set-Cookie'] || $response.headers['set-cookie'];
    // 同时获取请求头中的 Cookie
    const reqCookie = $request.headers['Cookie'] || $request.headers['cookie'];

    // 合并所有 Cookie
    const allCookies = $.parseCookies(setCookie + ';' + reqCookie);
    
    // 检查是否包含必要的 Cookie
    const cookies = {};
    let foundRequired = false;
    
    // 遍历所有 cookie，找出包含 7BsM_2132 前缀的
    Object.entries(allCookies).forEach(([key, value]) => {
        if (key.startsWith('7BsM_2132_')) {
            const shortKey = key.replace('7BsM_2132_', '');
            cookies[key] = value;
            if (REQUIRED_COOKIES.includes(shortKey)) {
                foundRequired = true;
            }
        }
    });

    if (!foundRequired) {
        // console.log('获取到的 Cookies:', JSON.stringify(cookies));  // 调试用
        return $done();
    }

    const oldCookies = $.store.read(COOKIE_KEY);
    if (oldCookies && JSON.stringify(oldCookies) === JSON.stringify(cookies)) {
        $.msg(NAME, '📢 Cookie未变化', '');
    } else if ($.store.write(cookies, COOKIE_KEY)) {
        $.msg(NAME, '✅ Cookie获取成功', `获取到 ${Object.keys(cookies).length} 个Cookie`);
    } else {
        $.msg(NAME, '❌ Cookie获取失败', '存储失败');
    }
    
    $done();
};

// 入口函数
(() => typeof $request !== 'undefined' && $request.method === 'GET' ? getCookie() : sign())();
