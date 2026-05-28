-- 用来诊断/修复 db.sqlite 的脚本
PRAGMA integrity_check;
VACUUM;
PRAGMA journal_mode=TRUNCATE;
