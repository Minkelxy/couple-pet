# 基于 OpenPets 的双人共享桌宠

本项目不是另一套桌宠壳，而是 OpenPets 的扩展层：

```text
OpenPets 桌面应用
├─ 团团 pet package（8×9 标准 spritesheet）
└─ openpets.shared-pet（SDK v3 插件）
   └─ HTTPS → shared-pet 同步服务
```

OpenPets 负责透明窗口、置顶、拖动、鼠标穿透、托盘、多显示器、缩放、宠物渲染和插件沙箱。本项目只实现真实猫猫角色包，以及双人房间、共享状态、离线事件、传话、礼物和共同成长。

实现基于 OpenPets `main` 当前的 manifest v3 / SDK 3.0.0 契约，参考官方 `openpets.virtual-pet` 插件，而不是 PRD 中较早的接口假设。

## 目录

- `openpets/plugins/openpets.shared-pet/`：可由 OpenPets Developer Mode 直接加载的插件。
- `openpets/pets/tuan-tuan/`：可由 OpenPets CLI 从文件夹安装的宠物包。
- `apps/server/`：云端权威状态服务；仅使用 Node.js 内置模块。
- `scripts/build_spritesheet.py`：把透明猫猫源图生成 OpenPets 固定 192×208、8 列 9 行 spritesheet。
- `scripts/prepare-openpets.mjs`：把宠物包同步到 OpenPets 源码 checkout；开发插件由启动器直接加载项目源目录。
- `img/`：用户提供的真实猫猫日常参考图。

## 本地端到端运行

要求 Node.js 20+、OpenPets 3.x。

1. 启动同步服务：

   ```powershell
   node apps/server/index.js
   ```

2. 在 OpenPets 中打开 `Plugins → Developer Mode → Load unpacked plugin folder`，选择：

   ```text
   openpets/plugins/openpets.shared-pet
   ```

3. 安装猫猫角色包：

   ```powershell
   npx openpets install --from-folder "<项目路径>\openpets\pets\tuan-tuan"
   ```

4. 在 OpenPets 的插件设置中填写昵称。第一台电脑把邀请码留空，右键宠物选择“创建 / 连接共享房间”；插件会让猫猫说出第二台电脑的邀请码。

5. 第二台电脑填写昵称和邀请码，再执行同一命令。之后两端均通过 OpenPets 右键菜单完成照顾、传话和送礼物。

本机开发地址 `http://127.0.0.1:4317` 已在插件 manifest 中声明并申请 `network:local`。两台真实电脑使用时，应把服务部署到 HTTPS，并把实际域名替换 manifest 中的 `shared-pet.example.com`；OpenPets 会要求用户重新批准网络权限。

服务器容器部署时设置 `HOST=0.0.0.0`；默认只监听 `127.0.0.1`，避免本地开发时意外暴露。

## 在 OpenPets 源码中开发

先取得 OpenPets 源码、安装依赖并准备本项目扩展：

```powershell
git clone https://github.com/alvinunreal/openpets.git vendor/openpets
node scripts/prepare-openpets.mjs vendor/openpets
cd vendor/openpets
pnpm install
pnpm dev:desktop:plugins
```

本仓库已准备好依赖后，也可以在项目根目录一键启动：

```powershell
npm run dev:openpets
```

只启动、不重新同步宠物包时使用 `npm run start:openpets`。运行日志按启动会话写入 `data/openpets.stdout.log` 和 `data/openpets.stderr.log`，主进程不会再向已经关闭的终端管道写日志。

启动器通过 OpenPets 官方的 `OPENPETS_DEV_PLUGIN_PATHS` 直接加载 `openpets/plugins/openpets.shared-pet`，不会被当作官方插件发布，也不再通过整目录复制触发多轮热重载。宠物包位于 `vendor/openpets/local-pets/tuan-tuan`，可使用 OpenPets CLI 从文件夹安装。

## 云端部署

`deploy/` 提供 Node 服务与 Caddy HTTPS 反向代理，无第三方服务端依赖：

```powershell
Copy-Item deploy/.env.example deploy/.env
# 把 deploy/.env 中的域名改为实际域名，并让 DNS 指向服务器
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

Caddy 自动申请 TLS 证书。共享状态保存在 Docker volume，服务默认每 6 小时备份并只保留最近 14 份。部署后必须把插件 manifest 的 `shared-pet.example.com` 和 `serverUrl` 默认值替换为实际 HTTPS 域名，再在两台 OpenPets 客户端重新批准网络权限。

## 验证

```powershell
node --test apps/server/domain.test.js apps/server/http.integration.test.js openpets/plugins/openpets.shared-pet/test.js
node --check openpets/plugins/openpets.shared-pet/index.js
```

服务端测试覆盖双设备配对、幂等事件、双方参与奖励和私有传话；插件测试覆盖离线队列的过滤与 100 条上限。

## 生产边界

v0.1 已实现 PRD 的异步共享闭环。生产上线还需要：

- HTTPS 反向代理与真实域名白名单；
- API 级 IP/设备限流和结构化审计；
- Windows 安装包沿用 OpenPets 官方构建与签名链；
- 正式逐帧精灵图替换当前由真实猫猫插画生成的程序化帧。

OpenPets 为 MIT 许可项目。本仓库的集成必须保留其上游许可与版权声明。
