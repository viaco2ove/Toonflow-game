const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Fix lines 5268-5277 (0-indexed: 5267-5276)
const fixes = [
  [5267, '  if (rulebook.gameType === "fishing") {'],
  [5268, '    const mentor = scalarText(publicState.mentor) || "未选择";'],
  [5269, ''], // blank line, no fix needed
  [5270, ''], // blank line
  [5271, '      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}。陪练：${mentor}。`,'],
  [5272, '      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",'],
  [5273, '      reward ? `最近收获：${reward}。` : "",'],
  [5274, '      "可直接输入\'抛竿\'\'收杆\'或\'继续钓鱼\'。",'],
  [5275, '    ].filter(Boolean).join("");'],
];

for (const [idx, newLine] of fixes) {
  if (newLine && lines[idx] !== newLine) {
    console.log('Fixing line', idx + 1);
    console.log('  Before:', JSON.stringify(lines[idx]));
    console.log('  After:', JSON.stringify(newLine));
    lines[idx] = newLine;
  }
}

content = lines.join('\n');
fs.writeFileSync(path, content, 'utf8');
console.log('Done');