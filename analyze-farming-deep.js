#!/usr/bin/env node
// 깊이 분석 — 모든 캡처 + 누적 데이터 + 공격 빈도 결합
const fs = require('fs');
const path = require('path');

const SERVER = process.argv[2] || 'en155';
const DIR = path.join(__dirname, 'samples', SERVER, 'game');
const ACC = path.join(__dirname, 'data', `reports-${SERVER}.jsonl`);

function listAll(subdir) {
    const p = path.join(DIR, subdir);
    if (!fs.existsSync(p)) return [];
    return fs.readdirSync(p).filter(f => f.endsWith('.json')).map(f => path.join(p, f));
}

function loadJSON(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// HTML 어디서든 max_loot tooltip 찾아서 보고서 추출
function extractReports(html) {
    const reports = [];
    if (!html) return reports;
    // report row 찾기: report-XXX class
    const rows = html.match(/<tr[^>]*class="[^"]*report-(\d+)[^"]*"[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
        const idM = row.match(/report-(\d+)/);
        if (!idM) continue;
        const id = idM[1];

        const dot = row.match(/dots\/(\w+)\.webp/);
        const result = dot ? dot[1] : null;

        const lootImg = row.match(/max_loot\/[^"]+"\s+title="([^"]+)"/);
        let wood = 0, stone = 0, iron = 0;
        if (lootImg) {
            const t = lootImg[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const w = t.match(/wood"[^>]*>\s*<\/span>(\d+)/);
            const s = t.match(/stone"[^>]*>\s*<\/span>(\d+)/);
            const i = t.match(/iron"[^>]*>\s*<\/span>(\d+)/);
            if (w) wood = +w[1]; if (s) stone = +s[1]; if (i) iron = +i[1];
        }

        const labelM = row.match(/quickedit-label">\s*([^<]+?)\s*<\/span>/);
        if (!labelM) continue;
        const coords = [...labelM[1].matchAll(/\((\d+)\|(\d+)\)/g)].map(m => [+m[1], +m[2]]);
        if (coords.length < 2) continue;

        const isFarm = row.includes('farm.webp');
        reports.push({ id, src: coords[0], dst: coords[1], wood, stone, iron, total: wood+stone+iron, result, isFarm });
    }
    return reports;
}

// 1. 모든 capture 폴더에서 보고서 추출
const allReports = [];
const sampleDirs = ['GET_report_attack', 'GET_report_all', 'GET_report_view', 'GET_report', 'GET_am_farm', 'GET_am_farm_farm'];
let scannedFiles = 0;
for (const dir of sampleDirs) {
    for (const f of listAll(dir)) {
        const d = loadJSON(f);
        if (!d) continue;
        scannedFiles++;
        const reps = extractReports(d.response?.body || '');
        allReports.push(...reps);
    }
}

// 2. 누적 jsonl 파일도 추가
if (fs.existsSync(ACC)) {
    for (const l of fs.readFileSync(ACC, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
            const r = JSON.parse(l);
            allReports.push({ ...r, total: r.wood+r.stone+r.iron, isFarm: r.isFarm !== false });
        } catch {}
    }
}

// 3. 보고서 dedup by id
const seen = new Set();
const reports = allReports.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id); return true;
});

console.log(`스캔한 파일: ${scannedFiles}, 총 보고서(중복제거): ${reports.length}`);

// 4. POST_am_farm_farm으로 공격 빈도 데이터
const farmPosts = listAll('POST_am_farm_farm').map(loadJSON).filter(Boolean);
const attackFreq = {};  // target_village_id → count
for (const d of farmPosts) {
    const body = d.request?.body || d.request?.postData || '';
    const m = body.match(/target=(\d+)/);
    if (m) {
        const tid = m[1];
        attackFreq[tid] = (attackFreq[tid] || 0) + 1;
    }
}
console.log(`총 파밍 시도: ${farmPosts.length} (고유 타겟: ${Object.keys(attackFreq).length})`);

// 5. GET_am_farm에서 마을 ID → 좌표 매핑
const villageCoords = {};
for (const f of listAll('GET_am_farm')) {
    const d = loadJSON(f);
    if (!d) continue;
    const body = d.response?.body || '';
    const rows = body.match(/<tr[^>]*id="village_(\d+)"[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
        const idM = row.match(/village_(\d+)/);
        const coordM = row.match(/\((\d+)\|(\d+)\)/);
        if (idM && coordM) {
            villageCoords[idM[1]] = [+coordM[1], +coordM[2]];
        }
    }
}
console.log(`좌표 매핑된 마을: ${Object.keys(villageCoords).length}`);

const farms = reports.filter(r => r.isFarm);
console.log(`\n파밍 보고서(loot 포함): ${farms.length}`);

if (farms.length === 0 && Object.keys(attackFreq).length === 0) {
    console.log('데이터 없음');
    process.exit(0);
}

// === 분석 ===

// SOURCE = 우리 마을 (보고서 첫번째 src 또는 좌표)
let SOURCE = farms.length > 0 ? farms[0].src : null;
console.log(`기준 마을: ${SOURCE ? SOURCE.join('|') : 'unknown'}`);

const direction = (src, dst) => {
    if (!src) return '?';
    const dx = dst[0] - src[0], dy = dst[1] - src[1];
    const a = Math.atan2(dy, dx) * 180 / Math.PI;
    if (a >= -22.5 && a < 22.5) return 'E';
    if (a >= 22.5 && a < 67.5) return 'SE';
    if (a >= 67.5 && a < 112.5) return 'S';
    if (a >= 112.5 && a < 157.5) return 'SW';
    if (a >= 157.5 || a < -157.5) return 'W';
    if (a >= -157.5 && a < -112.5) return 'NW';
    if (a >= -112.5 && a < -67.5) return 'N';
    return 'NE';
};
const dist = (a, b) => Math.sqrt((b[0]-a[0])**2 + (b[1]-a[1])**2);

// === 마을별 (좌표) ===
const byVillage = {};
for (const r of farms) {
    const k = r.dst.join('|');
    if (!byVillage[k]) byVillage[k] = { coords: r.dst, attacks: 0, totalLoot: 0, victories: 0 };
    byVillage[k].attacks++;
    byVillage[k].totalLoot += r.total;
    if (r.result === 'green') byVillage[k].victories++;
}

const villages = Object.entries(byVillage).map(([k, v]) => ({
    coords: k,
    attacks: v.attacks,
    totalLoot: v.totalLoot,
    avgLoot: v.totalLoot / v.attacks,
    victoryRate: v.victories / v.attacks * 100,
    direction: SOURCE ? direction(SOURCE, v.coords) : '?',
    distance: SOURCE ? dist(SOURCE, v.coords).toFixed(1) : '?',
}));

// 평균 약탈량 기준 정렬
villages.sort((a, b) => b.avgLoot - a.avgLoot);

console.log(`\n=== 🏆 효율 TOP 10 마을 ===`);
console.log('좌표\t\t방향\t거리\t공격\t총약탈\t평균/회');
for (const v of villages.slice(0, 10)) {
    console.log(`${v.coords}\t\t${v.direction}\t${v.distance}\t${v.attacks}\t${v.totalLoot}\t${Math.round(v.avgLoot)}`);
}

console.log(`\n=== ❌ 비효율 BOTTOM 5 ===`);
for (const v of villages.slice(-5).reverse()) {
    console.log(`${v.coords}\t\t${v.direction}\t${v.distance}\t${v.attacks}\t${v.totalLoot}\t${Math.round(v.avgLoot)}`);
}

// === 방향별 ===
const byDir = {};
for (const r of farms) {
    if (!SOURCE) break;
    const d = direction(SOURCE, r.dst);
    if (!byDir[d]) byDir[d] = { attacks: 0, totalLoot: 0 };
    byDir[d].attacks++;
    byDir[d].totalLoot += r.total;
}
const dirs = Object.entries(byDir).map(([d, v]) => ({
    dir: d, attacks: v.attacks, totalLoot: v.totalLoot, avgLoot: v.totalLoot / v.attacks,
})).sort((a, b) => b.avgLoot - a.avgLoot);
console.log(`\n=== 🧭 방향별 효율 ===`);
console.log('방향\t공격\t총약탈\t평균/회');
for (const d of dirs) console.log(`${d.dir}\t${d.attacks}\t${d.totalLoot}\t${Math.round(d.avgLoot)}`);

// === 거리별 ===
const buckets = { '0-3': [], '3-5': [], '5-8': [], '8-12': [], '12+': [] };
for (const r of farms) {
    if (!SOURCE) break;
    const d = dist(SOURCE, r.dst);
    if (d < 3) buckets['0-3'].push(r);
    else if (d < 5) buckets['3-5'].push(r);
    else if (d < 8) buckets['5-8'].push(r);
    else if (d < 12) buckets['8-12'].push(r);
    else buckets['12+'].push(r);
}
console.log(`\n=== 📏 거리 구간별 효율 ===`);
console.log('거리\t공격\t총약탈\t평균/회');
for (const [k, arr] of Object.entries(buckets)) {
    if (!arr.length) continue;
    const t = arr.reduce((s, r) => s + r.total, 0);
    console.log(`${k}\t${arr.length}\t${t}\t${Math.round(t / arr.length)}`);
}

// === 공격 빈도 (자주 공격한 마을 = 자동화가 우선시한 마을) ===
console.log(`\n=== 🎯 가장 자주 공격한 마을 TOP 15 (POST_am_farm_farm) ===`);
const freq = Object.entries(attackFreq).map(([id, count]) => ({
    id, count, coords: villageCoords[id],
})).sort((a, b) => b.count - a.count);
console.log('마을ID\t좌표\t\t방향\t거리\t공격수');
for (const f of freq.slice(0, 15)) {
    const c = f.coords;
    const d = c && SOURCE ? direction(SOURCE, c) : '?';
    const ds = c && SOURCE ? dist(SOURCE, c).toFixed(1) : '?';
    console.log(`${f.id}\t${c ? c.join('|') : '???'}\t${d}\t${ds}\t${f.count}`);
}

// === 전체 통계 ===
console.log(`\n=== 📊 전체 ===`);
const totalLoot = farms.reduce((s, r) => s + r.total, 0);
const winRate = farms.length > 0 ? farms.filter(r => r.result === 'green').length / farms.length * 100 : 0;
console.log(`총 파밍 시도 (POST 기록): ${farmPosts.length}`);
console.log(`결과 보고서 (loot 데이터): ${farms.length}`);
console.log(`총 약탈량 (보고서 기준): ${totalLoot}`);
if (farms.length > 0) console.log(`평균/회: ${Math.round(totalLoot / farms.length)}`);
console.log(`승률: ${winRate.toFixed(1)}%`);
console.log(`고유 타겟 (공격 기록): ${Object.keys(attackFreq).length}개`);
console.log(`고유 타겟 (보고서): ${villages.length}개`);

console.log(`\n💡 추천`);
if (villages.length >= 3) {
    const top3 = villages.slice(0, 3);
    console.log(`- 우선 공격: ${top3.map(v => v.coords).join(', ')}`);
}
const skip = villages.filter(v => v.avgLoot < 20);
if (skip.length) {
    console.log(`- 제외 권장 (평균<20): ${skip.map(v => v.coords).join(', ')}`);
}
if (dirs.length >= 2) {
    console.log(`- 효율 좋은 방향: ${dirs.slice(0, 2).map(d => d.dir).join(', ')}`);
    console.log(`- 효율 나쁜 방향: ${dirs.slice(-2).map(d => d.dir).join(', ')}`);
}
