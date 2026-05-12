const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// The current corrupted line (line 4594) has Chinese quotes in ruleSummary
// We need to find and replace it with correct quotes
// The line uses U+201C and U+201D for quotes inside the string value

// Find the fishing rulebook section
const fishingIdx = content.indexOf('fishing: {');
if (fishingIdx < 0) {
  console.log('fishing rulebook not found');
  process.exit(1);
}

// Find the ruleSummary line within fishing
const ruleStart = content.indexOf('ruleSummary:', fishingIdx);
const ruleEnd = content.indexOf(',', ruleStart);
const currentLine = content.slice(ruleStart, ruleEnd);
console.log('Current ruleSummary:', JSON.stringify(currentLine));

// The problem: the quotes inside the string are Chinese quotes U+201C/U+201D
// TypeScript expects regular ASCII quotes or properly escaped quotes in template literals

// The fix: use template literal with backticks, and escape the inner quotes properly
// Since rulebookNarration uses template literal and references mentors and publicState
// we need to make ruleSummary a simple string without template interpolation

// Let's check what the correct format should be
// The line should be: ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作..."  with ASCII quotes

// Actually looking at the bytes again:
// The line starts with spaces, then "ruleSummary: ", then U+201C (e2809c), then Chinese chars
// This is wrong - TypeScript can't parse this because the string delimiter should be ASCII "

// Let's try to fix by finding the exact pattern and replacing with proper ASCII-quoted string
const oldPattern = 'ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",';

console.log('Searching for pattern...');
const idx = content.indexOf(oldPattern);
if (idx > 0) {
  console.log('Found at', idx);
  content = content.replace(oldPattern, 'ruleSummary: "直接输入"抛竿""收杆""继续钓鱼"等动作。可能空竿，也可能钓到鱼或宝物；有收获会直接加入物品。",');
  fs.writeFileSync(path, content, 'utf8');
  console.log('Fixed');
} else {
  console.log('Pattern not found, trying byte search...');
  // Try to find the line by searching backwards from rulebookNarration
  const rnIdx = content.indexOf('rulebookNarration:');
  if (rnIdx > fishingIdx) {
    // Search backwards for the ruleSummary line
    const beforeSlice = content.slice(fishingIdx, rnIdx);
    const rsIdx = beforeSlice.lastIndexOf('ruleSummary:');
    if (rsIdx >= 0) {
      const lineStart = fishingIdx + rsIdx;
      const lineEnd = content.indexOf(',', lineStart);
      console.log('Found ruleSummary line at', lineStart, 'to', lineEnd);
      console.log('Content:', JSON.stringify(content.slice(lineStart, lineEnd + 20)));
    }
  }
}