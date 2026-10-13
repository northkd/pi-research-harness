# literature-report

按 `文献汇报+工作汇报_v1.1.pdf` 重建的文献汇报模板骨架。

## 结构

- 7 页固定骨架
- 第 1 页为共享“汇报大纲”
- 第 2-7 页为文献汇报模板页
- 顶部使用 PDF 中的三段导航锚点：
  - `文献信息`
  - `内容与论点` / `内容与论点1` / `内容与论点2`
  - `结论与亮点`

## 使用方式

- 该模板优先提供“讲稿骨架”和“占位提示语”，不提供完整示例论文内容
- 直接替换每页段落、图表占位和列表项即可
- 保留 `index.html + style.css + runtime.js` 的 full-deck 结构

## 文件

```text
templates/full-decks/literature-report/
├── index.html
├── style.css
└── README.md
```

## 版式约束

- 蓝条位置：`top ≈ 14.2%`
- 蓝条高度：`height ≈ 3.07%`
- 页面不覆盖 `assets/base.css` 中 `.slide` 的定位契约
- 不使用封面型 hero、页脚编号、卡片表格等现代化结构
