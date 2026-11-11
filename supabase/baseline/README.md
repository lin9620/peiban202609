# 生产 Supabase schema 基线

这个目录是从**当前测试 Supabase 项目**导出的 schema-only 基线，用来给新的生产项目建结构。

## 文件

| 文件 | 用途 |
|---|---|
| `baseline.sql` | 一份可直接执行的完整基线：`begin;` + public schema + platform glue + `commit;` |
| `schema.sql` | 只含 `public` schema、扩展和权限，便于 review / diff |
| `platform.sql` | auth 注册触发器、Storage bucket 与策略、Realtime publication |
| `manifest.json` | 生成时间、对象数量、对象名单、文件 SHA256，供 `verify` 比对 |

当前基线（2026-11-11）：

- 31 张表
- 99 个业务函数
- 54 条 public RLS 策略
- 21 个业务触发器
- 87 个索引（含主键/唯一约束索引）
- 2 个 Storage bucket、7 条 Storage 策略
- 2 张 Realtime 表
- 1 个 auth 注册触发器

## 不包含什么

基线是 `pg_dump --schema-only`，**不包含**：

- `auth.users` 用户
- 任何业务数据（帖子、评论、私信、漂流瓶、故事、宠物、通知等）
- Storage 里的文件
- `anon` / `service_role` key
- 测试账号、测试内容

生产项目应该是一个全新的空项目；基线只负责建表、函数、策略、触发器和 bucket。

## 重新生成

前置条件：本机有 PostgreSQL 客户端，`pg_dump` 版本 >= 服务端大版本（当前测试库是 PostgreSQL 17）。

```powershell
# PATH 里已有 pg_dump
node tools/schema-baseline.mjs dump

# 或指定 PostgreSQL 的 bin 目录
$env:PG_BIN = "C:\Program Files\PostgreSQL\17\bin"
node tools/schema-baseline.mjs dump
```

连接串优先取 `--url`，其次 `SUPABASE_DB_URL` / `WP_DB_URL` / `DATABASE_URL`，最后读 `.env.backup`。  
`.env.backup` 已在 `.gitignore` 中，不会进 git。

生成后会更新：

- `schema.sql`
- `platform.sql`
- `baseline.sql`
- `manifest.json`

## 应用到生产

1. 新建一个空的生产 Supabase 项目（PostgreSQL 17）。
2. 从 Dashboard → Project Settings → Database 取 **Session pooler / Direct connection** 的 URI（不要用 Transaction pooler 的 6543 端口执行整份基线）。
3. 把连接串放到环境变量，不要写进仓库：

```powershell
$env:SUPABASE_DB_URL = "postgresql://postgres.<ref>:<password>@...:5432/postgres"
```

4. 先 dry-run：

```powershell
node tools/schema-baseline.mjs apply --dry-run
```

5. 确认目标是空库后执行：

```powershell
node tools/schema-baseline.mjs apply --yes
```

6. 校验：

```powershell
node tools/schema-baseline.mjs verify
```

也可以在 Supabase SQL Editor 里直接粘贴 `baseline.sql` 执行；文件本身已经包含 `begin; ... commit;`。

### 安全闸门

`apply` 默认会拒绝：

- `public` 里已经有业务表
- `auth.users` 里已经有用户

如果确实要覆盖，才加 `--allow-nonempty` / `--allow-auth-users`；这两个参数是危险操作，执行前先备份。

### “可重复”的边界

- **可重复生成**：每次 `dump` 都从测试库重新产出同一套结构，带 SHA256 和对象清单。
- **可重复校验**：`verify` 可以把任意目标库和 `manifest.json` 逐项比对。
- **可重复执行**：`baseline.sql` 已做成同结构可重复跑：
  - 表/序列/索引用 `IF NOT EXISTS`
  - 函数/触发器用 `OR REPLACE`
  - 策略先 `DROP POLICY IF EXISTS` 再建
  - 主键/唯一/外键/CHECK 约束先查 `pg_constraint` 再建
  - identity 列先查 `pg_attribute.attidentity` 再 `ADD GENERATED`
- **不是迁移工具**：重复执行不会补列、改类型、改已有约束定义。结构变更仍要写 `MIGRATION_*.sql`，再重新 dump 基线。
- `baseline.sql` 在事务里执行，失败自动回滚。`apply` 默认仍会拒绝非空 `public` / 已有 `auth.users`；确认是同结构库要重复执行时，才加 `--allow-nonempty`。

## 生产线后续流程

1. 在测试库写 `MIGRATION_xxx.sql` 并应用。
2. 跑测试、验证功能。
3. 重新 `node tools/schema-baseline.mjs dump`，review `supabase/baseline` 的 diff。
4. 生产库只应用新的增量迁移，或者在新项目上使用最新基线。
5. `service_role` 只放 Worker secrets；前端只保留 anon key，绝不能把 `service_role` 写成 `VITE_*`。
