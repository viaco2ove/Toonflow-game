const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Fix line 5268 (0-indexed: 5267) - the if condition has curly quotes around "fishing"
// Note: curly quotes are U+201C and U+201D
if (lines[5267].includes('“') || lines[5267].includes('”')) {
  console.log('Found problem at line 5268:', JSON.stringify(lines[5267]));
  lines[5267] = '  if (rulebook.gameType === "fishing") {';
  console.log('Fixed to:', JSON.stringify(lines[5267]));
}

// Check all lines in the fishing block
for (let i = 5267; i <= 5276; i++) {
  const line = lines[i];
  const hasLeftCurly = line.includes('“');
  const hasRightCurly = line.includes('”');
  if (hasLeftCurly || hasRightCurly) {
    console.log('Line', i + 1, 'has curly quotes:', JSON.stringify(line));
    // Count them
    let leftCount = 0, rightCount = 0;
    for (const ch of line) {
      if (ch === '“') leftCount++;
      if (ch === '”') rightCount++;
    }
    console.log('  Left curly:', leftCount, 'Right curly:', rightCount);
  }
}

content = lines.join('\n');
fs.writeFileSync(path, content, 'utf8');
console.log('Done');