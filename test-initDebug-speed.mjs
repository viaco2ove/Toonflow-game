import fetch from 'node-fetch';

(async () => {
  try {
    const loginRes = await fetch('http://127.0.0.1:60002/other/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const loginData = await loginRes.json();
    const token = loginData.data.token;
    
    console.log('测试 initDebug 响应时间...');
    const start = Date.now();
    const initRes = await fetch('http://127.0.0.1:60002/game/initDebug', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({ worldId: 2 })
    });
    const elapsed = Date.now() - start;
    const initData = await initRes.json();
    
    console.log('响应时间:', elapsed, 'ms');
    console.log('返回字段:', Object.keys(initData.data || {}).join(', '));
    console.log('是否有 opening:', 'opening' in (initData.data || {}));
    console.log('是否有 firstChapter:', 'firstChapter' in (initData.data || {}));
    
    // 测试 introduction
    console.log('\n测试 introduction...');
    const introStart = Date.now();
    const introRes = await fetch('http://127.0.0.1:60002/game/introduction', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({ 
        worldId: 2,
        state: initData.data.state 
      })
    });
    const introElapsed = Date.now() - introStart;
    const introData = await introRes.json();
    
    console.log('introduction 响应时间:', introElapsed, 'ms');
    console.log('是否有 plan:', 'plan' in (introData.data || {}));
    if (introData.data?.plan) {
      console.log('plan.eventType:', introData.data.plan.eventType);
      console.log('plan.presetContent 长度:', (introData.data.plan.presetContent || '').length);
    }
  } catch (e) {
    console.error('错误:', e.message);
  }
})();
