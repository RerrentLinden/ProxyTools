/*
科研通每日签到脚本 - Surge专用版
说明：
1. Cookie获取: 打开www.ablesci.com，进入个人中心页面自动获取Cookie
2. 重写规则: ^https:\/\/www\.ablesci\.com\/user\/signin$
3. 获取成功后可以禁用Cookie获取脚本
4. 支持自定义签到时间
更新时间：2024-12-27
*/

const $ = new Env('科研通');
const signUrl = "https://www.ablesci.com/user/sign";  // 签到接口
const signinUrl = "https://www.ablesci.com/user/signin";  // 登录接口，用于获取Cookie
const cookieKey = 'sciencehubCookie';

function sign() {
    const cookie = $.getdata(cookieKey);
    if (!cookie) {
        $.msg($.name, '❌ 签到失败', '请先获取Cookie：打开科研通网站，进入个人中心页面');
        $.done();
        return;
    }

    const headers = {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'keep-alive',
        'Referer': 'https://www.ablesci.com'
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
    const cookie = $request.headers['Cookie'] || $request.headers['cookie'];
    if (cookie) {
        const oldCookie = $.getdata(cookieKey);
        if (oldCookie !== cookie) {
            if ($.setdata(cookie, cookieKey)) {
                $.msg($.name, '✅ Cookie获取/更新成功', '');
            } else {
                $.msg($.name, '❌ Cookie获取失败', '请重试或手动抓包获取');
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
    if ($request && $request.method === 'GET') {
        getCookie();
    } else {
        sign();
    }
})();
