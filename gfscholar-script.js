/*
谷粉学术每日签到脚本 - Surge专用版

脚本说明：
1. 用于谷粉学术(bbs.yuyingufen.com)的每日自动签到
2. 支持自动获取Cookie和定时签到功能
3. 签到结果通过通知反馈

更新说明：基于实际Cookie结构优化
更新时间：2025-01-09
脚本作者：@RerrentLinden
*/

// 基础配置
const NAME = '谷粉学术';
const SIGN_URL = 'https://bbs.yuyingufen.com/daily/sign';
const COOKIE_KEY = 'gfscholarCookie';
const TIMEOUT = 5000;

// 工具函数封装
const $ = {
    name: NAME,
    msg: (title, subtitle = '', body = '') => $notification.post(title, subtitle, body),
    store: {
        read: (key) => $persistentStore.read(key),
        write: (val, key) => $persistentStore.write(val, key)
    }
};

// 生成请求头
const getHeaders = (cookie) => ({
    'Cookie': cookie,  // 直接使用完整的Cookie字符串
    'Accept': 'application/json, */*',
    'Accept-Language': 'zh-CN,zh',
    'Referer': 'https://bbs.yuyingufen.com/',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
});

// 签到函数
const sign = () => {
    const cookie = $.store.read(COOKIE_KEY);
    if (!cookie) {
        $.msg(NAME, '❌ 签到失败', '请先获取Cookie');
        return $done();
    }

    $httpClient.post({
        url: SIGN_URL,
        headers: getHeaders(cookie),
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
                subtitle = '❌ 签到失败';
                body = result.message || '未知错误';
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

    // 直接获取请求中的完整Cookie
    const cookieStr = $request.headers['Cookie'] || $request.headers['cookie'];
    if (!cookieStr) {
        $.msg(NAME, '❌ Cookie获取失败', '请求中未包含Cookie');
        return $done();
    }

    // 验证Cookie中是否包含必要的7BsM_2132前缀
    if (!cookieStr.includes('7BsM_2132')) {
        $.msg(NAME, '❌ Cookie获取失败', '未找到有效的Cookie');
        return $done();
    }

    const oldCookie = $.store.read(COOKIE_KEY);
    if (oldCookie === cookieStr) {
        $.msg(NAME, '📢 Cookie未变化', '');
    } else if ($.store.write(cookieStr, COOKIE_KEY)) {
        $.msg(NAME, '✅ Cookie获取成功', '');
    } else {
        $.msg(NAME, '❌ Cookie获取失败', '存储失败');
    }
    
    $done();
};

// 入口函数
(() => typeof $request !== 'undefined' && $request.method === 'GET' ? getCookie() : sign())();
