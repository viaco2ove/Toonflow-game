const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// Fix 1: rulebookNarration uses variables not in scope - convert to static string
// The original was trying to use ${publicState.site_name}, ${mentors} etc which don't exist at rulebook definition level
// Change it to a simpler static string
const wrongRulebookNarration = `rulebookNarration: \`你来到 \${scalarText(publicState.site_name) || "水边"}，准备开始钓鱼。\${mentors && mentors.length > 0 ? \`可选陪练：\${mentors.join("、")}。\` : "当前没有可选陪练。"}准备好后直接输入"抛竿"开始。\`,`;

const correctRulebookNarration = `rulebookNarration: "钓鱼开始。你可以输入"抛竿"开始钓鱼，或输入"需要陪练"查看陪练选项。",`;

if (content.includes(wrongRulebookNarration)) {
  content = content.replace(wrongRulebookNarration, correctRulebookNarration);
  console.log('Fixed rulebookNarration to static string');
} else {
  // Try to find and replace by pattern
  const fishingIdx = content.indexOf('fishing: {');
  const rsIdx = content.indexOf('ruleSummary:', fishingIdx);
  if (rsIdx > 0) {
    const rnIdx = content.indexOf('rulebookNarration:', rsIdx);
    if (rnIdx > 0 && rnIdx < rsIdx + 500) {
      // Find the end of the rulebookNarration line
      let end = rnIdx;
      while (end < content.length && content[end] !== '\n') end++;
      const line = content.slice(rnIdx, end);
      console.log('Found rulebookNarration line:', JSON.stringify(line));
      // Replace with static version
      content = content.replace(line, '    rulebookNarration: "钓鱼开始。你可以输入"抛竿"开始钓鱼，或输入"需要陪练"查看陪练选项。",');
      console.log('Replaced rulebookNarration');
    }
  }
}

// Fix 2: Remove rulebookNarration from interface since we're not really using it properly
// Actually, let's keep it in interface since we added it, just fix the value

fs.writeFileSync(path, content, 'utf8');
console.log('Done');