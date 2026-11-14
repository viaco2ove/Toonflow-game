import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;

const isWindows = process.platform === 'win32';

// ========== 内置参考表（仅用于 --add 自动补全，不会自动登记） ==========
const PRESETS = {
  claude: { linkName: 'claude', target: '.aispace/claude' },
  qoder: { linkName: '.qoder', target: '.aispace/qoder' },
  trellis: { linkName: '.trellis', target: '.aispace/trellis' },
  agents: { linkName: '.agents', target: '.aispace/agents' },
  workbuddy: { linkName: '.workbuddy', target: '.aispace/workbuddy' },
  'workbuddy-ai': { linkName: '.workbuddy-ai', target: '.aispace/workbuddy-ai' },
  doubao: { linkName: '.doubao', target: '.aispace/doubao' },
  mlink: { linkName: '.mlink', target: '.aispace/mlink' },
};

const AISPACE = path.join(root, '.aispace');
const REGISTRY = path.join(AISPACE, 'aispace-links.json');
const DOC = path.join(AISPACE, 'init-aispace-links.js.md');
const GITATTR = path.join(root, '.gitattributes');
const GITIGNORE = path.join(root, '.gitignore');

const ATTR_BEGIN = '# >>> init-aispace managed >>>';
const ATTR_END = '# <<< init-aispace managed <<<';

// ---------- 工具函数 ----------
/** 读取登记表，不存在返回空表 */
function readRegistry() {
  try {
    if (!fs.existsSync(REGISTRY)) return {};
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return {};
  }
}

