/** Scene names remain data: one record can belong to several overlapping scenes. */
export function parseScenes(value) {
  const scenes = [];
  const seen = new Set();
  for (const part of value.split(/[,，;；\n]+/u)) {
    const name = part.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!name) continue;
    if ([...name].length > 80) throw new Error("invalidScenes");
    const key = name.toLocaleLowerCase();
    if (!seen.has(key)) { seen.add(key); scenes.push(name); }
  }
  if (scenes.length > 12) throw new Error("invalidScenes");
  return scenes;
}

export function sceneSelection(scenes, current = "") {
  return scenes.some(({ name }) => name === current) ? current : "";
}

export function sceneLabel(name, t) {
  const keys = {
    "Cleaning & hygiene": "sceneCleaning",
    "Device controls": "sceneDevices",
    "Body reactions": "sceneBody",
  };
  return keys[name] ? t(keys[name]) : name;
}
