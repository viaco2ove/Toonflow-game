const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 60002,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  try {
    const loginData = await post('/other/login', { username: 'admin', password: 'admin123' });
    const token = loginData.data.token;
    
    console.log('测试 initDebug 响应时间...');
    const start = Date.now();
    const initData = await post('/game/initDebug', { worldId: 2 });
    const elapsed = Date.now() - start;
    
    console.log('响应时间:', elapsed, 'ms');
    console.log('返回字段:', Object.keys(initData.data || {}).join(', '));
    console.log('是否有 opening:', 'opening' in (initData.data || {}));
    console.log('是否有 firstChapter:', 'firstChapter' in (initData.data || {}));
    
    console.log('\n测试 introduction...');
    const introStart = Date.now();
    const introData = await post('/game/introduction', { 
      worldId: 2,
      state: initData.data.state 
    });
    const introElapsed = Date.now() - introStart;
    
    console.log('introduction 响应时间:', introElapsed, 'ms');
    console.log('是否有 plan:', 'plan' in (introData.data || {}));
    if (introData.data && introData.data.plan) {
      console.log('plan.eventType:', introData.data.plan.eventType);
      console.log('plan.presetContent 长度:', (introData.data.plan.presetContent || '').length);
    }
  } catch (e) {
    console.error('错误:', e.message);
  }
})();
