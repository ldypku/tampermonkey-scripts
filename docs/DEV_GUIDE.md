# Developer Guide

## 开发环境

1. 克隆仓库
   ```bash
   git clone https://github.com/ldypku/tampermonkey-scripts.git
   cd tampermonkey-scripts
   ```

2. 本地服务器（测试用）
   ```bash
   python -m http.server 8765
   ```
   访问 `http://localhost:8765/` 查看目录

## 添加新脚本

1. 在 `scripts/` 下创建目录结构
   ```
   scripts/<category>/<script-name>/
   └── index.user.js
   ```

2. 测试无误后，复制到 `dist/` 目录
   ```bash
   cp scripts/<category>/<script-name>/index.user.js dist/<script-name>.user.js
   ```

3. 在 Tampermonkey 中通过 `http://localhost:8765/dist/<script-name>.user.js` 安装

## 发布流程

```bash
# 开发修改
git add .
git commit -m "描述"
git push
```

## 目录约定

| 目录 | 用途 |
|------|------|
| scripts/ | 源码 |
| dist/ | 发布版本 |
| backup/ | Tampermonkey 导出备份 |
| docs/ | 文档 |
| meta/ | 头部模板 |

## 分类

- `reading/` - 阅读类
- `video/` - 视频类
- `forum/` - 论坛类
- `common/` - 通用工具