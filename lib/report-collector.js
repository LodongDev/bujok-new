// 파밍 보고서 자동 수집 — screen=report&mode=attack 페이지를 주기적으로 읽어 약탈량 누적 저장
// 저장: data/reports-<server>.jsonl (append-only, 중복은 report id로 제거)
// 분석: analyze-farming.js가 이 파일 읽음

const fs = require('fs');
const path = require('path');
const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

const DATA_DIR = path.join(__dirname, '..', 'data');

class ReportCollector {
    constructor(cdp, sessionId, baseUrl, serverName, scheduler, botLock) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.serverName = serverName;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.timer = null;
        this.running = false;
        this.stopped = false;
        // 페이지 1만 읽음 (최신 보고서들). 30분~1시간 주기로 부담 적음
        this.intervalMin = 30 * 60 * 1000;  // 30분
        this.intervalMax = 60 * 60 * 1000;  // 60분
        this.dataFile = path.join(DATA_DIR, `reports-${serverName}.jsonl`);
        this.seenIds = this._loadSeenIds();
    }

    _loadSeenIds() {
        const ids = new Set();
        if (!fs.existsSync(this.dataFile)) return ids;
        try {
            const lines = fs.readFileSync(this.dataFile, 'utf8').split('\n');
            for (const l of lines) {
                if (!l.trim()) continue;
                try { const r = JSON.parse(l); if (r.id) ids.add(r.id); } catch {}
            }
        } catch {}
        log.info(`[보고서수집] 기존 ${ids.size}개 보고서 로드`);
        return ids;
    }

    _appendReport(report) {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(this.dataFile, JSON.stringify(report) + '\n');
        this.seenIds.add(report.id);
    }

    start() {
        this.stopped = false;
        log.info(`[보고서수집] 시작 (${this.serverName}, ${Math.round(this.intervalMin/60000)}~${Math.round(this.intervalMax/60000)}분 주기)`);
        // 즉시 첫 수집 (15~60초 후)
        this.scheduleNext(randInt(15000, 60000));
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info('[보고서수집] 정지');
    }

    scheduleNext(overrideMs) {
        if (this.stopped || this.timer) return;
        const delay = overrideMs !== undefined ? overrideMs : randInt(this.intervalMin, this.intervalMax);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.warn(`[보고서수집] tick 에러: ${e.message}`));
        }, delay);
    }

    async tick() {
        if (this.stopped || this.running) return;
        // 다른 큐가 바쁘면 미루기
        if (this.scheduler && this.scheduler.isBusy()) {
            this.scheduleNext(randInt(60000, 180000));
            return;
        }
        if (this.botLock) {
            try { await this.botLock.acquire('reports'); }
            catch { this.scheduleNext(); return; }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('reports');
            return;
        }

        this.running = true;
        try {
            const newCount = await this._collect();
            if (newCount > 0) log.ok(`[보고서수집] 신규 ${newCount}개 저장 (총 ${this.seenIds.size}개)`);
        } catch (e) {
            log.warn(`[보고서수집] 실패: ${e.message}`);
        } finally {
            this.running = false;
            if (this.botLock) this.botLock.release('reports');
        }
        if (!this.stopped) this.scheduleNext();
    }

    async _collect() {
        // 보고서 첫 페이지부터 읽기 — 최대 5페이지 (60개)
        let total = 0;
        for (let page = 0; page < 5; page++) {
            const url = `${this.baseUrl}/game.php?screen=report&mode=attack&from=${page * 12}`;
            await navigate(this.cdp, this.sessionId, url);
            await waitForLoad(this.cdp, this.sessionId, 15000);
            await sleep(randInt(500, 1500));

            const reports = await evaluate(this.cdp, this.sessionId, `
                (() => {
                    const decode = (s) => {
                        const t = document.createElement('textarea');
                        t.innerHTML = s;
                        return t.value;
                    };
                    const rows = document.querySelectorAll('tr.report-link, tr[class*="report-"]');
                    const out = [];
                    for (const row of rows) {
                        const idMatch = row.className.match(/report-(\\d+)/);
                        if (!idMatch) continue;
                        const id = idMatch[1];

                        const dot = row.querySelector('img[src*="dots/"]');
                        const result = dot ? (dot.src.match(/dots\\/(\\w+)\\.webp/) || [])[1] : null;

                        const lootImg = row.querySelector('img[src*="max_loot/"]');
                        const tooltip = lootImg ? lootImg.getAttribute('title') || '' : '';
                        // 두 형식 모두 시도 — 디코딩된 형식 + 인코딩된 (&quot;,&lt;,&gt;) 형식
                        const decoded = decode(tooltip);
                        const findLoot = (text, unitClass) => {
                            // 1) 디코딩된 형식: class="icon header wood" title="Wood"> </span>25
                            const re1 = new RegExp(unitClass + '"[^<]*</span>\\\\s*(\\\\d+)');
                            const m1 = text.match(re1);
                            if (m1) return parseInt(m1[1]);
                            // 2) 인코딩된 형식: class=&quot;icon header wood&quot; ... &lt;/span&gt;25
                            const re2 = new RegExp(unitClass + '&quot;[^&]*&lt;\\\\/span&gt;\\\\s*(\\\\d+)');
                            const m2 = text.match(re2);
                            if (m2) return parseInt(m2[1]);
                            // 3) 단순 fallback: header wood ... 숫자
                            const re3 = new RegExp('header ' + unitClass + '[\\\\s\\\\S]{0,80}?(\\\\d+)\\\\s*<');
                            const m3 = text.match(re3);
                            if (m3) return parseInt(m3[1]);
                            return 0;
                        };
                        const w = findLoot(decoded, 'wood') || findLoot(tooltip, 'wood');
                        const s = findLoot(decoded, 'stone') || findLoot(tooltip, 'stone');
                        const i = findLoot(decoded, 'iron') || findLoot(tooltip, 'iron');

                        const labelEl = row.querySelector('.quickedit-label');
                        const label = labelEl ? labelEl.textContent.trim() : '';
                        const coords = [...label.matchAll(/\\((\\d+)\\|(\\d+)\\)/g)].map(m => [+m[1], +m[2]]);
                        if (coords.length < 2) continue;

                        const isFarm = !!row.querySelector('img[src*="farm.webp"]');
                        const timeEl = row.querySelector('.report-arrival-time, td:nth-child(4)');

                        out.push({
                            id, result, isFarm,
                            src: coords[0], dst: coords[1],
                            wood: w || 0, stone: s || 0, iron: i || 0,
                            label,
                            ts: Date.now(),
                        });
                    }
                    return out;
                })()
            `);

            if (!reports || reports.length === 0) break;

            let newOnPage = 0;
            for (const r of reports) {
                if (this.seenIds.has(r.id)) continue;
                this._appendReport(r);
                newOnPage++;
                total++;
            }
            // 새 게 0이면 더 이전 페이지엔 다 알고 있음 → 멈춤
            if (newOnPage === 0) break;
            await sleep(randInt(800, 2000));
        }
        return total;
    }

    status() {
        return {
            running: this.running,
            stopped: this.stopped,
            totalReports: this.seenIds.size,
            dataFile: this.dataFile,
        };
    }
}

module.exports = ReportCollector;
