// 서버별 큐 상태 영구 저장 — server.js 재시작 시 동일 서버 자동 재진입하면 복원
// state/<server>.json 형식:
// {
//   scavenge: { villageIds: [...] },
//   market:   { villageIds: [...] },
//   farm:     { villageIds: [...], mode: 'B' },
//   trainer:  { villageIds: [...], plan: [...] },
//   build:    { villageIds: [...] },        // 어떤 마을 큐를 활성화했는지
//   buildPriorities: { [villageId]: [{building, target}] }
// }
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'state');

function file(server) {
    return path.join(DIR, `${server}.json`);
}

function load(server) {
    if (!server) return {};
    try {
        if (!fs.existsSync(file(server))) return {};
        return JSON.parse(fs.readFileSync(file(server), 'utf8')) || {};
    } catch { return {}; }
}

function saveAll(server, data) {
    if (!server) return;
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(server), JSON.stringify(data, null, 2));
}

// key 하나만 갱신/삭제 (value=null이면 삭제)
function setKey(server, key, value) {
    if (!server) return;
    const cur = load(server);
    if (value === null || value === undefined) delete cur[key];
    else cur[key] = value;
    saveAll(server, cur);
}

module.exports = { load, saveAll, setKey };
