const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// Find line 4594 (0-indexed 4593) and fix the ruleSummary line
const lines = content.split('\\n');

console.log('Original line:', JSON.stringify(lines[4593]));

// The problem is the line uses U+201C (8220) as string delimiter instead of ASCII " (34)
// and U+201D (8221) appears incorrectly within the string

// Create the corrected line with proper ASCII quotes
// ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作...
// Using ASCII " (34) as the string delimiter, and U+201C/U+201D (8220/8221) for inner quotes
const correctedLine = '    ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",';

lines[4593] = correctedLine;
content = lines.join('\\n');

fs.writeFileSync(path, content, 'utf8');
console.log('Corrected line:', JSON.stringify(correctedLine));
console.log('Done');