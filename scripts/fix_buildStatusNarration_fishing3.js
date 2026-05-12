const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Fix line 5268 (0-indexed: 5267) - the if condition has curly quotes around "fishing"
if (lines[5267].includes('"') || lines[5267].includes('"')) {
  console.log('Found problem at line 5268:', JSON.stringify(lines[5267]));
  // The issue is "fishing" uses curly quotes instead of ASCII quotes
  // Replace the entire line with correct version
  lines[5267] = '  if (rulebook.gameType === "fishing") {';
  console.log('Fixed to:', JSON.stringify(lines[5267]));
}

// Fix line 5269 (0-indexed: 5268) - "未选择" might have curly quotes
if (lines[5268].includes('"') || lines[5268].includes('"')) {
  console.log('Found problem at line 5269:', JSON.stringify(lines[5268]));
  lines[5268] = '    const mentor = scalarText(publicState.mentor) || "未选择";';
  console.log('Fixed to:', JSON.stringify(lines[5268]));
}

// Fix line 5272 (0-indexed: 5271) - "准备抛竿" curly quotes
if (lines[5271].includes('"') || lines[5271].includes('"')) {
  console.log('Found problem at line 5272:', JSON.stringify(lines[5271]));
  lines[5271] = '      `钓鱼状态：${scalarText(publicState.current_status) || "准备抛竿"}。陪练：${mentor}。`,';
  console.log('Fixed to:', JSON.stringify(lines[5271]));
}

// Fix line 5273 (0-indexed: 5272) - "" strings
if (lines[5272].includes('"') || lines[5272].includes('"')) {
  console.log('Found problem at line 5273:', JSON.stringify(lines[5272]));
  lines[5272] = '      scalarText(publicState.last_result) ? `本轮结果：${scalarText(publicState.last_result)}。` : "",';
  console.log('Fixed to:', JSON.stringify(lines[5272]));
}

// Fix line 5274 (0-indexed: 5273) - "" string
if (lines[5273].includes('"') || lines[5273].includes('"')) {
  console.log('Found problem at line 5274:', JSON.stringify(lines[5273]));
  lines[5273] = '      reward ? `最近收获：${reward}。` : "",';
  console.log('Fixed to:', JSON.stringify(lines[5273]));
}

// Fix line 5275 (0-indexed: 5274) - "抛竿""收杆" curly quotes
if (lines[5274].includes('"') || lines[5274].includes('"')) {
  console.log('Found problem at line 5275:', JSON.stringify(lines[5274]));
  lines[5274] = '      "可直接输入\'抛竿\'\'收杆\'或\'继续钓鱼\'。",';
  console.log('Fixed to:', JSON.stringify(lines[5274]));
}

// Fix line 5276 (0-indexed: 5275) - join("") curly quotes
if (lines[5275].includes('"') || lines[5275].includes('"')) {
  console.log('Found problem at line 5276:', JSON.stringify(lines[5275]));
  lines[5275] = '    ].filter(Boolean).join("");';
  console.log('Fixed to:', JSON.stringify(lines[5275]));
}

content = lines.join('\n');
fs.writeFileSync(path, content, 'utf8');
console.log('Done');