const fs = require('fs');
const path = 'src/modules/game-runtime/engines/MiniGameController.ts';
let content = fs.readFileSync(path, 'utf8');

// Fix 1: Indentation of session_id inside fishing setup
// The line "      session_id: sessionId," should have 6 more spaces
content = content.replace(
  `return {
      session_id: sessionId,`,
  `return {
        session_id: sessionId,`
);

// Fix 2: The closing pattern - change `    }),` to `    };` + `},`
// The line 4577 has `    }),` but it should be `    };` followed by `},` on next line
// Find the fishing setup closing
const fishingIdx = content.indexOf('fishing: {');
if (fishingIdx > 0) {
  // Find resume_token line within fishing
  const resumeIdx = content.indexOf('resume_token: `resume_${sessionId}`,', fishingIdx);
  if (resumeIdx > fishingIdx && resumeIdx < fishingIdx + 2000) {
    // Check if it's followed by }), which is wrong
    const afterResume = content.slice(resumeIdx, resumeIdx + 50);
    if (afterResume.includes('}),')) {
      // This is wrong - should be });
      content = content.replace(
        'resume_token: `resume_${sessionId}`,\n    }),',
        'resume_token: `resume_${sessionId}`,\n    };\n  },'
      );
      console.log('Fixed closing pattern');
    }
  }

  // Fix public_state - add available_mentors
  const oldPublicState = `public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
      }),`;

  const newPublicState = `public_state: buildSimplePublicState({
        site_name: "当前水域",
        user_level: readMiniGamePlayerLevel(ctx.state),
        exp_reward: 0,
        current_status: "准备抛竿",
        last_result: "",
        last_reward: "",
        available_mentors: mentors,
      }),`;

  if (content.includes(oldPublicState)) {
    content = content.replace(oldPublicState, newPublicState);
    console.log('Added available_mentors');
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log('Done');