"""使用 Windows 内置 OCR 引擎识别图片（离线、不依赖任何 AI 模型）。

输出每行的文本与包围盒，便于后续按几何位置还原「题目 / 选项」结构。
"""

import asyncio
import json
import os
import sys

from winsdk.windows.globalization import Language
from winsdk.windows.graphics.imaging import BitmapDecoder
from winsdk.windows.media.ocr import OcrEngine
from winsdk.windows.storage import FileAccessMode, StorageFile


def pick_engine():
    for tag in ("en-US", "en-GB", "en"):
        engine = OcrEngine.try_create_from_language(Language(tag))
        if engine:
            return engine, tag
    engine = OcrEngine.try_create_from_user_profile_languages()
    return engine, "user-profile"


async def ocr(path):
    path = os.path.abspath(path)
    file = await StorageFile.get_file_from_path_async(path)
    stream = await file.open_async(FileAccessMode.READ)
    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    engine, tag = pick_engine()
    if engine is None:
        raise RuntimeError("系统没有可用的 OCR 语言包")
    result = await engine.recognize_async(bitmap)
    lines = []
    for line in result.lines:
        rects = [w.bounding_rect for w in line.words]
        lines.append({
            "text": line.text,
            "x": min(r.x for r in rects),
            "y": min(r.y for r in rects),
            "x2": max(r.x + r.width for r in rects),
            "y2": max(r.y + r.height for r in rects),
        })
    return {"engine": tag, "size": [bitmap.pixel_width, bitmap.pixel_height], "lines": lines}


def main():
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    data = asyncio.run(ocr(path))
    text = "\n".join(f"{l['text']}" for l in data["lines"])
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
    print(f"engine={data['engine']} size={data['size']} lines={len(data['lines'])}")
    print(text[:3000])


if __name__ == "__main__":
    main()
