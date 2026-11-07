"""RapidOCR 离线识图：输出按阅读顺序排序的文本行 + 坐标框。"""

import json
import sys

from rapidocr_onnxruntime import RapidOCR


def main():
    img = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    engine = RapidOCR()
    result, _ = engine(img)
    lines = []
    for box, text, score in result or []:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lines.append({
            "text": text,
            "score": round(float(score), 3),
            "x": round(min(xs), 1),
            "y": round(min(ys), 1),
            "x2": round(max(xs), 1),
            "y2": round(max(ys), 1),
        })
    lines.sort(key=lambda l: (round(l["y"] / 12), l["x"]))
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(lines, fh, ensure_ascii=False, indent=1)
    print(f"lines={len(lines)}")
    for l in lines:
        print(f"[{l['y']:>7.1f}] {l['text']}")


if __name__ == "__main__":
    main()
