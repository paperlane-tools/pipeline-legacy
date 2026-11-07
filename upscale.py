"""把试卷图片放大若干倍（LANCZOS），用于提升 OCR 对下划线/数字的识别率。"""

import sys

from PIL import Image


def main():
    src, dst, factor = sys.argv[1], sys.argv[2], float(sys.argv[3])
    img = Image.open(src).convert("L")
    w, h = img.size
    out = img.resize((int(w * factor), int(h * factor)), Image.LANCZOS)
    out.save(dst)
    print(f"{src} {w}x{h} -> {dst} {out.size[0]}x{out.size[1]}")


if __name__ == "__main__":
    main()
