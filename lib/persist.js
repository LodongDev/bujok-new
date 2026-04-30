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

// 자격증명 저장 (자동 재로그인용) — 로컬 파일, .gitignore에 state/ 제외됨
const CRED_FILE = path.join(DIR, 'credentials.json');
function saveCredentials(username, password) {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CRED_FILE, JSON.stringify({ username, password, savedAt: Date.now() }, null, 2));
}
function loadCredentials() {
    try {
        if (!fs.existsSync(CRED_FILE)) return null;
        return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    } catch { return null; }
}
function clearCredentials() {
    try { if (fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE); } catch {}
}

// 공격 템플릿 저장 (서버별)
function templatesFile(server) { return path.join(DIR, `templates-${server}.json`); }
function loadTemplates(server) {
    if (!server) return [];
    try {
        const f = templatesFile(server);
        if (!fs.existsSync(f)) return [];
        return JSON.parse(fs.readFileSync(f, 'utf8')) || [];
    } catch { return []; }
}
function saveTemplates(server, templates) {
    if (!server) return;
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(templatesFile(server), JSON.stringify(templates || [], null, 2));
}

module.exports = {
    load, saveAll, setKey,
    saveCredentials, loadCredentials, clearCredentials,
    loadTemplates, saveTemplates,
};
