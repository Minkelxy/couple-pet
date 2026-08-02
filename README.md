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

4. 右键宠物选择“创建 / 连接共享房间”，直接在弹出的表单里填写昵称。第一台电脑把搭档邀请码留空；插件会让猫猫说出第二台电脑的邀请码。

5. 第二台电脑执行同一命令，在表单里填写昵称和邀请码。之后两端均通过 OpenPets 右键菜单完成照顾、传话和送礼物。插件设置里的昵称和邀请码只用于预填默认值；普通配对无需打开设置页。

首次启用插件时，团团会在宠物气泡里显示当前配对步骤；之后也可通过右键菜单的“首次使用指南”再次查看。同一种照顾操作有与服务端一致的 3 秒本地冷却，连续点击不会先显示成功再被服务端静默拒绝。

如果连错房间或需要更换电脑，选择“断开当前共享房间”并勾选确认。插件会先让服务器撤销这台电脑，再清除本地共享状态；服务器不可达时会保留令牌和离线队列，避免假退出后无法恢复。确认断开会放弃尚未同步的操作，但保留昵称供下一次连接预填。

OpenPets 报告离线时，插件只更新本地状态，不会继续发起注定失败的请求；网络恢复或屏幕解锁后会立即同步，无需等待下一次 15 秒轮询。轮询、恢复和解锁同时发生时会合并为同一个同步任务，避免重复展示消息。如果服务器已撤销设备令牌，插件会停止使用旧令牌并回到待连接状态。

离线期间积累的事件按最早优先、每页最多 50 条恢复，游标从上一页继续，不会因为积压较多而只保留最后一页。多条传话、礼物和互动记录使用 OpenPets 允许的多行 Markdown 气泡，并按宿主字数限额自动分页；换行会转为空格，包含链接或敏感格式的内容会显示安全占位提示，避免一条不兼容消息卡住整批同步。

所有右键菜单命令都经过插件内的恢复边界：断网、服务限流、邀请码错误和失效令牌会变成团团的明确反馈，不再作为 `plugin callback failed` 交给 OpenPets。已连接时再次执行连接命令不会覆盖当前房间；事件发送遇到 429 会保留在队列中等待自动重试，其他无法重试的单条数据会提示后跳过，不阻塞后续内容。

传话和礼物提交后会明确显示一种结果：服务器确认后提示“已送给搭档”，网络不可用时提示“已保存在待发送队列”，服务拒绝时提示修改或重选。空白传话和无效礼物会在本机直接拦截；反馈不回显传话正文，也不会把“本地已保存”误说成“已经送达”。

设置中的“安静陪伴”默认开启：系统进入空闲或锁屏时，团团只切换到静默休息动作，恢复使用时回到待机。它不发声、不弹气泡、不增加定时轮询，可随时关闭；OpenPets 自身的全局免打扰设置继续负责声音与语音策略。

本机开发地址 `http://127.0.0.1:4317` 已在插件 manifest 中声明并申请 `network:local`。两台真实电脑使用时，应把服务部署到 HTTPS，并把实际域名替换 manifest 中的 `shared-pet.example.com`；OpenPets 会要求用户重新批准网络权限。

服务器容器部署时设置 `HOST=0.0.0.0`；默认只监听 `127.0.0.1`，避免本地开发时意外暴露。

## 在 OpenPets 源码中开发

先取得 OpenPets 源码、安装依赖并准备本项目扩展：

```powershell
git clone https://github.com/alvinunreal/openpets.git vendor/openpets
cd vendor/openpets
pnpm install
cd ../..
npm run dev:openpets
```

本仓库已准备好依赖后，也可以在项目根目录一键启动：

```powershell
npm run dev:openpets
```

只启动、不重新同步宠物包时使用 `npm run start:openpets`。不要再运行 OpenPets 的 `dev:desktop:plugins` 全插件开发命令，它会监听与本项目无关的官方插件。运行日志按启动会话写入 `data/openpets.stdout.log` 和 `data/openpets.stderr.log`，主进程不会再向已经关闭的终端管道写日志。

启动器通过 OpenPets 官方的 `OPENPETS_DEV_PLUGIN_PATHS` 直接加载 `openpets/plugins/openpets.shared-pet`，不会被当作官方插件发布，也不再通过整目录复制触发多轮热重载。宠物包位于 `vendor/openpets/local-pets/tuan-tuan`，可使用 OpenPets CLI 从文件夹安装。

## Windows 安装包

Windows 交付沿用 OpenPets 官方 Electron 与 electron-builder 流程，不创建独立桌面壳。构建覆盖层会把团团设为 OpenPets 内置宠物，把 `openpets.shared-pet` 注册为随包插件并默认启用，同时保留 OpenPets 的 MIT 许可和第三方声明。

正式安装包必须先配置真实 HTTPS 域名；脚本会拒绝示例域名、HTTP 地址和未列入 OpenPets 网络白名单的服务：

```powershell
npm run configure:production -- pet.your-domain.com
npm run package:windows
```

安装程序生成在 `vendor/openpets/apps/desktop/dist-electron/`。只做本机联调时，可保留 `http://127.0.0.1:4317` 并生成可直接运行的解压目录：

```powershell
npm run package:windows:dir:local
```

OpenPets 官方 Windows 构建依赖符号链接。首次打包前需要在 Windows“设置 → 系统（或隐私和安全性）→ 开发者选项”中启用开发人员模式，或在管理员 PowerShell 中构建。构建流程会先执行官方权限检查，未满足时直接停止，不会留下一个看似成功但内容不完整的安装包。

## 云端部署

`deploy/` 提供 Node 服务与 Caddy HTTPS 反向代理，无第三方服务端依赖：

```powershell
npm run configure:production -- pet.your-domain.com
# 让该域名的 DNS A/AAAA 记录指向服务器后执行：
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

配置命令会同时生成被 Git 忽略的 `deploy/.env`、更新插件网络白名单，并把默认同步地址设为对应的 HTTPS URL；示例域名、协议、端口和非法域名会被拒绝。Caddy 自动申请 TLS 证书。共享状态保存在 Docker volume，服务默认每 6 小时备份并只保留最近 14 份。配置变化后，两台 OpenPets 客户端需要重新批准网络权限。

部署完成后先访问 `https://pet.your-domain.com/health`，确认返回 `{ "ok": true }`，再在插件菜单执行“检查连接与配置”。

## 验证

```powershell
node --test apps/server/domain.test.js apps/server/http.integration.test.js openpets/plugins/openpets.shared-pet/test.js
node --check openpets/plugins/openpets.shared-pet/index.js
```

服务端测试覆盖双设备配对、幂等事件、双方参与奖励、私有传话和超过 50 条事件时的有序分页；插件测试同时覆盖离线队列、原生配对表单、安全多行气泡、命令故障恢复、传话/礼物送达确认、限流重试、静默陪伴、照顾冷却与专属进食精灵调度。正式插件目录还会通过 OpenPets 官方校验器检查资源声明、尺寸和文件边界。

## 生产边界

异步共享闭环、服务端防护和 OpenPets 官方 Windows 覆盖层已经完成。生产发布前还需要：

- HTTPS 反向代理与真实域名白名单；
- 在启用 Windows 开发人员模式的构建机上生成并安装 NSIS 包；
- 使用两台真实 Windows 电脑验收配对、断网恢复和照顾动画节奏；
- 如需对外分发，再接入发布证书完成安装包签名。

OpenPets 为 MIT 许可项目。本仓库的集成必须保留其上游许可与版权声明。
