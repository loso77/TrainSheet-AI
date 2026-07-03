# 手机部署

1. 上传整个 pages-backend 文件夹到 GitHub 仓库根目录。
2. Cloudflare → Workers 和 Pages → 创建应用程序 → Pages → 连接 GitHub。
3. 选择 TrainSheet-AI。
4. 根目录：/pages-backend
5. 构建命令：留空
6. 构建输出目录：.
7. 创建 Pages 项目。
8. 创建 D1 数据库，在控制台执行 schema.sql。
9. Pages 项目设置中绑定 D1，变量名 DB。
10. 添加 README 中的普通变量和三个加密机密。
11. 重新部署。
