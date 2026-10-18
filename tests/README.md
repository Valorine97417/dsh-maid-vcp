# 已安装 bundle 的只读测试

`node tests/bundle.test.mjs` 自动查找桌面版 `app.asar`（当前 Node 相邻 resources、项目安装根相邻 resources、常规 Windows 安装位置），再查 APPDATA 下的 npm 安装。通过既有 `patch/asar-io.cjs` 读取 packed 条目，不调用安装器、不写入安装目录。

可指定目标，避免多安装环境测错对象：

```sh
node tests/bundle.test.mjs "D:/DeepSeek Harness/resources/app.asar"
node tests/bundle.test.mjs "/path/to/index-currentHash.js"
node tests/bundle.test.mjs "/path/to/dsh-web-frontend"
```

也支持 `DSH_ASAR` 环境变量和 `app.asar!/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-currentHash.js`。从 assets 目录或 asar 选择 `index-*.js`，不固定 hash；多个候选时报错，要求明确指定。显式路径或环境变量错误时不会回退到别的安装。语法检查将读出的源码送入 `node --check --input-type=module`，无需解包落盘。

```sh
node tests/bundle-location.test.mjs
node tests/bundle.test.mjs
node patch/check-anchors.cjs
node tests/boost-fontface.test.cjs
git diff --check
```

定位回归测试使用临时目录中的普通布局与最小 asar fixture，覆盖显式文件、包目录、assets、asar、内部路径、环境变量及歧义/错误目标。bundle 测试保留原 39 项断言，仅将旧代际变量名写死的 HTML render 调用和 script 过滤检查适配至现有代际 shim；这仍是静态完整性检查，不等于 GUI/浏览器交互验证。
