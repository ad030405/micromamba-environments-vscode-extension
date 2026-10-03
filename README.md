# Micromamba Environments

中文 | [English](./README.en.md)

> [!NOTE]
> 本项目由 AI 生成

在 VS Code 中管理 Micromamba 环境和软件包，并为 Python 扩展选择真正的解释器。

这是一个 TypeScript 编写的桌面 / Remote 扩展，首版面向 Windows、Linux 和 macOS。Windows PowerShell 和本机 Micromamba 环境是首要验证目标。

## 安装与使用

需要 VS Code **1.110 或更新版本**、已经安装的 Micromamba，以及 Microsoft 的 **[Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python)** 和 **[Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs)** 扩展。建议安装 **[Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance)** 获得补全、导入解析和类型检查，安装 **[Python Debugger](https://marketplace.visualstudio.com/items?itemName=ms-python.debugpy)** 进行调试。Python 和 Python Environments 是插件依赖，安装时 VS Code 会处理它们。

1. 在扩展面板搜索 `Micromamba Environments` 或[点击此处](https://marketplace.visualstudio.com/items?itemName=ad070809.micromamba-environments)安装本扩展。
2. 重新加载窗口，打开左侧 **Micromamba** 面板。
3. 若未发现环境，在设置中搜索 `@ext:ad070809.micromamba-environments`，填写可执行文件和根目录，然后刷新。
4. 点击环境名称或右侧 ✓，为当前工作区选择解释器；也可通过 Python 扩展右下角的解释器入口或官方 Python Environments 面板切换。多文件夹工作区会提示选择目标文件夹。
5. 正常使用 **Python: Run Python File in Terminal**、Pylance 和 Python Debugger。编辑器原有运行按钮的下拉菜单也提供 **在 Micromamba 环境中运行 Python 文件**；此命令使用该环境运行文件并在 Task 终端展示输出。它在当前文件选用了 Micromamba Python 环境时显示，也可从命令面板调用。新建终端默认静默加载该文件夹选定的环境，不再显示激活脚本。

Windows 配置示例（路径应替换为你自己的安装位置）：

```json
{
  "micromamba.executablePath": "D:\\develop\\micromamba\\micromamba.exe",
  "micromamba.rootPrefix": "D:\\develop\\micromamba",
  "micromamba.autoActivateTerminal": true,
  "python.useEnvironmentsExtension": true
}
```

留空时依次检查 `MAMBA_EXE`、`PATH`、`MAMBA_ROOT_PREFIX` 下的常见位置。根目录也可从 `micromamba info --json` 获取。路径支持 `~`、`${env:变量名}` 和 `%变量名%`。只有 PowerShell 函数而没有加入 PATH 的 micromamba，需要配置实际的 `.exe` 路径。

## 功能

- 独立侧边栏：环境、Python 版本、项目当前选择；展开环境后按需读取软件包，标记 pip 软件包。
- 创建命名环境、指定 Python 版本、选择初始软件包；导入 `environment.yml`；导出完整 YAML 或 Conda 安装历史。
- 通过 Micromamba 安装 / 卸载 Conda 软件包、更新全部 Conda 软件包；通过该环境的 `python -m pip` 安装 / 卸载 PyPI 软件包。
- 向 Microsoft Python Environments 扩展注册环境和软件包管理器，因此在官方环境面板和解释器选择器中也能看到 micromamba 环境；环境管理器显示为图标和 **Micromamba**。
- 使用官方 `setEnvironment` API 为项目选择解释器。
- 同一个解释器的环境对象和 ID 在读取 / 刷新时保持稳定；等官方选择流程提交后，再通过 Python 扩展公开的 `updateActiveEnvironmentPath` API 同步旧接口缓存。Python 不带资源路径的校验查询可回退到当前项目选择。
- 官方运行流程的 `activatedRun` 使用 `micromamba run --prefix … <python>`，让运行时带上该环境的变量和动态库路径。
- 原有运行下拉菜单中的 Micromamba 命令也通过 `micromamba run` 启动真实解释器，使用 VS Code Task 面板展示输出；工作目录为文件所在的工作区根目录，无工作区时为文件目录。
- 对未显式指定解释器的 Python **launch** 调试配置补充解释器和激活环境变量；用户在 `launch.json` 中填写的 `python` / `pythonPath` 和 `env` 优先。
- 新建终端默认通过 VS Code 的环境变量集合注入 `micromamba run` 得到的激活变量和 PATH，按工作区文件夹区分环境；不发送激活命令，也不清屏或删除历史。也可手动打开激活终端、激活现有终端。
- 项目选择保存在 VS Code 工作区状态中，不把机器路径写入项目设置。切换到其他提供者的解释器后会停止使用旧的 Micromamba 选择自动激活终端。

创建 / 安装操作显示进度和实时日志，可以取消。同一环境的修改会排队；删除环境和卸载软件包需要在插件界面确认，base 根目录禁止删除。取消不能撤销 micromamba 已经完成的部分更改。

软件包输入以空格分隔，例如 `numpy pandas>=2 conda-forge::scipy`；版本区间的逗号属于同一个规格，例如 `numpy>=1.26,<3`。pip 可使用 `requests[socks]`。暂不支持在输入框里传入任意 pip 参数、URL 或 requirements 文件。

## 设置

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `micromamba.executablePath` | 空 | micromamba 可执行文件的完整路径 |
| `micromamba.rootPrefix` | 空 | 环境根目录 |
| `micromamba.channels` | `["conda-forge"]` | 创建 / Conda 安装和更新使用的频道；同时尊重 micromamba 自身配置 |
| `micromamba.autoActivateTerminal` | `true` | 自动激活新建普通终端 |
| `micromamba.terminalActivationMode` | `silent` | `silent` 在进程启动前注入变量；`command` 使用原来的 shell hook / 激活命令 |
| `micromamba.terminalActivationDelay` | `1500` | 命令模式或手动激活时，没有 shell integration 的启动等待时间，单位毫秒 |
| `micromamba.commandTimeout` | `60` | 只读命令超时，单位秒；修改操作不设此超时 |

## 本地开发

```powershell
npm install
npm run check
npm test
npm run package
```

使用 Node.js 22.21.1+。打包前会编译 TypeScript，VSIX 输出到 `dist/`。如果 nvm 的活动版本只在新会话中生效，先重启 VS Code 或运行 `nvm use 24.21.0`。

在 VS Code 打开本项目后按 **F5**，选择“运行 Micromamba 插件”。VS Code 会先编译，再打开单独的 **Extension Development Host** 窗口；这是运行开发版插件的窗口。在里面打开一个 Python 项目，测试侧边栏、解释器和终端。

源码导览：

| 文件 | 职责 |
| --- | --- |
| `package.json` | 插件声明、命令、侧边栏、菜单、设置和依赖 |
| `src/extension.ts` | 插件入口和用户操作流程 |
| `src/micromamba.ts` | 定位 micromamba、执行 CLI、读取环境和软件包、串行修改 |
| `src/pythonBridge.ts` | 官方环境 / 软件包管理器、解释器选择、运行信息、调试配置 |
| `src/selection.ts` | 按项目持久化选择 |
| `src/tree.ts` | 侧边栏树形视图 |
| `src/terminals.ts` | shell 识别、启动等待、终端激活 |
| `src/core.ts`、`src/process.ts` | 数据解析、参数校验、shell 引号和进程执行 |
| `src/i18n.ts`、`package.nls*.json`、`l10n/` | 本地化适配、静态贡献文字、运行时提示和中英文翻译 |
| `src/test/` | 单元测试、隔离的 Extension Host 集成测试入口 |

增加提示文字时，`package.json` 使用 `%key%` 引用 `package.nls.json` 与对应中文文件；运行时使用 `src/i18n.ts` 的 `t('English message {0}', value)`，同时维护 `l10n/bundle.l10n*.json`。参数使用 `{0}`、`{1}` 等占位符，便于翻译调整词序。品牌名、软件包名、路径、命令 ID 和设置键保持原值。修改 IDE 显示语言后重新加载窗口即可应用文字。

Windows 本机集成测试可执行 `./scripts/test-host.ps1 -Fresh`，它复制已安装的 Python 相关扩展到 `.tools/`，创建没有解释器选择和管理器设置的新项目，使用隔离用户数据检查第一次选择、真实运行 / 调试 / 静默激活，并检查 Python 日志中的解释器告警；不加 `-Fresh` 时使用保留的 `test-workspace/`。`./scripts/test-restore.ps1` 检查关闭并重新打开后恢复选择。测试配置了本机的 `D:\develop\micromamba` 和 `pytorch` 环境，在其他机器上需要先修改测试配置与相应的路径 / 环境断言。详细实测结果见 `VERIFICATION.md`。

## 验证和范围

自动化测试覆盖 JSON 兼容、包来源识别、目录边界、输入校验、shell 引号、无 shell 的进程执行和取消 / 超时。Extension Host 集成测试在隔离的 VS Code 用户数据和测试工作区中检查真实 micromamba 环境注册、软件包列表和 Python 扩展的解释器选择；不会创建、删除或修改现有 Python 环境。

手工验收建议：选择环境后，用 Python 官方运行命令和运行下拉菜单中的 Micromamba 命令执行下面的代码，再在新终端执行 `python -c "import sys; print(sys.executable)"`，三者都应指向选择的环境：

```python
import sys
print(sys.executable)
print(sys.prefix)
```

随后检查 Pylance 能否解析已安装的包，并用 F5 验证调试。如果测试 PyTorch，可执行 `import torch; print(torch.__version__)`。

- 默认静默模式在新终端进程创建前注入环境，Python 和 `CONDA_PREFIX` 指向选定环境；提示符可能不显示 `(环境名)`，也不安装 micromamba 的 shell 函数。需要环境名提示符和 `micromamba activate` / `deactivate` shell 函数时，可把 `micromamba.terminalActivationMode` 设为 `command`，或使用“激活当前终端”命令。环境变量集合支持工作区文件夹作用域；单独的文件级选择不会覆盖整个文件夹的终端环境。已打开的终端需要重新创建才能使用新选择。
- 命令模式在 shell integration 就绪后发送激活命令；没有 integration 时使用可配置的等待时间。已检测到命令执行、任务终端、自定义 PTY 和调试控制台会跳过。没有 integration 时无法可靠判断是否已经输入了半行命令；慢速或自定义 shell 启动时可提高等待时间，或者关闭自动激活后手动激活。
- Microsoft Python Environments 扩展的额外“终端自动激活”行为随版本变化。如果出现重复激活，可将 `python-envs.terminal.autoActivationType` 设为 `off`，保留本插件的自动激活；旧 Python 扩展对应设置为 `python.terminal.activateEnvironment`。
- 若 `python.useEnvironmentsExtension` 被关闭，插件会提供“启用并重新加载”按钮，也可在设置中手动启用。此首版依赖现代 Python Environments API；没有静默退回到仅修改默认解释器路径的模式。
- CMD 路径含 `%` 或双引号时请使用 PowerShell。Linux / macOS 的 shell 命令已做参数引用测试，需要在对应系统完成实机验收。
- 工作区外的 Python 文件使用窗口选择；多文件夹项目优先按终端 cwd / 文件所属工作区匹配。Remote / WSL 环境中，插件和 micromamba 必须运行在同一个远程主机上。虚拟和不受信任工作区不启用此插件。
- Notebook 内核由 Jupyter 扩展管理，首版不保证自动切换已有 Notebook 的内核；请在 Notebook 的内核选择器中选择对应环境。
- Code Runner 等其他扩展有独立的运行配置；这里对接的是 Microsoft Python 的运行 / 调试链路。

## 参考接口

- [Microsoft Python Environments API](https://github.com/microsoft/vscode-python-environments/blob/main/docs/README.md)
- [Micromamba 官方指南](https://mamba.readthedocs.io/en/stable/user_guide/micromamba.html)
- [VS Code 扩展开发文档](https://code.visualstudio.com/api)
