const fs = require('fs');
const content = fs.readFileSync('src/modules/game-runtime/engines/MiniGameController.ts', 'utf8');
// 找到 "prepare" 的位置
const idx = content.indexOf('normalizePhase(session.phase, "prepare")');
console.log('prepare context bytes:');
const slice = content.slice(idx - 50, idx + 100);
for (let i = 0; i < slice.length; i++) {
  const char = slice[i];
  const code = char.charCodeAt(0);
  if (code > 127 || char === '"') {
    console.log(i, char, 'U+' + code.toString(16).toUpperCase().padStart(4, '0'));
  }
}
