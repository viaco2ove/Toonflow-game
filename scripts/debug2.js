const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
const content = fs.readFileSync(path, 'utf8');

// 检查 memorySummary: `钓鱼成功
const idx = content.indexOf('memorySummary: `钓鱼成功');
console.log('Found memorySummary:', idx > 0);
if (idx > 0) {
  const slice = content.slice(idx, idx + 200);
  console.log('Context:', JSON.stringify(slice));
}

// 检查 ruleSummary
const idx2 = content.indexOf('ruleSummary: "直接输入');
console.log('Found ruleSummary:', idx2 > 0);
if (idx2 > 0) {
  const slice2 = content.slice(idx2, idx2 + 100);
  console.log('Context:', JSON.stringify(slice2));
}

// 检查 fishing buildStartNarration
const idx3 = content.indexOf('return `你来到 ${scalarText');
console.log('Found buildStartNarration:', idx3 > 0);
if (idx3 > 0) {
  const slice3 = content.slice(idx3, idx3 + 200);
  console.log('Context:', JSON.stringify(slice3));
}
