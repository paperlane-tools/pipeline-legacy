import re
import sys

path = sys.argv[1]
t = open(path, encoding="utf-8", errors="replace").read()

for needle in sys.argv[2:]:
    idx = t.find(needle)
    print("=== %s @ %d ===" % (needle, idx))
    if idx >= 0:
        print(t[max(0, idx - 600): idx + 600].replace("\n", " "))
    print()

print("=== url-ish strings ===")
for m in sorted(set(re.findall(r'["\'](/[A-Za-z0-9_/\-\.]{4,90})["\']', t))):
    print(m)
