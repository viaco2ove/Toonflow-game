const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
const content = fs.readFileSync(path, 'utf8');

// 找 "抛竿" 的位置
const idx = content.indexOf('直接输入"抛竿"');
if (idx > 0) {
  // 检查该位置前后的字符
  const slice = content.slice(idx - 20, idx + 50);
  console.log('Slice:', slice);
  console.log('Bytes:');
  for (let i = 0; i < slice.length; i++) {
    const code = slice.charCodeAt(i);
    if (code > 127 || code === 34) {
      process.stdout.write(`${i}: '${slice[i]}' = U+${code.toString(16).toUpperCase().padStart(4, '0')} `);
    }
  }
  console.log('');
}

// 直接检查 "抛竿" 之前的字符是否是中文引号
const testStr = '直接输入"抛竿"';
const testIdx = content.indexOf(testStr);
console.log('\nTest string found:', testIdx > 0);
if (testIdx > 0) {
  // 检查第14个字符 (应该是第一个 ")
  const charBefore = content[testIdx + 4]; // 位置在 "抛竿" 前的引号
  console.log('Char before 抛竿:', charBefore, '=', 'U+' + charBefore.charCodeAt(0).toString(16).toUpperCase());
}
