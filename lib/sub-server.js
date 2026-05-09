// 서브 서버 — 메인 서버 외 추가 서버에서 스캐빈징만 자동 운영
// 각 서브는 자기 봇 탭, 자기 BotLock, 자기 botProtection 상태 가짐.
// 메인 서버와 완전히 격리 — 서브 캡차 떠도 메인 영향 없음.

const ScavengeQueue = require('./scavenge-queue');
const BotLock = require('./bot-lock');
const { detectVillages } = require('./farm');
const { evaluate } = require('./runtime');
const { sleep } = require('./page');
const log = require('./log');

class SubServer {
    constructor(cdp, server) {
        this.cdp = cdp;
        this.server = server;
        this.baseUrl = `https://${server}.tribalwars.net`;
        this.botSessionId = null;
        this.botTargetId = null;
        this.botLock = new BotLock();
        this.botProtection = null;       // { type, at } — 캡차 상태
        this.villages = [];
        this.scavQueue = null;
        this.scavConfig = null;          // { villageIds, unitsByVillage } — persist용
        this.startedAt = Date.now();
    }

    // 봇 탭 생성 + 게임 진입 + 마을 감지
    async start() {
        const playUrl = `https://www.tribalwars.net/en-dk/page/play/${this.server}`;
        log.info(`[서브:${this.server}] 봇 탭 생성...`);
        const tab = await this.cdp.createTab(playUrl);
        this.botSessionId = tab.sessionId;
        this.botTargetId = tab.targetId;
        await this.cdp.send('Page.enable', {}, this.botSessionId).catch(() => {});
        await this.cdp.send('Runtime.enable', {}, this.botSessionId).catch(() => {});

        // 게임 페이지 로드 대기
        let ready = false;
        for (let i = 0; i < 20; i++) {
            await sleep(1000);
            try {
                const ok = await evaluate(this.cdp, this.botSessionId, `
                    location.href.includes('game.php') && !!document.querySelector('#menu_row, #menu_row2')
                `);
                if (ok) { ready = true; break; }
            } catch {}
        }
        if (!ready) {
            const url = await evaluate(this.cdp, this.botSessionId, 'location.href').catch(() => 'unknown');
            throw new Error(`서브 서버 ${this.server} 게임 진입 실패 (${url})`);
        }

        // 마을 감지
        this.villages = await detectVillages(this.cdp, this.botSessionId, this.baseUrl);
        log.ok(`[서브:${this.server}] 게임 준비 완료 — 마을 ${this.villages.length}개`);
    }

    // 스캐빈징 시작
    async startScavenge({ villageIds, unitsByVillage }) {
        const targets = this.villages.filter(v => (villageIds || []).includes(v.id));
        if (targets.length === 0) throw new Error('대상 마을 없음');

        this.scavConfig = { villageIds, unitsByVillage: unitsByVillage || {} };

        if (this.scavQueue) this.scavQueue.stop();
        this.scavQueue = new ScavengeQueue(
            this.cdp, this.botSessionId, this.baseUrl,
            null,                                // scheduler X (서브는 공격 예약 없음)
            this.botLock,
            (detail) => this._handleBotProtection(detail),
        );
        await this.scavQueue.start(targets, { unitsByVillage });
        log.ok(`[서브:${this.server}] 스캐빈징 시작 — ${targets.length}개 마을`);
    }

    stopScavenge() {
        if (this.scavQueue) {
            this.scavQueue.stop();
            this.scavQueue = null;
        }
        this.scavConfig = null;
    }

    // 사용자가 캡차 해결 후 다시 시작
    clearBotProtection() {
        if (!this.botProtection) return;
        const sec = Math.round((Date.now() - this.botProtection.at) / 1000);
        log.ok(`[서브:${this.server}] 봇 프로텍션 해제 (${sec}초 만에 해결)`);
        this.botProtection = null;
        // 큐 자동 재시작 — config 보존되어 있으면
        if (this.scavConfig) {
            this.startScavenge(this.scavConfig).catch(e => {
                log.warn(`[서브:${this.server}] 큐 재시작 실패: ${e.message}`);
            });
        }
    }

    // 큐 종료 + 봇 탭 닫기
    async stop() {
        this.stopScavenge();
        if (this.botTargetId) {
            try { await this.cdp.closeTab(this.botTargetId); } catch {}
            this.botTargetId = null;
            this.botSessionId = null;
        }
        log.info(`[서브:${this.server}] 종료`);
    }

    _handleBotProtection(detail) {
        if (this.botProtection) return;
        this.botProtection = { ...detail, at: Date.now() };
        log.err(`🛑 [서브:${this.server}] 봇 프로텍션 감지: ${detail.type} — 큐 정지`);
        if (this.scavQueue) this.scavQueue.stop();

        // 주기적 해결 확인
        if (this._botCheckTimer) clearInterval(this._botCheckTimer);
        this._botCheckTimer = setInterval(async () => {
            if (!this.botProtection || !this.botSessionId) return;
            try {
                const { checkBotProtection } = require('./bot-protection');
                const r = await checkBotProtection(this.cdp, this.botSessionId, { skipDump: true });
                if (!r.detected) {
                    clearInterval(this._botCheckTimer);
                    this._botCheckTimer = null;
                    this.clearBotProtection();
                }
            } catch {}
        }, 15000);
    }

    status() {
        return {
            server: this.server,
            startedAt: this.startedAt,
            villages: this.villages.length,
            botProtection: this.botProtection,
            scavenge: this.scavQueue ? {
                ...this.scavQueue.status(),
                config: this.scavConfig,
            } : null,
        };
    }
}

module.exports = SubServer;
