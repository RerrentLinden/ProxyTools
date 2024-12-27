/*
科研通每日签到脚本 - Surge专用版

脚本说明：
1. 用于科研通(ablesci.com)的每日自动签到
2. 支持自动获取Cookie和定时签到功能
3. 签到结果通过通知反馈

致谢：
1. 原始代码作者：@imoki (https://github.com/imoki)
2. 原仓库地址：https://github.com/imoki/sign_script
3. Claude AI 提供优化建议和代码重构

更新说明：基于原作者代码重构，优化性能和资源利用
更新时间：2024-12-27
脚本作者：@RerrentLinden

脚本遵循开源协议，转载请注明出处
*/

const NAME = '科研通';
const SIGN_URL = 'https://www.ablesci.com/user/sign';
const COOKIE_KEY = 'sciencehubCookie';
const COOKIE_NAME = '_identity-frontend';
const TIMEOUT = 5000;

const $ = {
    name: NAME,
    // 精简通知函数
    msg: (title, subtitle = '', body = '') => $notification.post(title, subtitle, body),
    // 优化存储操作
    store: {
        read: (key) => $persistentStore.read(key),
        write: (val, key) => $persistentStore.write(val, key)
    }
};

// 优化的请求头生成函数
const getHeaders = (cookie) => ({
    'Cookie': `${COOKIE_NAME}=${cookie}`,
    'Accept': 'application/json, */*',
    'Accept-Language': 'zh-CN,zh',
    'Referer': 'https://www.ablesci.com/',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
});

// 签到函数优化
const sign = () => {
    const cookie = $.store.read(COOKIE_KEY);
    if (!cookie) {
        $.msg(NAME, '❌ 签到失败', '请先获取Cookie');
        return $done();
    }

    $httpClient.get({
        url: SIGN_URL,
        headers: getHeaders(cookie),
        timeout: TIMEOUT
    }, (error, response, data) => {
        let subtitle = '', body = '';
        
        try {
            if (error) throw new Error('网络请求异常');
            
            const result = JSON.parse(data);
            switch (result.code) {
                case 0:
                    const {signpoint: points = 0, signcount: count = 0} = result.data || {};
                    subtitle = '🎉 签到成功';
                    body = `获得${points}积分，已连续签到${count}天`;
                    break;
                case 1:
                    subtitle = '📢 重复签到';
                    body = result.msg || '今日已签到';
                    break;
                default:
                    throw new Error(result.msg || '签到失败');
            }
        } catch (e) {
            subtitle = '❌ 签到失败';
            body = e.message || '未知错误';
        }
        
        $.msg(NAME, subtitle, body);
        $done();
    });
};

// Cookie获取函数优化
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

// 优化的入口函数
(() => typeof $request !== 'undefined' && $request.method === 'GET' ? getCookie() : sign())();
