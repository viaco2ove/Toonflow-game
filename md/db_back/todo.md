DDL 全部迁移到 migrations 后，initDB 里那些 tableBuilder 是不是多余了？
   → 是的！理论上 initDB.ts 里 30+ 个表的建表语句可以全部迁移到 Knex migrations，initDB 就可以只留一个"跑 migrations" 的调用。但这是个大工程。