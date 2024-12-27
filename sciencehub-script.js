const $ = new Env('科研通助手');

// 脚本配置
const config = {
    baseUrl: 'https://www.ablesci.com',
    cookieKey: 'scienceHubCookie',
    tokenKey: 'scienceHubToken'
};

// Cookie和Token获取函数
const getCookie = async () => {
    try {
        const headers = $request.headers;
        let changed = false;
        
        // 获取Cookie
        if (headers.Cookie) {
            if ($.setdata(headers.Cookie, config.cookieKey)) {
                $.log('Cookie保存成功');
                changed = true;
            }
        }
        
        // 获取Token
        if (headers.Authorization) {
            const token = headers.Authorization.replace('Bearer ', '');
            if ($.setdata(token, config.tokenKey)) {
                $.log('Token保存成功');
                changed = true;
            }
        }
        
        if (changed) {
            $.msg($.name, '获取成功 🎉', 'Cookie和Token已更新');
        }
    } catch (e) {
        $.log('获取Cookie和Token失败：' + e.message);
        $.msg($.name, '获取失败 ❌', e.message);
    } finally {
        $.done();
    }
};

// 签到函数
const checkin = async () => {
    try {
        // 获取存储的Cookie和Token
        const cookie = $.getdata(config.cookieKey);
        const token = $.getdata(config.tokenKey);
        
        if (!cookie || !token) {
            throw new Error('请先获取Cookie和Token');
        }

        // 签到请求配置
        const options = {
            url: `${config.baseUrl}/user/checkin`,
            headers: {
                'Cookie': cookie,
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
                'Content-Type': 'application/json'
            }
        };

        // 发送签到请求
        const result = await $.http.post(options);
        const response = JSON.parse(result.body);

        // 处理响应结果
        if (response.code === 0) {
            const msg = `签到成功，获得${response.data.points}积分`;
            $.log(msg);
            $.msg($.name, '签到成功 ✅', msg);
        } else {
            throw new Error(response.message || '未知错误');
        }
    } catch (e) {
        $.log('签到失败：' + e.message);
        $.msg($.name, '签到失败 ❌', e.message);
    } finally {
        $.done();
    }
};

// 脚本入口
const start = async () => {
    // 根据请求类型判断执行操作
    if ($request && $request.method === 'GET') {
        await getCookie();
    } else {
        await checkin();
    }
};

// Env函数实现
function Env(name) {
    this.name = name;
    this.data = {};
    
    // 日志函数
    this.log = (msg) => console.log(msg);
    
    // 通知函数
    this.msg = (title, subtitle, body) => {
        $notification.post(title, subtitle, body);
    };
    
    // 数据存储
    this.setdata = (val, key) => {
        try {
            $persistentStore.write(val, key);
            return true;
        } catch (e) {
            this.log(e);
            return false;
        }
    };
    
    // 数据读取
    this.getdata = (key) => {
        try {
            return $persistentStore.read(key);
        } catch (e) {
            this.log(e);
            return null;
        }
    };
    
    // HTTP请求
    this.http = {
        post: async (options) => {
            try {
                return await $httpClient.post(options);
            } catch (error) {
                throw error;
            }
        }
    };
    
    this.done = () => $done({});
}

// 执行脚本
start().catch(e => {
    $.log('脚本执行错误：' + e.message);
    $.msg($.name, '执行错误 ❌', e.message);
});