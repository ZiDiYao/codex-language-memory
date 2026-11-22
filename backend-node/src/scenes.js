import { collapseWhitespace, normalized, nfkc } from './parity.js';

export function uniqueScenes(values) {
  const result = [], seen = new Set();
  for (const value of values) {
    const label = collapseWhitespace(nfkc(value)), key = normalized(label);
    if (!seen.has(key)) { seen.add(key); result.push(label); }
  }
  return result;
}
export function inferScenes(point) {
  let title = normalized(point.title || ''), meaning;
  if (point.note !== null && point.note !== undefined) {
    const lines = point.note.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).map(collapseWhitespace).filter(Boolean);
    if (!lines.length) return [];
    title = normalized(lines[0]); meaning = normalized(lines.slice(1).join(' '));
  } else {
    const examples = typeof point.examples === 'string' ? JSON.parse(point.examples || '[]') : point.examples || [];
    meaning = normalized([
      ...['meaning', 'sense_key', 'context', 'explanation'].map(key => point[key] || ''),
      ...examples.map(example => (example.text || '') + ' ' + (example.translation || '')),
    ].join(' '));
  }
  if (!['word', 'expression'].includes(point.kind)) return [];
  if (['sneeze','sneezing','cough','coughing','fart','farting','burp','hiccup','打喷嚏','咳嗽','放屁','打嗝'].includes(title)) {
    if (['hiccup','打嗝'].includes(title) && /problem|fault|obstacle|setback|故障|问题|障碍|波折/u.test(meaning)) return [];
    return ['Body reactions'];
  }
  if (['turn on','turn off','switch on','switch off','plug in','unplug'].includes(title)) {
    if (/arous|excit|attract|repel|road|highway|attack|反感|兴奋|吸引|主路|公路|转弯|攻击/u.test(meaning)) return [];
    return /device|light|lamp|switch|power|electri|appliance|engine|computer|screen|tap|faucet|打开|关闭|开关|接通|启动|开启|电源|设备/u.test(meaning) ? ['Device controls'] : [];
  }
  if (['rinse','rinse off','rinse out','scrub','lather','wipe','wipe down','gargle','floss','wash hands','wash your hands','brush teeth','brush your teeth','冲洗','擦拭','漱口'].includes(title)) return ['Cleaning & hygiene'];
  if (title === 'rub' && !/problem|difficult|annoy|idiom|massage|sore|难题|困难|惹恼|习语|按摩|酸痛/u.test(meaning) && /wash|clean|soap|lather|hygiene|擦洗|揉搓|清洁|肥皂|洗手|搓洗/u.test(meaning)) return ['Cleaning & hygiene'];
  return [];
}
