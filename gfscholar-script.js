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
const SIGN_URL = 'https://bbs.yuyingufen.com/daily/sign';  // 签到接口
const COOKIE_KEY = 'gfscholarCookie';  // 存储Cookie的键名
const COOKIE_NAME = '7BsM_2132';  // Cookie名称，根据截图显示的实际Cookie名
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
const getHeaders = (cookie) => ({
    'Cookie': `${COOKIE_NAME}=${cookie}`,
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
            // 根据实际接口返回进行判断
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

    const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (!match) return $done();

    const newCookie = match[1];
    const oldCookie = $.store.read(COOKIE_KEY);
    
    if (newCookie === oldCookie) {
        $.msg(NAME, '📢 Cookie未变化', '');
    } else if ($.store.write(newCookie, COOKIE_KEY)) {
        $.msg(NAME, '✅ Cookie获取成功', '');
    } else {
        $.msg(NAME, '❌ Cookie获取失败', '存储错误');
    }
    
    $done();
};

// 入口函数
(() => typeof $request !== 'undefined' && $request.method === 'GET' ? getCookie() : sign())();
