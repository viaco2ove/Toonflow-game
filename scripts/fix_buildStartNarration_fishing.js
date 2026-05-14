const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Line 5126 (0-indexed 5125) has Chinese curly quotes around "fishing"
// Replace it with correct ASCII quotes
const lineIdx = 5125; // 0-indexed

// Check if this line has the problem
if (lines[lineIdx].includes('“') || lines[lineIdx].includes('”')) {
  console.log('Found problem line:', JSON.stringify(lines[lineIdx]));
  // Replace the entire line with correct version
  lines[lineIdx] = '  if (rulebook.gameType === "fishing") {';
  console.log('Fixed to:', JSON.stringify(lines[lineIdx]));
}

// Also check line 5127 (mentors join)
if (lines[lineIdx + 1].includes('“') || lines[lineIdx + 1].includes('”')) {
  console.log('Found problem line 5127:', JSON.stringify(lines[lineIdx + 1]));
  lines[lineIdx + 1] = '    const mentors = asArray<string>(publicState.available_mentors).join("、");';
  console.log('Fixed to:', JSON.stringify(lines[lineIdx + 1]));
}

// Check line 5129
if (lines[lineIdx + 3].includes('“') || lines[lineIdx + 3].includes('”')) {
  console.log('Found problem line 5129:', JSON.stringify(lines[lineIdx + 3]));
  lines[lineIdx + 3] = '      "钓鱼开始了。你想独自垂钓还是需要陪练协助？",';
  console.log('Fixed to:', JSON.stringify(lines[lineIdx + 3]));
}

// Check line 5130
if (lines[lineIdx + 4].includes('“') || lines[lineIdx + 4].includes('”')) {
  console.log('Found problem line 5130:', JSON.stringify(lines[lineIdx + 4]));
  lines[lineIdx + 4] = '      mentors ? `可选陪练：${mentors}。` : "当前没有可选陪练，也可以独自钓鱼。",';
  console.log('Fixed to:', JSON.stringify(lines[lineIdx + 4]));
}

// Check line 5131
if (lines[lineIdx + 5].includes('“') || lines[lineIdx + 5].includes('”')) {
  console.log('Found problem line 5131:', JSON.stringify(lines[lineIdx + 5]));
  lines[lineIdx + 5] = '      "直接输入陪练角色名字，或输入\'不需要陪练\'独自钓鱼。",';
  console.log('Fixed to:', JSON.stringify(lines[lineIdx + 5]));
}

// Check line 5132
if (lines[lineIdx + 6].includes('“') || lines[lineIdx + 6].includes('”')) {
  console.log('Found problem line 5132:', JSON.stringify(lines[lineIdx + 6]));
  lines[lineIdx + 6] = '    ].join("");';
  console.log('Fixed to:', JSON.stringify(lines[lineIdx + 6]));
}

content = lines.join('\n');
fs.writeFileSync(path, content, 'utf8');
console.log('Done');