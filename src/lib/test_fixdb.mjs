import { PROMPT_STORYBOARD_POLISH } from "./fixDB.prompts.ts";
console.log('Length:', PROMPT_STORYBOARD_POLISH.length);
console.log('Newline count:', (PROMPT_STORYBOARD_POLISH.match(/\n/g) || []).length);
console.log('First 200 chars JSON:');
console.log(JSON.stringify(PROMPT_STORYBOARD_POLISH.slice(0, 200)));