/** 写回登记表 */
function writeRegistry(reg) {
  fs.mkdirSync(AISPACE, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

/** 判断路径是否为链接（junction 在 win32 上 lstat 视为目录，用 stat 对比 inode 粗略识别） */
function isLinkPath(p) {
  try {
    const lst = fs.lstatSync(p);
    if (lst.isSymbolicLink()) return true;
    // junction: lstat 是目录，但 fs.realpath 与自身不同
    return lst.isDirectory() && fs.realpathSync(p) !== path.resolve(p);
  } catch {
    return false;
  }
}

/** 更新 .gitattributes 托管块（整体重写，幂等） */
function updateGitattributes(items) {
  let content = '';
  if (fs.existsSync(GITATTR)) content = fs.readFileSync(GITATTR, 'utf8');
  const lines = content.split(/\r?\n/);
  const begin = lines.indexOf(ATTR_BEGIN);
  const end = lines.indexOf(ATTR_END);
  let head = content;
  let tail = '';
  if (begin !== -1 && end !== -1 && end > begin) {
    head = lines.slice(0, begin).join('\n');
    tail = lines.slice(end + 1).join('\n');
  }
  const block = [
    ATTR_BEGIN,
    '# 由 init-aispace-links.js 自动维护，请勿手动编辑此块',
    ...items.map(i => `${i.linkName} export-subst`),
    ...items.map(i => `${i.linkName} symlink`),
    ATTR_END,
  ].join('\n');
  const out = [head.replace(/\s+$/, ''), block, tail.replace(/^\s+/, '')]
    .filter(x => x !== '')
    .join('\n') + '\n';
  fs.writeFileSync(GITATTR, out, 'utf8');
}

/** 追加 .gitignore 补充块（幂等） */
function updateGitignore(items) {
  let content = fs.existsSync(GITIGNORE) ? fs.readFileSync(GITIGNORE, 'utf8') : '';
  const begin = '# >>> init-aispace managed >>>';
  const end = '# <<< init-aispace managed <<<';
  const lines = content.split(/\r?\n/);
  const b = lines.indexOf(begin);
  const e = lines.indexOf(end);
  let head = content;
  let tail = '';
  if (b !== -1 && e !== -1 && e > b) {
    head = lines.slice(0, b).join('\n');
    tail = lines.slice(e + 1).join('\n');
  }
  const block = [
    begin,
    '# AI 工具缓存/会话数据不入库',
    ...items.map(i => `/.aispace/${path.basename(i.target)}/cache`),
    ...items.map(i => `/.aispace/${path.basename(i.target)}/sessions`),
    ...items.map(i => `/.aispace/${path.basename(i.target)}/journal`),
    ...items.map(i => `/.aispace/${path.basename(i.target)}/memory`),
    '*.db',
    '*.sqlite',
    end,
  ].join('\n');
  const out = [head.replace(/\s+$/, ''), block, tail.replace(/^\s+/, '')]
    .filter(x => x !== '')
    .join('\n') + '\n';
  fs.writeFileSync(GITIGNORE, out, 'utf8');
}

/** 生成使用说明文档 */
function writeDoc(items) {
  const rows = items.length
    ? items.map(i => `| ${i.key} | \`${i.linkName}\` | \`${i.target}\` |`).join('\n')
    : '| _（暂无登记）_ | — | — |';
  const vscode = items.length
    ? items.map(i => `"${i.linkName}": true`).join(',\n      ')
    : '';
  const doc = `# init-aispace-links.js 使用说明

> 本文件由 \`init-aispace-links.js\` 自动生成，登记清单变化时会自动刷新。

## 当前已登记的工具

| key | 根目录链接名 | 本体路径 |
|---|---|---|
${rows}

## 常用命令

\`\`\`bash
node init-aispace-links.js --init              # 只初始化，不登记不迁移
node init-aispace-links.js --add <key>         # 登记一个工具
node init-aispace-links.js --add k:link:target # 自定义 linkName / target
node init-aispace-links.js --remove <key>      # 取消登记
node init-aispace-links.js --list              # 查看已登记工具
node init-aispace-links.js --<key>             # 迁移指定工具
node init-aispace-links.js --all               # 迁移全部已登记工具
node init-aispace-links.js --all --dry-run     # 预览，不改动文件
\`\`\`

## .gitattributes 托管块

\`${ATTR_BEGIN}\` 与 \`${ATTR_END}\` 之间的内容为自动维护块，
为每个链接写入 \`export-subst\` 与 \`symlink\` 标记，防止 git 把 junction 当普通目录跟踪。
用户自己写的其他行不受影响。

## gitignore 补充块

同样以托管块方式追加，忽略各工具目录下的 \`cache\`、\`sessions\`、\`journal\`、\`memory\`
以及 \`*.db\`、\`*.sqlite\`。

## VSCode 补充（可选）

在 \`.vscode/settings.json\` 的 \`files.exclude\` 中加入：

\`\`\`json
{
  "files.exclude": {
${vscode}
  }
}
\`\`\`
`;
  fs.mkdirSync(AISPACE, { recursive: true });
  fs.writeFileSync(DOC, doc, 'utf8');
}

// ---------- 命令处理 ----------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

/** 初始化 .aispace 收纳区（不登记、不迁移） */
function cmdInit() {
  if (!fs.existsSync(AISPACE)) {
    fs.mkdirSync(AISPACE, { recursive: true });
    console.log('📁 创建 .aispace 根目录');
  } else {
    console.log('✅ .aispace 已存在');
  }
  const reg = readRegistry();
  writeRegistry(reg);
  console.log('📄 登记表 .aispace/aispace-links.json 就绪');
  updateGitattributes(Object.values(reg));
  updateGitignore(Object.values(reg));
  writeDoc(Object.values(reg));
  console.log('✅ 初始化完成（未登记任何工具）');
}

/** 登记工具：--add key 或 --add key:linkName:target */
function cmdAdd(spec) {
  const parts = spec.split(':');
  let key = parts[0];
  let linkName;
  let target;
  if (parts.length >= 3) {
    linkName = parts[1];
    target = parts[2];
  } else if (PRESETS[key]) {
    linkName = PRESETS[key].linkName;
    target = PRESETS[key].target;
  } else {
    linkName = `.${key}`;
    target = `.aispace/${key}`;
  }
  const reg = readRegistry();
  reg[key] = { key, linkName, target };
  writeRegistry(reg);
  updateGitattributes(Object.values(reg));
  updateGitignore(Object.values(reg));
  writeDoc(Object.values(reg));
  console.log(`✅ 已登记 ${key} | ${linkName} -> ${target}`);
}

/** 取消登记 */
function cmdRemove(key) {
  const reg = readRegistry();
  if (!reg[key]) {
    console.warn(`⚠️ 未登记 ${key}`);
    return;
  }
  delete reg[key];
  writeRegistry(reg);
  updateGitattributes(Object.values(reg));
  updateGitignore(Object.values(reg));
  writeDoc(Object.values(reg));
  console.log(`🗑️ 已取消登记 ${key}（.aispace 下的真实数据保留）`);
}

/** 列出已登记工具 */
function cmdList() {
  const reg = readRegistry();
  const items = Object.values(reg);
  if (!items.length) {
    console.log('（暂无登记）');
    return;
  }
  for (const i of items) {
    const linkAbs = path.join(root, i.linkName);
    const exists = fs.existsSync(linkAbs);
    const kind = !exists ? '缺失' : isLinkPath(linkAbs) ? '链接' : '真实目录';
    console.log(`${i.key.padEnd(14)} ${i.linkName.padEnd(14)} -> ${i.target}  [${kind}]`);
  }
}

/** 迁移指定工具：把根目录真实目录搬进 .aispace 并在原位建链接 */
function cmdMigrate(keys) {
  const reg = readRegistry();
  const items = keys.map(k => reg[k]).filter(Boolean);
  if (!items.length) {
    console.warn('⚠️ 没有匹配的已登记工具');
    return;
  }
  if (!fs.existsSync(AISPACE)) {
    if (dryRun) console.log('[dry-run] 创建目录 .aispace');
    else fs.mkdirSync(AISPACE, { recursive: true });
  }

  for (const item of items) {
    const targetAbs = path.join(root, item.target);
    const linkAbs = path.join(root, item.linkName);
    console.log(`\n==== ${item.key} | ${item.linkName} -> ${item.target}`);

    // 1. 准备本体目录
    if (!fs.existsSync(targetAbs)) {
      if (dryRun) console.log(`[dry-run] 新建本体目录 ${item.target}`);
      else {
        fs.mkdirSync(targetAbs, { recursive: true });
        console.log(`📁 新建本体目录 ${item.target}`);
      }
    } else {
      console.log(`✅ 本体目录已存在 ${item.target}`);
    }

    // 2. 处理根目录上的 linkName
    if (fs.existsSync(linkAbs) || isLinkPath(linkAbs)) {
      if (isLinkPath(linkAbs)) {
        if (dryRun) console.log(`[dry-run] 已是链接，重建 ${item.linkName}`);
        else {
          fs.rmSync(linkAbs, { recursive: true, force: true });
          console.log(`🗑️ 移除旧链接 ${item.linkName}`);
        }
      } else {
        // 真实文件夹：把内容搬进本体目录
        const entries = fs.readdirSync(linkAbs);
        if (entries.length) {
          if (dryRun) {
            console.log(`[dry-run] 保护阻断：${item.linkName} 是真实文件夹，将先搬入 ${item.target}`);
          } else {
            for (const e of entries) {
              const from = path.join(linkAbs, e);
              const to = path.join(targetAbs, e);
              if (fs.existsSync(to)) {
                console.warn(`⚠️ 目标已存在，跳过：${e}`);
                continue;
              }
              fs.renameSync(from, to);
            }
            console.log(`📦 已把 ${item.linkName} 内容搬入 ${item.target}`);
          }
        }
        if (dryRun) {
          console.log(`[dry-run] 删除原目录 ${item.linkName}`);
        } else {
          fs.rmSync(linkAbs, { recursive: true, force: true });
          console.log(`🗑️ 删除原目录 ${item.linkName}`);
        }
      }
    }

    // 3. 建链接
    if (dryRun) {
      console.log(`[dry-run] 创建链接 ${item.linkName} -> ${item.target}`);
      continue;
    }
    const type = isWindows ? 'junction' : 'dir';
    fs.symlinkSync(targetAbs, linkAbs, type);
    console.log(`🔗 创建链接成功 ${item.linkName}`);
  }

  console.log('\n✅ 处理完成');
  if (dryRun) console.log('🧪 DRY-RUN：无实际写入');
}

// ---------- 入口分发 ----------
function main() {
  if (args.includes('--init')) return cmdInit();
  if (args.includes('--list')) return cmdList();

  const addIdx = args.indexOf('--add');
  if (addIdx !== -1 && args[addIdx + 1]) return cmdAdd(args[addIdx + 1]);

  const rmIdx = args.indexOf('--remove');
  if (rmIdx !== -1 && args[rmIdx + 1]) return cmdRemove(args[rmIdx + 1]);

  const reg = readRegistry();
  const known = Object.keys(reg);
  if (args.includes('--all')) {
    return cmdMigrate(known);
  }
  const keyArgs = args.filter(a => a.startsWith('--') && a !== '--dry-run').map(a => a.slice(2));
  if (keyArgs.length) return cmdMigrate(keyArgs);

  console.log(`
用法：
  node init-aispace-links.js --init                初始化 .aispace 收纳区
  node init-aispace-links.js --add <key>           登记工具
  node init-aispace-links.js --remove <key>        取消登记
  node init-aispace-links.js --list                查看已登记工具
  node init-aispace-links.js --<key>               迁移指定工具
  node init-aispace-links.js --all                 迁移全部已登记工具
  node init-aispace-links.js --all --dry-run       预览，不改动文件
`);
}

main();
