"""Small offline defaults; Codex supplies contextual, open-ended scene labels."""

import re
import unicodedata


def scene_key(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def unique_scenes(values):
    result, seen = [], set()
    for value in values:
        label = " ".join(unicodedata.normalize("NFKC", value).split())
        key = scene_key(label)
        if key not in seen:
            result.append(label)
            seen.add(key)
    return result


def infer_scenes(point):
    """Conservative migration/old-client fallback, never a substitute for context.

    Only the learning target is matched: incidental example words must not tag an
    unrelated note. New/custom scenes are accepted without a predefined taxonomy.
    """
    title = scene_key(point.get("title", ""))
    if point.get("note") is not None:
        # Freely edited notes are authoritative; do not resurrect discarded
        # meanings when suggesting groups for an older record.
        lines = [line.strip() for line in point["note"].splitlines() if line.strip()]
        if not lines:
            return []
        title, meaning = scene_key(lines[0]), scene_key(" ".join(lines[1:]))
    else:
        examples = point.get("examples") or []
        if isinstance(examples, str):
            import json
            examples = json.loads(examples)
        meaning = scene_key(" ".join([
            *(str(point.get(key) or "") for key in ("meaning", "sense_key", "context", "explanation")),
            *(str(example.get("text") or "") + " " + str(example.get("translation") or "") for example in examples),
        ]))
    if point.get("kind") not in {"word", "expression"}:
        return []
    if title in {"sneeze", "sneezing", "cough", "coughing", "fart", "farting", "burp", "hiccup",
                 "打喷嚏", "咳嗽", "放屁", "打嗝"}:
        if title in {"hiccup", "打嗝"} and re.search(r"problem|fault|obstacle|setback|故障|问题|障碍|波折", meaning):
            return []
        return ["Body reactions"]
    if title in {"turn on", "turn off", "switch on", "switch off", "plug in", "unplug"}:
        if re.search(r"arous|excit|attract|repel|road|highway|attack|反感|兴奋|吸引|主路|公路|转弯|攻击", meaning):
            return []
        if re.search(r"device|light|lamp|switch|power|electri|appliance|engine|computer|screen|tap|faucet|打开|关闭|开关|接通|启动|开启|电源|设备", meaning):
            return ["Device controls"]
        return []
    if title in {"rinse", "rinse off", "rinse out", "scrub", "lather", "wipe", "wipe down", "gargle", "floss",
                 "wash hands", "wash your hands", "brush teeth", "brush your teeth", "冲洗", "擦拭", "漱口"}:
        return ["Cleaning & hygiene"]
    if title == "rub":
        if re.search(r"problem|difficult|annoy|idiom|massage|sore|难题|困难|惹恼|习语|按摩|酸痛", meaning):
            return []
        if re.search(r"wash|clean|soap|lather|hygiene|擦洗|揉搓|清洁|肥皂|洗手|搓洗", meaning):
            return ["Cleaning & hygiene"]
    return []
