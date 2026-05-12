const fs = require('fs');
const content = fs.readFileSync('src/modules/game-runtime/engines/MiniGameController.ts', 'utf8');
// 检查换行符
console.log('Has CRLF:', content.includes('\r\n'));
console.log('Has LF only:', content.includes('\n'));

// 找到 fishingOptions
const idx = content.indexOf('function fishingOptions');
// 提取该函数的前几行
const slice = content.slice(idx, idx + 500);
// 检查 slice 的内容
console.log('First 200 chars:', JSON.stringify(slice.slice(0, 200)));
