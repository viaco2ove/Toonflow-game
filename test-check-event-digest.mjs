import fetch from 'node-fetch';

const loginRes = await fetch('http://127.0.0.1:60002/other/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
});
const loginData = await loginRes.json();
const token = loginData.data.token;

const initRes = await fetch('http://127.0.0.1:60002/game/initDebug', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': token
  },
  body: JSON.stringify({ worldId: 2 })
});
const initData = await initRes.json();

console.log('\n=== 事件摘要字段检查 ===\n');
if (initData.data && initData.data.state) {
  const state = initData.data.state;
  console.log('currentEventDigest:', JSON.stringify(state.currentEventDigest, null, 2));
  console.log('\neventDigestWindow:', JSON.stringify(state.eventDigestWindow, null, 2));
  console.log('\neventDigestWindowText:', state.eventDigestWindowText);
  console.log('\nchapterProgress:', JSON.stringify(state.chapterProgress, null, 2));
} else {
  console.log('错误:', initData);
}
