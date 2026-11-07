# pipeline-legacy · 早期验证流水线

> **状态：早期验证版本，不是主推项目。**
> 这是最早用 Python + Playwright + OCR 跑通「识图 → AI 判题 → 交卷」的验证流水线，
> 用来证明整条链路可行。日常使用请用 [quiz-helper](https://github.com/paperlane-tools/quiz-helper)。

> **适用平台：易智教云课堂（`csgmooc.com`）**
> 只对接该平台的接口与页面。

---

## 它是什么

一组命令行脚本，把一套图片版试卷从下载到交卷跑完：

```
fetch    拉任务 / 下载试卷图片
ocr      RapidOCR 离线识图（放大 3 倍）
parse    按坐标还原题目结构
solve    AI 判题（DeepSeek 等）
submit   写答案并交卷
verify   回读官方批改
report   生成中文报告
```

## 为什么不是主推

- 需要自己维护浏览器会话与登录态（`get_session.mjs`）。
- 依赖较多：Python 的 `requests / rapidocr_onnxruntime / cv2 / PIL`，以及 Node + Playwright。
- 主要覆盖图片版试卷；文字题、连线题、主观题的分支不如用户脚本完整。
- 主推的 [quiz-helper] 是单文件用户脚本：安装简单、本地题库、多 AI 服务商、
  延迟提交、无人值守、跳过规则都更成熟。

## 保留价值

- 识图 + 坐标还原的参考实现（`ocr_rapid.py` / `upscale.py` / `parse`）。
- 站点接口、交卷、批改核对的参考（`paper_pipeline.py` / `finalize.mjs` / `verify`）。
- 离线单测与对拍（`test_logic.mjs` / `des_check.mjs`）。

## 文件

| 文件 | 作用 |
|---|---|
| `paper_pipeline.py` | 主流水线 |
| `get_session.mjs` / `browser.mjs` | 取会话 / 管理项目自己的浏览器 |
| `finalize.mjs` | 交卷 |
| `ocr_rapid.py` / `upscale.py` | 识图 |
| `test_logic.mjs` | 油猴脚本离线单测 |
| `des_check.mjs` | DES 与站点实现对拍 |

## 项目状态

**仅用于验证，不保证维护。** 结构保留完整，遇到平台改版可能需要自行修。

## 免责声明

本项目仅供**个人学习、技术研究与交流**使用。

- 不保证答案正确、功能完整或持续可用。
- 使用本项目产生的任何后果（包括但不限于账号异常、成绩问题、数据丢失、违反平台或学校规定）由使用者自行承担。
- 请遵守所在学校 / 教育机构及目标平台的服务条款；不要用于商业用途或大规模滥用。
- 本项目与目标平台及其运营方无任何关联，也未获得其授权或认可。
- 若相关权利方认为内容侵犯其权益，请联系删除。

## 许可证

[GPL-3.0-only](LICENSE) © 2026 paperlane-tools；修改版须注明来源（见 [NOTICE](NOTICE)）
