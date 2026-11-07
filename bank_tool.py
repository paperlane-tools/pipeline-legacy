#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""bank_tool.py —— 查看/搜索/编辑「易智教助手」导出的题库 JSON。

题库文件就是一个普通 JSON：

    {
      "__meta__": { "app": "...", "count": 12, "exportedAt": 1791126445377, ... },
      "q1a2b3c": { "a": "ABD", "q": "交换机接口模式有哪些？", "t": 1, "at": 1791126445321, "src": "learn" }
    }

  - key  ：题库指纹（q=按题干、i/d=按图片哈希、p=按卷子+题号）
  - a    ：答案（多选是 ABD、填空是 a#CSG#b、连线是 1C#2A#3G、简答是那一段正文）
  - q / t：题干（最多 100 字）和题型编号，v1.4.4 起才会写；老的条目没有

用法（在 E:\\yzj-js 下）：
    python scripts/bank_tool.py show  <题库.json>              # 概览 + 列出前 30 条
    python scripts/bank_tool.py show  <题库.json> --all        # 全部列出
    python scripts/bank_tool.py find  <题库.json> 关键词       # 按题干/答案/key 搜
    python scripts/bank_tool.py set   <题库.json> <key> <答案> # 改某一条的答案
    python scripts/bank_tool.py del   <题库.json> <key>        # 删某一条
    python scripts/bank_tool.py to-csv <题库.json> <out.csv>   # 转成 Excel 能开的 CSV
    python scripts/bank_tool.py from-csv <in.csv> <题库.json>  # CSV 改完写回 JSON（按 key 更新答案）
    python scripts/bank_tool.py check <题库.json>              # 体检：条数/题型分布/有无缺题干
"""

import csv
import json
import os
import sys

TYPE_NAME = {0: "单选", 1: "多选", 2: "判断", 3: "填空", 4: "主观/问答", 5: "视听/代码", 6: "连线", 7: "排序"}


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save(path, data):
    # 备份一份再写，改坏了还能回去
    if os.path.exists(path):
        bak = path + ".bak"
        with open(bak, "w", encoding="utf-8") as fh:
            json.dump(load(path), fh, ensure_ascii=False, indent=1)
        print("（原文件已备份到 %s）" % bak)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)


def entries(data):
    """去掉 __meta__，按写入时间倒序返回 (key, 条目)"""
    rows = [(k, v) for k, v in data.items() if not k.startswith("__") and isinstance(v, dict)]
    rows.sort(key=lambda kv: kv[1].get("at") or 0, reverse=True)
    return rows


def fmt(k, v):
    t = TYPE_NAME.get(v.get("t"), v.get("t", ""))
    desc = v.get("q") or "（这条没记题干：老数据，或图片版试卷）"
    return "%-14s %-8s %-46s → %s" % (k[:14], t, desc[:44], str(v.get("a", ""))[:40].replace("\n", " "))


def cmd_show(data, args):
    rows = entries(data)
    meta = data.get("__meta__") or {}
    print("共 %d 条" % len(rows))
    if meta:
        print("  导出时间：%s　来自账号：%s" % (meta.get("exportedAt", "-"), meta.get("account") or "-"))
    with_text = sum(1 for _, v in rows if v.get("q"))
    print("  已记录题干：%d 条（其余的只能看 key，是 v1.4.4 之前的旧数据或图片版）" % with_text)
    limit = len(rows) if "--all" in args else 30
    print()
    for k, v in rows[:limit]:
        print(" " + fmt(k, v))
    if len(rows) > limit:
        print("  …还有 %d 条（加 --all 看全部）" % (len(rows) - limit))


def cmd_find(data, args):
    kw = args[0].lower()
    hits = [(k, v) for k, v in entries(data)
            if kw in k.lower() or kw in str(v.get("q", "")).lower() or kw in str(v.get("a", "")).lower()]
    print("命中 %d 条" % len(hits))
    for k, v in hits:
        print(" " + fmt(k, v))


def cmd_set(data, args):
    key, answer = args[0], args[1]
    if key not in data:
        print("没有这个 key：%s" % key)
        return 1
    data[key]["a"] = answer
    data[key]["src"] = (data[key].get("src") or "") + "+手动"
    return 0


def cmd_del(data, args):
    key = args[0]
    if key not in data:
        print("没有这个 key：%s" % key)
        return 1
    del data[key]
    return 0


def cmd_to_csv(data, args):
    out = args[0]
    rows = [["key", "题型", "题干", "答案", "写入时间", "来源"]]
    for k, v in entries(data):
        rows.append([k, TYPE_NAME.get(v.get("t"), v.get("t", "")), v.get("q", ""), v.get("a", ""),
                     v.get("at", ""), v.get("src", "")])
    with open(out, "w", encoding="utf-8-sig", newline="") as fh:
        csv.writer(fh).writerows(rows)
    print("已写出 %s（%d 条）" % (out, len(rows) - 1))


def cmd_from_csv(data, args):
    src = args[0]
    changed = 0
    with open(src, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            k = (row.get("key") or "").strip()
            if not k or k not in data:
                continue
            new = (row.get("答案") or "").strip()
            if new and new != data[k].get("a"):
                data[k]["a"] = new
                changed += 1
    print("按 CSV 更新了 %d 条答案" % changed)
    return 0


def cmd_check(data, args):
    rows = entries(data)
    import collections
    dist = collections.Counter(TYPE_NAME.get(v.get("t"), "未标注") for _, v in rows)
    print("总条数：%d" % len(rows))
    print("题型分布：%s" % dict(dist))
    print("缺题干：%d 条" % sum(1 for _, v in rows if not v.get("q")))
    print("缺答案：%d 条" % sum(1 for _, v in rows if not v.get("a")))
    bad = [k for k, v in rows if v.get("a") and not str(v["a"]).strip()]
    if bad:
        print("空白答案：%s" % bad[:5])


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, path, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    if cmd == "to-csv":
        if not rest:
            print("用法：bank_tool.py to-csv <题库.json> <out.csv>")
            return 2
        cmd_to_csv(load(path), rest)
        return 0
    if cmd == "from-csv":
        if not rest:
            print("用法：bank_tool.py from-csv <in.csv> <题库.json>")
            return 2
        data = load(rest[0])
        rc = cmd_from_csv(data, [path])
        save(rest[0], data)
        return rc

    data = load(path)
    if cmd == "show":
        cmd_show(data, rest)
        return 0
    if cmd == "find":
        cmd_find(data, rest)
        return 0
    if cmd == "check":
        cmd_check(data, rest)
        return 0
    if cmd == "set":
        if len(rest) < 2:
            print("用法：bank_tool.py set <题库.json> <key> <答案>")
            return 2
        rc = cmd_set(data, rest)
        if rc == 0:
            save(path, data)
            print("已改：%s → %s" % (rest[0], rest[1]))
        return rc
    if cmd == "del":
        if not rest:
            print("用法：bank_tool.py del <题库.json> <key>")
            return 2
        rc = cmd_del(data, rest)
        if rc == 0:
            save(path, data)
            print("已删除：%s" % rest[0])
        return rc
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
