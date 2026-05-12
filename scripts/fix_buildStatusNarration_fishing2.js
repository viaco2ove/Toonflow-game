const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// Fix lines 5268-5277 (0-indexed: 5267-5276)
// These lines have Chinese curly quotes

// Replace the fishing status section
const oldPattern = `  if (rulebook.gameType === "fishing") {
    const mentor = scalarText(publicState.mentor) || "未选择";
    const reward = scalarText(publicState.last_reward);
    return [
      \`钓鱼状态：\${scalarText(publicState.current_status) || "准备抛竿"}。陪练：\${mentor}。\`,
      scalarText(publicState.last_result) ? \`本轮结果：\${scalarText(publicState.last_result)}。\` : "",
      reward ? \`最近收获：\${reward}。\` : "",
      "可直接输入"抛竿""收杆"或"继续钓鱼"。",
    ].filter(Boolean).join("");
  }`;

const newPattern = `  if (rulebook.gameType === "fishing") {
    const mentor = scalarText(publicState.mentor) || "未选择";
    const reward = scalarText(publicState.last_reward);
    return [
      \`钓鱼状态：\${scalarText(publicState.current_status) || "准备抛竿"}。陪练：\${mentor}。\`,
      scalarText(publicState.last_result) ? \`本轮结果：\${scalarText(publicState.last_result)}。\` : "",
      reward ? \`最近收获：\${reward}。\` : "",
      "可直接输入'抛竿''收杆'或'继续钓鱼'。",
    ].filter(Boolean).join("");
  }`;

if (content.includes(oldPattern)) {
  content = content.replace(oldPattern, newPattern);
  fs.writeFileSync(path, content, 'utf8');
  console.log('Fixed with simple replace');
} else {
  console.log('Pattern not found, trying line-by-line');
  const lines = content.split('\n');
  // Lines 5268-5277 (0-indexed: 5267-5276)
  // Let's fix each line that has curly quotes
  for (let i = 5267; i <= 5276 && i < lines.length; i++) {
    if (lines[i].includes('"') || lines[i].includes('"')) {
      console.log('Line', i + 1, 'has curly quotes:', JSON.stringify(lines[i]));
      // Replace curly quotes with straight quotes
      lines[i] = lines[i].replace(/"/g, '"').replace(/"/g, '"');
      console.log('Fixed to:', JSON.stringify(lines[i]));
    }
  }
  content = lines.join('\n');
  fs.writeFileSync(path, content, 'utf8');
  console.log('Done line-by-line fix');
}