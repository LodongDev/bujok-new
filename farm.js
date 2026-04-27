#!/usr/bin/env node
// 동줍 봇 CLI — bujok-new
//
// 사용법:
//   node farm.js                  # 기본: ens1, 마을 자동 감지
//   node farm.js --server en154
//   node farm.js --port 9222
//
// 동작:
//   1. CDP로 Chrome에 연결
//   2. 새 탭 만들기 (사용자 평소 탭과 분리)
//   3. 마을 목록 자동 감지
//   4. 각 마을 Farm Assistant → 진짜 마우스로 A 버튼 클릭
//   5. 인간 케이던스 + 정지 + 휴식 + 위장 행동
//   6. Ctrl+C로 종료

const CDP = require('./lib/cdp');
const { detectVillages, farmVillageOnce } = require('./lib/farm');
const { HumanState, sleep } = require('./lib/human');
const log = require('./lib/log');

function parseArgs() {
    const args = { server: 'ens1', port: 9222, host: '127.0.0.1' };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--server' && argv[i+1]) args.server = argv[++i];
        else if (a === '--port' && argv[i+1]) args.port = parseInt(argv[++i]);
        else if (a === '--host' && argv[i+1]) args.host = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log('사용법: node farm.js [옵션]');
            console.log('  --server <name>   서버 (기본 ens1, 예: en154)');
            console.log('  --port <port>     CDP 포트 (기본 9222)');
            console.log('  --host <host>     CDP 호스트 (기본 127.0.0.1)');
            console.log('');
            console.log('Chrome 디버그 모드가 떠있어야 함:');
            console.log('  chrome.exe --remote-debugging-port=9222');
            process.exit(0);
        }
    }
    return args;
}

async function main() {
    const args = parseArgs();
    const baseUrl = `https://${args.server}.tribalwars.net`;

    log.info('============================================');
    log.info(' bujok-new farm v0.1');
    log.info(` 서버: ${args.server}`);
    log.info(' 진짜 Chrome + 마우스 시뮬 + 인간 행동');
    log.info('============================================');

    const cdp = new CDP(args.host, args.port);
    try {
        await cdp.connect();
    } catch (e) {
        log.err(`CDP 연결 실패: ${e.message}`);
        log.err(`Chrome을 디버그 모드로 띄웠는지 확인:`);
        log.err(`  chrome.exe --remote-debugging-port=${args.port}`);
        process.exit(1);
    }

    // 새 탭 — overview_villages로 시작 (마을 감지용)
    const startUrl = `${baseUrl}/game.php?screen=overview_villages`;
    let targetId, sessionId;
    try {
        const r = await cdp.createTab(startUrl);
        targetId = r.targetId;
        sessionId = r.sessionId;
    } catch (e) {
        log.err(`탭 생성 실패: ${e.message}`);
        process.exit(1);
    }

    // 페이지 도메인 활성화 (백그라운드에서도 작동)
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});

    // 종료 처리
    const state = {
        stopping: false,
        lastMouse: { x: 500, y: 300 },
        totalFarmed: 0,
    };

    let cleanedUp = false;
    async function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        state.stopping = true;
        log.info('정리 중...');
        try { await cdp.closeTab(targetId); } catch {}
        try { cdp.close(); } catch {}
    }

    process.on('SIGINT', async () => {
        log.warn('Ctrl+C 수신 — 종료 중');
        await cleanup();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        await cleanup();
        process.exit(0);
    });

    // 마을 자동 감지
    let villages;
    try {
        villages = await detectVillages(cdp, sessionId, baseUrl);
    } catch (e) {
        log.err(`마을 감지 실패: ${e.message}`);
        await cleanup();
        process.exit(1);
    }

    // 인간 상태 (전체 세션 동안 공유)
    const human = new HumanState();

    // 마을 순회 (한 사이클)
    for (const v of villages) {
        if (state.stopping) break;
        try {
            const farmed = await farmVillageOnce(cdp, sessionId, baseUrl, v, human, state);
            state.totalFarmed += farmed;

            // 마을 사이 자연스러운 대기 (1.5~5초)
            if (!state.stopping) {
                const gap = 1500 + Math.random() * 3500;
                log.info(`다음 마을로 이동까지 ${Math.round(gap/1000)}초 대기`);
                await sleep(gap);
            }
        } catch (e) {
            log.err(`[${v.id}] 마을 처리 실패: ${e.message}`);
            await sleep(3000);
        }
    }

    log.ok(`============================================`);
    log.ok(` 한 사이클 완료`);
    log.ok(` 총 동줍: ${state.totalFarmed}건`);
    log.ok(` 작업 시간: ${human.elapsed()}초`);
    log.ok(`============================================`);

    await cleanup();
    process.exit(0);
}

main().catch(err => {
    log.err(`치명적 에러: ${err.message}`);
    console.error(err);
    process.exit(1);
});
