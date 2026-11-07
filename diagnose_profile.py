"""diagnose_profile.py —— 看一眼 Chrome 配置到底还在不在（只读，不改任何东西）

用法：python scripts\\diagnose_profile.py [User Data 路径]
"""

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def jload(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return json.load(fh)
    except Exception as exc:
        return {"__error__": str(exc)}


def main():
    ud = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    print("User Data:", ud, "存在" if os.path.isdir(ud) else "不存在")
    if not os.path.isdir(ud):
        return

    print("\n== 有哪些 profile ==")
    for name in os.listdir(ud):
        full = os.path.join(ud, name)
        if os.path.isdir(full) and (name == "Default" or name.startswith("Profile ") or name == "Guest Profile"):
            print(f"  {name:<14} 修改于 {os.path.getmtime(full):.0f}")

    local_state = jload(os.path.join(ud, "Local State"))
    print("\n== 登录（Google 账号）==")
    ai = local_state.get("account_info") or []
    print("  Local State account_info:", ai if ai else "空（没登录 Google 账号）")
    cache = (local_state.get("profile") or {}).get("info_cache") or {}
    print("  profile 数量:", len(cache))
    for key, val in cache.items():
        print(f"    {key:<12} name={val.get('name')!r} gaia={val.get('gaia_name') or val.get('user_name') or '-'}")

    prof = os.path.join(ud, "Default")
    prefs = jload(os.path.join(prof, "Preferences"))
    print("\n== Default 配置 ==")
    print("  profile.name:", (prefs.get("profile") or {}).get("name"))
    print("  signin 段:", json.dumps(prefs.get("signin", {}), ensure_ascii=False)[:200])
    settings = ((prefs.get("extensions") or {}).get("settings")) or {}
    print("  Preferences 里记录的扩展数:", len(settings))
    for ext_id, cfg in list(settings.items())[:20]:
        print(f"    {ext_id}  state={cfg.get('state')}  name={(cfg.get('manifest') or {}).get('name')}")

    ext_dir = os.path.join(prof, "Extensions")
    print("\n== 磁盘上的扩展目录 ==")
    if os.path.isdir(ext_dir):
        print("  Extensions 修改时间:", f"{os.path.getmtime(ext_dir):.0f}")
        for d in os.listdir(ext_dir):
            sub = os.path.join(ext_dir, d)
            vers = os.listdir(sub) if os.path.isdir(sub) else []
            name = "-"
            for v in vers:
                man = os.path.join(sub, v, "manifest.json")
                if os.path.isfile(man):
                    try:
                        name = json.load(open(man, encoding="utf-8", errors="replace")).get("name", "-")
                    except Exception:
                        pass
            print(f"    {d}  {vers}  name={name}")
    else:
        print("  Extensions 目录不存在")


if __name__ == "__main__":
    main()
