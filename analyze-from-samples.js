#!/usr/bin/env node
// 캡처 샘플에서 직접 loot 데이터 추출하고 거리 분석 (data/reports-*.jsonl 신뢰 안 함)
const fs = require('fs');
const path = require('path');

const SERVER = process.argv[2] || 'en155';
const SRC = [523, 565]; // 출발 마을
const SPEED_MIN_PER_FIELD = 10; // 경기병 (보수 가정)

function dist(x, y) { return Math.sqrt((x - SRC[0])**2 + (y - SRC[1])**2); }

// 모든 GET_report_attack/all 캡처에서 loot+좌표 추출
const baseDir = path.join(__dirname, 'samples', SERVER, 'game');
const reports = [];
const seenIds = new Set();
for (const sub of ['GET_report_attack', 'GET_report_all']) {
    const dir = path.join(baseDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const body = d.response?.body || '';
            const rows = [...body.matchAll(/<tr[^>]*class="[^"]*report-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)];
            for (const rm of rows) {
                const id = rm[1];
                if (seenIds.has(id)) continue;
                seenIds.add(id);
                const html = rm[2];

                // farm 보고서만
                if (!html.includes('farm.webp')) continue;

                // 좌표 (label에서 두 좌표쌍 — src, dst)
                const labelM = html.match(/quickedit-label[^>]*>\s*([^<]+)\s*<\/span>/);
                if (!labelM) continue;
                const coords = [...labelM[1].matchAll(/\((\d+)\|(\d+)\)/g)].map(m => [+m[1], +m[2]]);
                if (coords.length < 2) continue;

                // loot
                const lootM = html.match(/max_loot\/[^"]+"\s+title="([^"]+)"/);
                let wood = 0, stone = 0, iron = 0;
                if (lootM) {
                    const decoded = lootM[1]
                        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
                    const w = decoded.match(/header wood[^>]*>\s*<\/span>(\d+)/);
                    const s = decoded.match(/header stone[^>]*>\s*<\/span>(\d+)/);
                    const i = decoded.match(/header iron[^>]*>\s*<\/span>(\d+)/);
                    if (w) wood = +w[1];
                    if (s) stone = +s[1];
                    if (i) iron = +i[1];
                }

                reports.push({ id, src: coords[0], dst: coords[1], wood, stone, iron, total: wood+stone+iron });
            }
        } catch {}
    }
}

console.log(`샘플에서 추출한 farm 보고서: ${reports.length}개\n`);

// 마을별 통계
const byVillage = {};
for (const r of reports) {
    const k = `${r.dst[0]}|${r.dst[1]}`;
    if (!byVillage[k]) {
        const fields = dist(r.dst[0], r.dst[1]);
        byVillage[k] = {
            coords: r.dst, fields,
            travelMin: fields * SPEED_MIN_PER_FIELD,
            attacks: 0, totalLoot: 0, zeroAttacks: 0,
        };
    }
    byVillage[k].attacks++;
    byVillage[k].totalLoot += r.total;
    if (r.total === 0) byVillage[k].zeroAttacks++;
}

const villages = Object.values(byVillage);
console.log(`고유 타겟: ${villages.length}개\n`);

// 거리 구간별
console.log('=== 거리 구간별 효율 ===');
console.log('구간\t\t\t마을수\t총공격\t총약탈\t평균loot/회\t평균왕복(분)\t시간당loot/마을\t0% 비율');
const bk = [
    ['0-5분', v => v.travelMin < 5],
    ['5-10분', v => v.travelMin >= 5 && v.travelMin < 10],
    ['10-20분', v => v.travelMin >= 10 && v.travelMin < 20],
    ['20-40분', v => v.travelMin >= 20 && v.travelMin < 40],
    ['40-80분', v => v.travelMin >= 40 && v.travelMin < 80],
    ['80-160분', v => v.travelMin >= 80 && v.travelMin < 160],
    ['160분+', v => v.travelMin >= 160],
];
for (const [name, fn] of bk) {
    const sub = villages.filter(fn);
    if (!sub.length) continue;
    const ta = sub.reduce((s, v) => s + v.attacks, 0);
    const tl = sub.reduce((s, v) => s + v.totalLoot, 0);
    const za = sub.reduce((s, v) => s + v.zeroAttacks, 0);
    const avg = tl / ta;
    const avgRT = sub.reduce((s, v) => s + v.travelMin * 2, 0) / sub.length;
    const lootPerHour = (60 / avgRT) * avg;
    console.log(`${name}\t\t\t${sub.length}\t${ta}\t${tl}\t${Math.round(avg)}\t\t${avgRT.toFixed(1)}\t\t${Math.round(lootPerHour)}\t\t${(za/ta*100).toFixed(0)}%`);
}

// 거리 임계 시뮬
console.log('\n=== 거리 임계별 시간당 총 loot ===');
console.log('임계(편도분)\t포함마을수\t시간당총loot\t상대효율');
const sims = [];
for (const limit of [2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]) {
    const sub = villages.filter(v => v.travelMin <= limit);
    if (!sub.length) continue;
    let total = 0;
    for (const v of sub) {
        const avg = v.totalLoot / v.attacks;
        const rt = v.travelMin * 2;
        if (rt > 0) total += (60 / rt) * avg;
    }
    sims.push({ limit, count: sub.length, total });
}
const max = Math.max(...sims.map(s => s.total));
for (const s of sims) {
    const pct = (s.total / max * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(s.total / max * 30));
    console.log(`${s.limit}분\t\t${s.count}\t\t${Math.round(s.total)}\t\t${pct}% ${bar}`);
}

const opt = sims.reduce((b, s) => s.total > b.total ? s : b, sims[0]);
console.log(`\n💡 최적: 편도 ${opt.limit}분 이내 마을 (${opt.count}개) → 시간당 ${Math.round(opt.total)}`);

// 가까운 + 좋은 마을 TOP
console.log('\n=== TOP 효율 마을 (시간당 loot 기준) ===');
console.log('좌표\t\t거리(필드)\t편도(분)\t공격\t평균loot\t시간당loot');
const ranked = villages.filter(v => v.attacks > 0 && v.travelMin > 0)
    .map(v => ({ ...v, avgLoot: v.totalLoot / v.attacks, perHour: (60 / (v.travelMin * 2)) * (v.totalLoot / v.attacks) }))
    .sort((a, b) => b.perHour - a.perHour);
for (const v of ranked.slice(0, 15)) {
    console.log(`${v.coords.join('|')}\t\t${v.fields.toFixed(1)}\t\t${v.travelMin.toFixed(1)}\t${v.attacks}\t${Math.round(v.avgLoot)}\t\t${Math.round(v.perHour)}`);
}

// 비효율 마을
console.log('\n=== 제외 추천 (시간당 loot 매우 낮음) ===');
console.log('좌표\t\t거리\t평균loot\t시간당');
for (const v of ranked.slice(-10).reverse()) {
    console.log(`${v.coords.join('|')}\t${v.fields.toFixed(1)}\t${Math.round(v.avgLoot)}\t\t${Math.round(v.perHour)}`);
}
