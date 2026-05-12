const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// 目标字符串 - 精确匹配文件中的内容
const oldStr = 'ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",\n    setup: (ctx, sessionId, entrySource) => {';

console.log('Searching for target...');
console.log('Target bytes:', JSON.stringify(oldStr));

const idx = content.indexOf(oldStr);
console.log('Found at index:', idx);

if (idx > 0) {
  const newStr = 'ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",\n    rulebookNarration: "钓鱼narration占位",\n    setup: (ctx, sessionId, entrySource) => {';

  content = content.replace(oldStr, newStr);
  fs.writeFileSync(path, content, 'utf8');
  console.log('Replacement done');
} else {
  console.log('Target not found');
  // 尝试找到部分匹配
  const partial = 'ruleSummary: "直接输入';
  const pIdx = content.indexOf(partial);
  if (pIdx > 0) {
    console.log('Partial match at:', pIdx);
    console.log('Context:', JSON.stringify(content.slice(pIdx, pIdx + 250)));
  }
}