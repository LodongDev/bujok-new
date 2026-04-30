#!/usr/bin/env node
// 파밍 전략 분석 — 좌표 거리 기반
const fs = require('fs');
const path = require('path');

const SERVER = process.argv[2] || 'en155';
const SRC_X = 523, SRC_Y = 565; // 출발 마을 좌표 (캡처 검증)

function loadReports() {
    const f = path.join(__dirname, 'data', `reports-${SERVER}.jsonl`);
    if (!fs.existsSync(f)) return [];
    const out = [];
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
            const r = JSON.parse(l);
            if (r.isFarm !== false) out.push({ ...r, total: (r.wood||0) + (r.stone||0) + (r.iron||0) });
        } catch {}
    }
    return out;
}

function distance(x, y) {
    return Math.sqrt((x - SRC_X) ** 2 + (y - SRC_Y) ** 2);
}

// 경기병 속도 = 10분/필드 (TW Casual 기준 — 캡처에서 확인 필요하지만 일반값)
// 실제로 우리 거리(필드) → 분 변환 = 거리 × 10
function travelMin(fields, speedMinPerField = 10) {
    return fields * speedMinPerField;
}

const reports = loadReports();
console.log(`보고서 ${reports.length}건 분석\n`);

if (reports.length === 0) {
    console.log('데이터 없음');
    process.exit(0);
}

// 마을(좌표)별 통계 + 거리 계산
const byVillage = {};
for (const r of reports) {
    const k = `${r.dst[0]}|${r.dst[1]}`;
    if (!byVillage[k]) {
        const fields = distance(r.dst[0], r.dst[1]);
        byVillage[k] = {
            coords: r.dst,
            fields,
            travelMin: travelMin(fields),
            attacks: 0,
            totalLoot: 0,
            wins: 0,
        };
    }
    byVillage[k].attacks++;
    byVillage[k].totalLoot += r.total;
    if (r.result === 'green') byVillage[k].wins++;
}

const villages = Object.values(byVillage);
console.log(`고유 타겟: ${villages.length}개\n`);

// === 거리 구간별 ===
console.log('=== 거리 구간별 (편도 시간 = 필드 × 10분) ===');
console.log('구간\t\t마을수\t총공격\t총약탈\t회당평균\t시간당loot/마을');
const buckets = {
    '0-3분 (필드<0.3)': v => v.travelMin < 3,
    '3-10분 (0.3-1)': v => v.travelMin >= 3 && v.travelMin < 10,
    '10-30분 (1-3)': v => v.travelMin >= 10 && v.travelMin < 30,
    '30-60분 (3-6)': v => v.travelMin >= 30 && v.travelMin < 60,
    '60-120분 (6-12)': v => v.travelMin >= 60 && v.travelMin < 120,
    '120분+ (12+)': v => v.travelMin >= 120,
};
for (const [name, fn] of Object.entries(buckets)) {
    const subset = villages.filter(fn);
    if (subset.length === 0) continue;
    const totalAttacks = subset.reduce((s, v) => s + v.attacks, 0);
    const totalLoot = subset.reduce((s, v) => s + v.totalLoot, 0);
    const avg = totalLoot / totalAttacks;
    const avgRoundtrip = subset.reduce((s, v) => s + v.travelMin * 2, 0) / subset.length;
    const lootPerHourPerVillage = (60 / avgRoundtrip) * avg;
    console.log(`${name}\t${subset.length}\t${totalAttacks}\t${totalLoot}\t${Math.round(avg)}\t\t${Math.round(lootPerHourPerVillage)}`);
}

// === 거리 임계 시뮬레이션 ===
console.log(`\n=== 거리 임계별 시간당 총 loot (해당 마을들로만 farming 시) ===`);
console.log('편도 임계(분)\t포함마을수\t시간당총loot\t1마을당평균\t상대효율');
let baselineLoot = 0;
const sims = [];
for (const limit of [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 9999]) {
    const subset = villages.filter(v => v.travelMin <= limit);
    if (subset.length === 0) continue;
    let total = 0;
    for (const v of subset) {
        const avg = v.totalLoot / v.attacks;
        const roundtripMin = v.travelMin * 2;
        if (roundtripMin === 0) continue;
        total += (60 / roundtripMin) * avg;
    }
    sims.push({ limit, count: subset.length, total });
}
const maxTotal = Math.max(...sims.map(s => s.total));
for (const s of sims) {
    const pct = (s.total / maxTotal * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(s.total / maxTotal * 30));
    const limitStr = s.limit === 9999 ? '∞ (전부)' : s.limit + '분';
    console.log(`${limitStr}\t\t${s.count}\t\t${Math.round(s.total)}\t\t${Math.round(s.total / s.count)}\t\t${pct}% ${bar}`);
}

// === 최적 임계 찾기 ===
const optimalLimit = sims.reduce((best, s) => s.total > best.total ? s : best, sims[0]);
console.log(`\n=== 💡 결론 ===`);
console.log(`최적 임계: 편도 ${optimalLimit.limit === 9999 ? '제한 없음' : optimalLimit.limit + '분'}`);
console.log(`그 안에 포함된 ${optimalLimit.count}개 마을이 시간당 ${Math.round(optimalLimit.total)} loot 생성`);

// 효율 차이
const sub5 = sims.find(s => s.limit === 5);
const sub30 = sims.find(s => s.limit === 30);
const subInf = sims.find(s => s.limit === 9999);
if (sub5 && sub30 && subInf) {
    console.log(`\n비교:`);
    console.log(`- 5분 이내 (${sub5.count}개): 시간당 ${Math.round(sub5.total)}`);
    console.log(`- 30분 이내 (${sub30.count}개): 시간당 ${Math.round(sub30.total)}`);
    console.log(`- 제한 없음 (${subInf.count}개): 시간당 ${Math.round(subInf.total)}`);
    if (sub30.total > subInf.total * 0.95) {
        console.log(`→ 30분 넘는 마을은 거의 효과 없음 (제한 없음과 차이 ${Math.round((subInf.total - sub30.total)/subInf.total * 100)}%)`);
    }
}

// === 가까운 마을 TOP 10 ===
console.log(`\n=== 🎯 추천 — 거리 가까운 + loot 좋은 마을 TOP 10 ===`);
const scored = villages.map(v => ({
    ...v,
    avgLoot: v.totalLoot / v.attacks,
    score: ((v.totalLoot / v.attacks) * (60 / (v.travelMin * 2 || 1))),
})).filter(v => v.travelMin > 0)
   .sort((a, b) => b.score - a.score);
console.log('좌표\t\t거리(필드)\t편도(분)\t평균loot\t시간당loot');
for (const v of scored.slice(0, 10)) {
    console.log(`${v.coords.join('|')}\t\t${v.fields.toFixed(1)}\t\t${v.travelMin.toFixed(1)}\t\t${Math.round(v.avgLoot)}\t\t${Math.round(v.score)}`);
}
