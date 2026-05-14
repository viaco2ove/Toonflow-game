const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Find and fix the buildStatusNarration fishing section
// Problem: Chinese curly quotes (U+201C/U+201D) instead of ASCII quotes
const fishingStatusStart = 'if (rulebook.gameType === "fishing") {';
const fishingStatusEnd = '  if (rulebook.gameType === "cultivation") {';

let startIdx = -1;
let endIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(fishingStatusStart)) startIdx = i;
  if (startIdx > 0 && lines[i].includes(fishingStatusEnd)) {
    endIdx = i;
    break;
  }
}

if (startIdx > 0 && endIdx > startIdx) {
  console.log('Found fishing status section at lines', startIdx + 1, 'to', endIdx + 1);

  // Replace lines startIdx to endIdx-1 with correct version
  const correctSection = `  if (rulebook.gameType === "fishing") {
    const mentor = scalarText(publicState.mentor) || "未选择";
    const reward = scalarText(publicState.last_reward);
    return [
      \`钓鱼状态：\${scalarText(publicState.current_status) || "准备抛竿"}。陪练：\${mentor}。\`,
      scalarText(publicState.last_result) ? \`本轮结果：\${scalarText(publicState.last_result)}。\` : "",
      reward ? \`最近收获：\${reward}。\` : "",
      "可直接输入"抛竿""收杆"或"继续钓鱼"。",
    ].filter(Boolean).join("");
  }`;

  // Check for curly quotes in the section
  const sectionContent = lines.slice(startIdx, endIdx).join('\n');
  if (sectionContent.includes('“') || sectionContent.includes('”')) {
    console.log('Found curly quotes, fixing...');
    lines.splice(startIdx, endIdx - startIdx, correctSection);
    content = lines.join('\n');
    fs.writeFileSync(path, content, 'utf8');
    console.log('Fixed');
  } else {
    console.log('No curly quotes found');
  }
} else {
  console.log('Could not find fishing status section');
}