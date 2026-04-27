#!/usr/bin/env node
// 파밍 효율 분석 — captures/samples/<server>/game/GET_report_*에서 데이터 추출
// 마을별/방향별/거리별 효율 집계

const fs = require('fs');
const path = require('path');

const SERVER = process.argv[2] || 'en155';
const DIR = path.join(__dirname, 'samples', SERVER, 'game');
const DATA_FILE = path.join(__dirname, 'data', `reports-${SERVER}.jsonl`);

function loadAll(subdir) {
    const p = path.join(DIR, subdir);
    if (!fs.existsSync(p)) return [];
    return fs.readdirSync(p)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(p, f), 'utf8')));
}

// 누적 수집된 보고서 (lib/report-collector.js가 저장)
function loadAccumulated() {
    if (!fs.existsSync(DATA_FILE)) return [];
    const out = [];
    for (const l of fs.readFileSync(DATA_FILE, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { out.push(JSON.parse(l)); } catch {}
    }
    return out;
}

function parseReports(html) {
    const reports = [];
    const rows = html.match(/<tr[^>]*class="[^"]*report-\d+[^"]*"[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
        // 결과 (green/yellow/red dot)
        const resultMatch = row.match(/dots\/(green|yellow|red)\.webp/);
        const result = resultMatch ? resultMatch[1] : 'unknown';

        // 약탈량 (max_loot tooltip 안 — HTML entity로 인코딩됨)
        const lootTooltip = row.match(/max_loot\/[^"]+"\s+title="([^"]+)"/);
        let wood = 0, stone = 0, iron = 0;
        if (lootTooltip) {
            const t = lootTooltip[1]
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const w = t.match(/wood"[^>]*>\s*<\/span>(\d+)/);
            const s = t.match(/stone"[^>]*>\s*<\/span>(\d+)/);
            const i = t.match(/iron"[^>]*>\s*<\/span>(\d+)/);
            if (w) wood = parseInt(w[1]);
            if (s) stone = parseInt(s[1]);
            if (i) iron = parseInt(i[1]);
        }

        // 출발지 → 도착지 좌표
        const labelMatch = row.match(/quickedit-label">\s*([^<]+?)\s*<\/span>/);
        if (!labelMatch) continue;
        const label = labelMatch[1];
        const coords = [...label.matchAll(/\((\d+)\|(\d+)\)/g)].map(m => [parseInt(m[1]), parseInt(m[2])]);
        if (coords.length < 2) continue;
        const [src, dst] = coords;

        // attack vs scout
        const isFarm = row.includes('farm.webp');

        reports.push({ src, dst, wood, stone, iron, total: wood+stone+iron, result, isFarm });
    }
    return reports;
}

// 방향 계산 (8방위)
function direction(src, dst) {
    const dx = dst[0] - src[0];
    const dy = dst[1] - src[1];
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    // 0° = E, 90° = S (TW좌표는 y가 아래)
    if (angle >= -22.5 && angle < 22.5) return 'E';
    if (angle >= 22.5 && angle < 67.5) return 'SE';
    if (angle >= 67.5 && angle < 112.5) return 'S';
    if (angle >= 112.5 && angle < 157.5) return 'SW';
    if (angle >= 157.5 || angle < -157.5) return 'W';
    if (angle >= -157.5 && angle < -112.5) return 'NW';
    if (angle >= -112.5 && angle < -67.5) return 'N';
    return 'NE';
}

function distance(src, dst) {
    const dx = dst[0] - src[0];
    const dy = dst[1] - src[1];
    return Math.sqrt(dx*dx + dy*dy);
}

// 메인 — 누적 보고서 우선, 없으면 capture sample fallback
const accumulated = loadAccumulated();
const reports = accumulated.length > 0
    ? accumulated.map(r => ({ ...r, total: r.wood + r.stone + r.iron }))
    : [
        ...loadAll('GET_report_attack').flatMap(d => parseReports(d.response.body || '')),
        ...loadAll('GET_report_all').flatMap(d => parseReports(d.response.body || '')),
    ];
console.log(`데이터 소스: ${accumulated.length > 0 ? `data/reports-${SERVER}.jsonl (누적 ${accumulated.length}개)` : 'capture samples (제한적)'}`);

// 중복 제거 (좌표 + 약탈량 동일)
const seen = new Set();
const unique = reports.filter(r => {
    const k = `${r.src.join(',')}-${r.dst.join(',')}-${r.total}-${r.result}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
});

console.log(`\n총 보고서: ${reports.length} (중복제거 후: ${unique.length})`);
console.log(`파밍 보고서: ${unique.filter(r => r.isFarm).length}`);

const farms = unique.filter(r => r.isFarm);
if (farms.length === 0) { console.log('파밍 데이터 없음'); process.exit(0); }

// === 1. 마을별 (좌표별) 효율 ===
const byVillage = {};
for (const r of farms) {
    const key = `${r.dst[0]}|${r.dst[1]}`;
    if (!byVillage[key]) byVillage[key] = { coords: r.dst, attacks: 0, totalLoot: 0, victories: 0 };
    byVillage[key].attacks++;
    byVillage[key].totalLoot += r.total;
    if (r.result === 'green') byVillage[key].victories++;
}

const villages = Object.entries(byVillage)
    .map(([k, v]) => ({
        coords: k,
        attacks: v.attacks,
        totalLoot: v.totalLoot,
        avgLoot: v.totalLoot / v.attacks,
        victoryRate: v.victories / v.attacks * 100,
    }))
    .filter(v => v.totalLoot > 0)  // 약탈량 0 제외 (스카웃 등)
    .sort((a, b) => b.avgLoot - a.avgLoot);

console.log(`\n=== 마을별 효율 TOP 10 (1회 평균 약탈량 기준) ===`);
console.log('좌표\t\t공격\t총약탈\t평균\t승률');
for (const v of villages.slice(0, 10)) {
    console.log(`${v.coords}\t\t${v.attacks}\t${v.totalLoot}\t${Math.round(v.avgLoot)}\t${v.victoryRate.toFixed(0)}%`);
}

console.log(`\n=== 마을별 비효율 BOTTOM 5 ===`);
for (const v of villages.slice(-5)) {
    console.log(`${v.coords}\t\t${v.attacks}\t${v.totalLoot}\t${Math.round(v.avgLoot)}\t${v.victoryRate.toFixed(0)}%`);
}

// === 2. 방향별 ===
const SOURCE = farms[0].src; // 우리 마을 (가정: 첫 보고서의 source)
console.log(`\n=== 방향별 효율 (기준 마을: ${SOURCE.join('|')}) ===`);
const byDir = {};
for (const r of farms) {
    const dir = direction(r.src, r.dst);
    if (!byDir[dir]) byDir[dir] = { attacks: 0, totalLoot: 0 };
    byDir[dir].attacks++;
    byDir[dir].totalLoot += r.total;
}
const dirs = Object.entries(byDir)
    .map(([d, v]) => ({ dir: d, attacks: v.attacks, totalLoot: v.totalLoot, avgLoot: v.totalLoot / v.attacks }))
    .sort((a, b) => b.avgLoot - a.avgLoot);
console.log('방향\t공격\t총약탈\t평균/회');
for (const d of dirs) {
    console.log(`${d.dir}\t${d.attacks}\t${d.totalLoot}\t${Math.round(d.avgLoot)}`);
}

// === 3. 거리별 ===
console.log(`\n=== 거리 구간별 효율 ===`);
const buckets = { '0-3': [], '3-5': [], '5-8': [], '8-12': [], '12+': [] };
for (const r of farms) {
    const d = distance(r.src, r.dst);
    if (d < 3) buckets['0-3'].push(r);
    else if (d < 5) buckets['3-5'].push(r);
    else if (d < 8) buckets['5-8'].push(r);
    else if (d < 12) buckets['8-12'].push(r);
    else buckets['12+'].push(r);
}
console.log('거리\t공격\t총약탈\t평균/회');
for (const [k, arr] of Object.entries(buckets)) {
    if (arr.length === 0) continue;
    const total = arr.reduce((s, r) => s + r.total, 0);
    console.log(`${k}\t${arr.length}\t${total}\t${Math.round(total / arr.length)}`);
}

// === 4. 전체 통계 ===
console.log(`\n=== 전체 ===`);
const totalLoot = farms.reduce((s, r) => s + r.total, 0);
const victoryRate = farms.filter(r => r.result === 'green').length / farms.length * 100;
console.log(`총 파밍 공격: ${farms.length}`);
console.log(`총 약탈량: ${totalLoot} (목+돌+철 합)`);
console.log(`평균/회: ${Math.round(totalLoot / farms.length)}`);
console.log(`승률: ${victoryRate.toFixed(1)}%`);
console.log(`고유 마을: ${villages.length}`);
