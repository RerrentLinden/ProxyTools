/*
科研通每日签到脚本 - Surge专用版
更新说明：优化Cookie获取逻辑，现在会自动获取登录后的_identity-frontend Cookie
更新时间：2024-12-27
*/

const $ = new Env('科研通');
const signUrl = "https://www.ablesci.com/user/sign";
const cookieKey = 'sciencehubCookie';
const cookieName = '_identity-frontend';

function sign() {
    const cookie = $.getdata(cookieKey);
    if (!cookie) {
        $.msg($.name, '❌ 签到失败', '请先登录获取Cookie');
        $.done();
        return;
    }

    const headers = {
        'Cookie': cookie,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'keep-alive',
        'Referer': 'https://www.ablesci.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    };

    $httpClient.get({
        url: signUrl,
        headers: headers
    }, (error, response, data) => {
        if (error) {
            $.msg($.name, '❌ 签到失败', '网络请求异常');
            $.done();
            return;
        }

        try {
            const result = JSON.parse(data);
            if (result.code === 0) {
                const points = result.data.signpoint || 0;
                const count = result.data.signcount || 0;
                const msg = `获得${points}积分，已连续签到${count}天`;
                $.msg($.name, '🎉 签到成功', msg);
            } else if (result.code === 1) {
                $.msg($.name, '📢 重复签到', result.msg || '今日已签到');
            } else {
                $.msg($.name, '❌ 签到失败', result.msg || '未知错误');
            }
        } catch (e) {
            $.msg($.name, '❌ 签到失败', '数据解析异常');
        }
        $.done();
    });
}

// Cookie获取函数
function getCookie() {
    let cookies = $request.headers['Cookie'] || $request.headers['cookie'] || '';
    if (!cookies) {
        cookies = ($response.headers['Set-Cookie'] || $response.headers['set-cookie'] || []).join(';');
    }
    
    // 提取_identity-frontend Cookie
    const matchCookie = cookies.match(new RegExp(`${cookieName}=[^;]+`));
    if (matchCookie) {
        const newCookie = matchCookie[0];
        const oldCookie = $.getdata(cookieKey);
        if (oldCookie !== newCookie) {
            if ($.setdata(newCookie, cookieKey)) {
                $.msg($.name, '✅ Cookie获取/更新成功', '');
            } else {
                $.msg($.name, '❌ Cookie获取失败', '存储异常');
            }
        } else {
            $.msg($.name, '📢 Cookie未变化', 'Cookie和已保存的相同，无需更新');
        }
    }
    $.done();
}

// Surge环境函数
function Env(t) {
    this.name = t;
    this.logs = [];
    this.isSurge = () => true;
    
    this.msg = (title, subtitle = '', body = '') => {
        $notification.post(title, subtitle, body);
    };
    
    this.log = (msg) => {
        this.logs.push(msg);
        console.log(msg);
    };
    
    this.setdata = (val, key) => {
        try {
            return $persistentStore.write(val, key);
        } catch (e) {
            console.log(e);
            return false;
        }
    };
    
    this.getdata = (key) => {
        try {
            return $persistentStore.read(key);
        } catch (e) {
            console.log(e);
            return null;
        }
    };
    
    this.done = (val = {}) => $done(val);
}

// 脚本入口
!(async () => {
    if ($request && $request.method === 'POST') {
        getCookie();
    } else {
        sign();
    }
})();
