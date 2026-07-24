var fs = require('fs');
var c = fs.readFileSync('src/lib/fixDB.prompts.ts', 'utf8');
var lines = c.split('\n');
var l = lines[987];
var s = l.substring(55, 95);
var hex = Buffer.from(s).toString('hex');
console.log('chars: ' + s);
console.log('hex: ' + hex);
for (var i = 0; i < s.length; i++) {
  var code = s.charCodeAt(i);
  if (code === 92 || code === 96) {
    console.log('issue at ' + (55+i) + ' code=0x' + code.toString(16));
  }
}