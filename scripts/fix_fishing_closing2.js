const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// Find the fishing setup closing and fix it
// Current: `resume_token: ...,\n    }),\n    options: fishingOptions,`
// Should be: `resume_token: ...,\n      };\n    },\n    options: fishingOptions,`

// But first let's check what's actually there
const fishingIdx = content.indexOf('fishing: {');
if (fishingIdx > 0) {
  const resumeIdx = content.indexOf('resume_token: `resume_${sessionId}`', fishingIdx);
  if (resumeIdx > 0 && resumeIdx < fishingIdx + 2000) {
    const slice = content.slice(resumeIdx, resumeIdx + 80);
    console.log('Found fishing resume_token at', resumeIdx);
    console.log('Slice:', JSON.stringify(slice));

    // Find the exact closing pattern
    const closingIdx = content.indexOf('}),\n    options: fishingOptions,', fishingIdx);
    console.log('Closing pattern at:', closingIdx);

    if (closingIdx > 0) {
      // Replace this specific pattern within fishing section
      const before = content.slice(fishingIdx, closingIdx);
      const after = content.slice(closingIdx);

      // Only replace if this is within fishing section (before next rulebook)
      const nextRulebook = content.indexOf('werewolf: {', fishingIdx);
      if (nextRulebook > closingIdx || nextRulebook < 0) {
        console.log('Applying fix...');
        const oldClosing = '}),\n    options: fishingOptions,';
        const newClosing = '},\n    },\n    options: fishingOptions,';
        content = content.replace(oldClosing, newClosing);
        console.log('Applied fix');
      }
    }
  }
}

// Also fix the indentation inside fishing setup - session_id should be indented more
const oldSessionId = 'return {\n      session_id: sessionId,';
const newSessionId = 'return {\n        session_id: sessionId,';
if (content.includes(oldSessionId)) {
  content = content.replace(oldSessionId, newSessionId);
  console.log('Fixed session_id indentation');
}

fs.writeFileSync(path, content, 'utf8');
console.log('Done');