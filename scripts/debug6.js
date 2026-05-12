const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
const content = fs.readFileSync(path, 'utf8');

// 找第二个位置 ("直接输入动作，例如")
const idx = content.indexOf('直接输入动作，例如');
if (idx > 0) {
  console.log('Found at idx:', idx);
  // 检查后面60个字符的字节
  const slice = content.slice(idx, idx + 60);
  console.log('Slice:', slice);
  for (let i = 0; i < slice.length; i++) {
    const code = slice.charCodeAt(i);
    if (code > 127 || code === 34 || code === 8216 || code === 8217) {
      const char = slice[i];
      const hex = code.toString(16).toUpperCase();
      console.log(i, `'${char}'`, code, 'U+' + hex);
    }
  }
}
