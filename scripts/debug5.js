const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
const content = fs.readFileSync(path, 'utf8');

// 搜索 "抛竿" 出现的位置
let idx = 0;
let count = 0;
while ((idx = content.indexOf('抛竿', idx)) !== -1) {
  count++;
  const slice = content.slice(Math.max(0, idx - 10), idx + 20);
  console.log(`Found #${count} at ${idx}: ...${slice}...`);
  if (count >= 5) break;
  idx++;
}
