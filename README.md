# tampermonkey-scripts

Tampermonkey 脚本源码库 - 可维护、可版本管理、可同步

## 目录结构

```
tampermonkey-scripts/
├── scripts/               # 脚本源码（核心开发）
│   ├── reading/          # 阅读类脚本
│   │   └── reader-enhancer/
│   │       ├── index.user.js      # 入口脚本
│   │       └── AutoScroll*.js     # 自动滚动
│   ├── video/            # 视频类脚本
│   │   └── video-downloader/
│   └── common/           # 通用工具库（待建设）
├── dist/                 # 构建后的发布版本
├── backup/               # Tampermonkey 导出备份
├── docs/                 # 文档
├── meta/                 # 统一元信息模板
└── README.md
```

## 脚本说明

### reading/reader-enhancer
通用阅读增强脚本，包含：
- 单滚动条阅读模式
- 连续阅读（自动翻页）
- 手选正文区域
- 字体/宽度调整
- 章节缓存
- 导出 md/txt

### video/video-downloader
视频下载工具

## 工作流

1. **开发**: 修改 `scripts/` 下的源码
2. **测试**: 在 Tampermonkey 中加载测试
3. **发布**: 手动复制到 `dist/` 目录
4. **备份**: 定期导出 Tampermonkey 到 `backup/`

## 同步

- Git: 源码同步到 GitHub/Gitee
- Tampermonkey 内置同步或 WebDAV