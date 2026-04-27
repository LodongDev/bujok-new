// ==UserScript==
// @name         Bujok 스캐빈징 최적화 (전체 마을)
// @namespace    bujok
// @version      0.5
// @description  버튼 하나로 전체 마을 스캐빈징 최적 배분 + 자동 전송
// @match        https://*.tribalwars.net/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 유닛 설정
    // ==========================================
    const UNITS = {
        spear: { carry: 25, pop: 1 },
        sword: { carry: 15, pop: 1 },
        axe: { carry: 10, pop: 1 },
        archer: { carry: 10, pop: 1 },
        light: { carry: 80, pop: 4 },
        marcher: { carry: 50, pop: 5 },
        heavy: { carry: 50, pop: 6 },
    };
    const SCAV_UNITS = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];
    const DURATION_EXP = 0.45;

    // ==========================================
    // 최적 비율 계산
    // ==========================================
    function calcRatios(options) {
        const exp = 1 / (1 - DURATION_EXP);
        const weights = {};
        let total = 0;
        for (const opt of options) {
            const w = Math.pow(opt.lootFactor, exp);
            weights[opt.id] = w;
            total += w;
        }
        const ratios = {};
        for (const opt of options) {
            ratios[opt.id] = total > 0 ? weights[opt.id] / total : 1 / options.length;
        }
        return ratios;
    }

    // ==========================================
    // 병력 배분
    // ==========================================
    function distribute(unitCounts, availableOptions) {
        const scavUnits = [];
        for (const [unit, info] of Object.entries(UNITS)) {
            const count = unitCounts[unit] || 0;
            if (count > 0) scavUnits.push({ unit, count, ...info, eff: info.carry / info.pop });
        }
        scavUnits.sort((a, b) => b.eff - a.eff);
        if (scavUnits.length === 0) return [];

        let totalPop = 0;
        for (const u of scavUnits) totalPop += u.count * u.pop;

        const ratios = calcRatios(availableOptions);
        const optsSorted = [...availableOptions].sort((a, b) => b.lootFactor - a.lootFactor);
        const remaining = {};
        for (const u of scavUnits) remaining[u.unit] = u.count;

        const result = [];
        for (let i = 0; i < optsSorted.length; i++) {
            const opt = optsSorted[i];
            const isLast = i === optsSorted.length - 1;
            let popBudget = isLast ? Infinity : Math.floor(totalPop * ratios[opt.id]);

            const troops = {};
            let popUsed = 0, carryTotal = 0;
            for (const u of scavUnits) {
                const avail = remaining[u.unit] || 0;
                if (avail <= 0) continue;
                const maxByPop = Math.floor((popBudget - popUsed) / u.pop);
                const use = Math.min(avail, Math.max(0, maxByPop));
                if (use > 0) {
                    troops[u.unit] = use;
                    remaining[u.unit] -= use;
                    popUsed += use * u.pop;
                    carryTotal += use * u.carry;
                }
            }
            if (popUsed > 0 && isLast) {
                for (const u of scavUnits) {
                    const avail = remaining[u.unit] || 0;
                    if (avail > 0 && u.pop === 1) {
                        troops[u.unit] = (troops[u.unit] || 0) + avail;
                        carryTotal += avail * u.carry;
                        remaining[u.unit] = 0;
                    }
                }
            }
            if (carryTotal > 0) {
                result.push({ optionId: opt.id, troops, carryTotal });
            }
        }
        return result;
    }

    // ==========================================
    // API 전송
    // ==========================================
    async function sendSquads(villageId, squads, csrf) {
        const params = new URLSearchParams();
        for (let idx = 0; idx < squads.length; idx++) {
            const s = squads[idx];
            const pfx = `squad_requests[${idx}]`;
            params.append(`${pfx}[village_id]`, villageId);
            for (const unit of SCAV_UNITS) {
                params.append(`${pfx}[candidate_squad][unit_counts][${unit}]`, s.troops[unit] || 0);
            }
            params.append(`${pfx}[candidate_squad][carry_max]`, s.carryTotal);
            params.append(`${pfx}[option_id]`, s.optionId);
            params.append(`${pfx}[use_premium]`, 'false');
        }
        params.append('h', csrf);

        const res = await fetch(`/game.php?village=${villageId}&screen=scavenge_api&ajaxaction=send_squads`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'TribalWars-Ajax': '1',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: params.toString(),
        });
        return await res.json();
    }

    // ==========================================
    // 마을 목록 가져오기 (overview_villages 페이지 fetch)
    // ==========================================
    async function getAllVillages() {
        const currentVillage = new URLSearchParams(location.search).get('village');
        const res = await fetch(`/game.php?village=${currentVillage}&screen=overview_villages&mode=combined&group=0&page=-1`, {
            headers: { 'Accept': 'text/html' },
        });
        const html = await res.text();

        const seen = new Set();
        const villages = [];
        const regex = /village=(\d+)[^"]*"[^>]*>([^<]*?)\s*\((\d+)\|(\d+)\)/g;
        let m;
        while ((m = regex.exec(html)) !== null) {
            const id = parseInt(m[1]);
            if (seen.has(id)) continue;
            seen.add(id);
            villages.push({ id, name: m[2].trim(), x: parseInt(m[3]), y: parseInt(m[4]) });
        }

        // 폴백: 모든 village= 링크
        if (villages.length === 0) {
            const links = html.matchAll(/village=(\d+)/g);
            for (const l of links) {
                const id = parseInt(l[1]);
                if (!seen.has(id) && id > 0) {
                    seen.add(id);
                    villages.push({ id, name: `마을 ${id}`, x: 0, y: 0 });
                }
            }
        }
        return villages;
    }

    // ==========================================
    // 한 마을의 스캐빈징 데이터 가져오기 (백그라운드 fetch)
    // ==========================================
    async function getVillageScavengeData(villageId) {
        const res = await fetch(`/game.php?village=${villageId}&screen=place&mode=scavenge`, {
            headers: { 'Accept': 'text/html' },
        });
        const html = await res.text();

        // var village = {...} 파싱
        const m = html.match(/var\s+village\s*=\s*(\{[\s\S]*?\});\s/);
        if (!m) return null;

        try {
            const village = JSON.parse(m[1]);
            return {
                villageId: village.village_id,
                units: village.unit_counts_home || {},
                options: village.options || {},
            };
        } catch { return null; }
    }

    // ==========================================
    // CSRF 토큰
    // ==========================================
    function getCsrf() {
        if (typeof TribalWars !== 'undefined' && TribalWars.getGameData) {
            return TribalWars.getGameData().csrf;
        }
        const m = document.documentElement.innerHTML.match(/&h=([a-f0-9]+)/);
        return m ? m[1] : null;
    }

    // ==========================================
    // 옵션 loot_factor (기본값 — 페이지에서 읽기 시도)
    // ==========================================
    const DEFAULT_FACTORS = { 1: 0.10, 2: 0.25, 3: 0.50, 4: 0.75 };

    function getAvailableOptions(options) {
        const available = [];
        for (const [id, opt] of Object.entries(options)) {
            if (!opt.is_locked && !opt.scavenging_squad) {
                available.push({
                    id: parseInt(id),
                    lootFactor: DEFAULT_FACTORS[parseInt(id)] || 0.1,
                });
            }
        }
        return available;
    }

    // ==========================================
    // 결과 팝업 UI
    // ==========================================
    function showResultsPanel(results) {
        let existing = document.getElementById('bujok-scav-results');
        if (existing) existing.remove();

        const panel = document.createElement('div');
        panel.id = 'bujok-scav-results';
        panel.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 100000; background: #1a1a2e; border: 2px solid #4CAF50;
            border-radius: 12px; padding: 20px; min-width: 400px; max-width: 600px;
            max-height: 80vh; overflow-y: auto; color: #e0e0e0;
            font-family: sans-serif; font-size: 13px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        `;

        let html = '<h3 style="color:#4CAF50;margin-bottom:12px;">⚡ 전체 마을 스캐빈징 결과</h3>';

        let totalSent = 0, totalVillages = 0;
        for (const r of results) {
            const icon = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⏭' : '❌';
            html += `<div style="margin-bottom:8px;padding:8px;background:#16213e;border-radius:6px;">`;
            html += `<b>${icon} ${r.name} (${r.x}|${r.y})</b><br>`;
            if (r.status === 'ok') {
                totalVillages++;
                for (const s of r.squads) {
                    const units = Object.entries(s.troops).filter(([, c]) => c > 0).map(([u, c]) => `${u}:${c}`).join(' ');
                    html += `<span style="color:#aaa;">옵션 ${s.optionId}: ${units} (carry ${s.carryTotal})</span><br>`;
                    totalSent += Object.values(s.troops).reduce((a, b) => a + b, 0);
                }
            } else if (r.status === 'skip') {
                html += `<span style="color:#888;">${r.reason}</span>`;
            } else {
                html += `<span style="color:#e94560;">${r.error}</span>`;
            }
            html += '</div>';
        }

        html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #333;text-align:center;">`;
        html += `<b>${totalVillages}개 마을, 총 ${totalSent}명 전송</b>`;
        html += `</div>`;
        html += `<button onclick="this.parentElement.remove()" style="display:block;margin:12px auto 0;padding:8px 24px;background:#e94560;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">닫기</button>`;

        panel.innerHTML = html;
        document.body.appendChild(panel);
    }

    // ==========================================
    // 전체 마을 스캐빈징 실행
    // ==========================================
    async function optimizeAll() {
        const csrf = getCsrf();
        if (!csrf) { alert('CSRF 토큰 못 찾음'); return; }

        btn.textContent = '마을 목록 조회 중...';
        btn.disabled = true;
        btn.style.background = '#666';

        try {
            const villages = await getAllVillages();
            if (villages.length === 0) { alert('마을 없음'); resetBtn(); return; }

            const results = [];

            for (let i = 0; i < villages.length; i++) {
                const v = villages[i];
                btn.textContent = `(${i + 1}/${villages.length}) ${v.name}`;

                try {
                    // 마을 스캐빈징 데이터 조회
                    const data = await getVillageScavengeData(v.id);
                    if (!data) {
                        results.push({ ...v, status: 'skip', reason: '데이터 조회 실패' });
                        continue;
                    }

                    // 열린 옵션 확인
                    const available = getAvailableOptions(data.options);
                    if (available.length === 0) {
                        const running = Object.values(data.options).filter(o => o.scavenging_squad).length;
                        const locked = Object.values(data.options).filter(o => o.is_locked).length;
                        results.push({ ...v, status: 'skip', reason: `진행 중 ${running}개, 잠금 ${locked}개` });
                        continue;
                    }

                    // 가용 병력 확인
                    const totalCarry = Object.entries(data.units)
                        .reduce((sum, [u, c]) => sum + (UNITS[u] ? c * UNITS[u].carry : 0), 0);
                    if (totalCarry === 0) {
                        results.push({ ...v, status: 'skip', reason: '가용 병력 없음' });
                        continue;
                    }

                    // 최적 배분
                    const squads = distribute(data.units, available);
                    if (squads.length === 0) {
                        results.push({ ...v, status: 'skip', reason: '배분 불가' });
                        continue;
                    }

                    // 전송
                    const apiResult = await sendSquads(v.id, squads, csrf);
                    if (apiResult.response?.invalid_village_ids?.length > 0) {
                        results.push({ ...v, status: 'error', error: 'API 거부', squads });
                    } else {
                        results.push({ ...v, status: 'ok', squads });
                    }

                    // 마을 사이 딜레이 (자연스럽게)
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 700));

                } catch (e) {
                    results.push({ ...v, status: 'error', error: e.message });
                }
            }

            // 결과 표시
            showResultsPanel(results);
            resetBtn();

            // 현재 페이지가 스캐빈징이면 새로고침
            if (location.search.includes('mode=scavenge')) {
                setTimeout(() => location.reload(), 2000);
            }

        } catch (e) {
            alert('오류: ' + e.message);
            resetBtn();
        }
    }

    // ==========================================
    // UI
    // ==========================================
    let btn;

    function resetBtn() {
        btn.textContent = '⚡ 전체 마을 스캐빈징';
        btn.disabled = false;
        btn.style.background = '#4CAF50';
    }

    function addButton() {
        if (document.getElementById('bujok-scav-btn')) return;

        btn = document.createElement('button');
        btn.id = 'bujok-scav-btn';
        btn.textContent = '⚡ 전체 마을 스캐빈징';
        btn.style.cssText = `
            position: fixed; top: 10px; right: 10px; z-index: 99999;
            background: #4CAF50; color: white; border: 2px solid #388E3C; border-radius: 8px;
            padding: 12px 20px; font-size: 14px; font-weight: bold;
            cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            font-family: sans-serif; transition: all 0.2s;
        `;
        btn.onmouseenter = () => { if (!btn.disabled) btn.style.background = '#45a049'; };
        btn.onmouseleave = () => { if (!btn.disabled) btn.style.background = '#4CAF50'; };
        btn.onclick = optimizeAll;
        document.body.appendChild(btn);
    }

    // 모든 TW 페이지에서 실행 (스캐빈징 페이지 아니어도 OK)
    if (document.readyState === 'complete') addButton();
    else window.addEventListener('load', addButton);
})();
