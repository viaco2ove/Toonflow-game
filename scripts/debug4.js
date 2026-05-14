const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
const content = fs.readFileSync(path, 'utf8');

// 找到 "直接输入" 的位置
const idx = content.indexOf('直接输入');
if (idx > 0) {
  console.log('Found at idx:', idx);
  // 检查后面30个字符的字节
  const slice = content.slice(idx, idx + 30);
  console.log('Slice:', slice);
  for (let i = 0; i < slice.length; i++) {
    const code = slice.charCodeAt(i);
    console.log(i, slice[i], '=', code, 'U+' + code.toString(16));
  }
}
