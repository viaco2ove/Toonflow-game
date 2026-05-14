const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// Find the fishing section and fix the closing
const fishingIdx = content.indexOf('fishing: {');
if (fishingIdx < 0) {
  console.log('fishing rulebook not found');
  process.exit(1);
}

// Find the setup start within fishing
const setupIdx = content.indexOf('setup: (ctx, sessionId, entrySource) => {', fishingIdx);
console.log('setup at:', setupIdx);

// Find where setup ends - look for the next rulebook
const cultivationIdx = content.indexOf('cultivation: {', fishingIdx);
const researchIdx = content.indexOf('research_skill: {', fishingIdx);
const endIdx = Math.min(
  cultivationIdx > 0 ? cultivationIdx : Infinity,
  researchIdx > 0 ? researchIdx : Infinity
);
console.log('fishing rulebook ends at:', endIdx);

// The content between setup and endIdx should have the setup
const setupContent = content.slice(setupIdx, endIdx);
console.log('\\nLast 400 chars of fishing setup:');
console.log(JSON.stringify(setupContent.slice(-400)));

// Find resume_token line
const resumeIdx = setupContent.indexOf('resume_token:');
if (resumeIdx > 0) {
  const afterResume = setupContent.slice(resumeIdx);
  console.log('\\nAfter resume_token:');
  console.log(JSON.stringify(afterResume.slice(0, 100)));
}

// The problem: the closing uses `),` to close an arrow function returning object
// But we changed to a block function with explicit return
// So `}),` should be `},` (close the return object) then `};` (close the function) then `,`

// Find the pattern `resume_token: ...,\n    }),\n    options:` within fishing
const closingPattern = 'resume_token: `resume_${sessionId}`,\r\n    }),\r\n    options: fishingOptions,';
const closingIdx = content.indexOf(closingPattern, fishingIdx);
console.log('\\nClosing pattern found at:', closingIdx);

if (closingIdx > 0) {
  // This is within fishing - need to fix it
  // The `}),` closes: } = return object, ) = arrow function (but we have block now!), , = separator
  // Should be: }; };, where first }; closes return, second }; closes function

  // Actually, looking at the content, after resume_token line we have:
  // `    }),\r\n    options: fishingOptions,`
  // This means: `}` closes the return object, `)` is wrong (no longer arrow function), `,` separates

  // Replace the pattern to fix the closing
  const newClosing = 'resume_token: `resume_${sessionId}`,\r\n      };\r\n    },\r\n    options: fishingOptions,';
  content = content.replace(closingPattern, newClosing);
  console.log('Fixed closing pattern');
}

// Also fix the indentation issue with session_id
const oldSessionIdIndent = 'return {\r\n      session_id:';
const newSessionIdIndent = 'return {\r\n        session_id:';
if (content.includes(oldSessionIdIndent)) {
  content = content.replace(oldSessionIdIndent, newSessionIdIndent);
  console.log('Fixed session_id indentation');
}

fs.writeFileSync(path, content, 'utf8');
console.log('\\nDone');