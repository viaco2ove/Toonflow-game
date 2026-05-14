const fs = require('fs');
const content = fs.readFileSync('src/modules/game-runtime/engines/MiniGameController.ts', 'utf8');
// 检查是否是中文引号
const leftQuote = '“';
const rightQuote = '”';
console.log('Contains Chinese left quote:', content.includes(leftQuote));
console.log('Contains Chinese right quote:', content.includes(rightQuote));
// 检查 fishingOptions 前的函数声明
const idx = content.indexOf('function fishingOptions');
console.log('fishingOptions context:', JSON.stringify(content.slice(idx, idx+300)));
