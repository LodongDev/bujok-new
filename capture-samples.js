#!/usr/bin/env node
// =============================================================
// capture-samples.js
// 진짜 Chrome에서 Tribal Wars 트래픽을 자동 캡처해서 samples/에 저장
//
// 사용법:
//   1. Chrome을 디버그 모드로 띄우고 게임 페이지 열어두기
//        chrome.exe --remote-debugging-port=9222
//   2. node capture-samples.js
//   3. 게임에서 평소대로 동작 (동줍, 공격, 원군, 거래소, 노블 학원 등)
//   4. Ctrl+C로 종료
//
// 캡처 대상:
//   - tribalwars.net 도메인의 모든 HTTP 요청/응답
//   - WebSocket frame (chat, 알림 등)
//   - 정적 자산(.css/.js/.png 등)은 자동 제외
//
// 저장 구조:
//   samples/
//     game/
//       POST_am_farm_farm_farm/      ← endpoint별 자동 분류
//         001.json
//         002.json
//       GET_place_command/
//       POST_place_confirm/
//       POST_place_popup_command/
//       ...
//     misc/                          ← interface.php, map/* 등
//     _socketio/                     ← socket.io polling
//     _websocket/                    ← WS frame
//
// 각 .json 파일 형식:
//   {
//     "ts": "ISO timestamp",
//     "tabUrl": "현재 탭 URL",
//     "request": { method, url, headers, body },
//     "response": { status, headers, body, mimeType, protocol }
//   }
// =============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// =============================================================
// CLI 인자 파싱
//   --server en154    → en154 서버만 캡처 (다른 서버 무시)
//   --port 9222       → CDP 포트 변경
//   --host 127.0.0.1  → CDP 호스트 변경
// =============================================================
function parseArgs() {
    const args = { server: null, port: 9222, host: '127.0.0.1' };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if ((a === '--server' || a === '-s') && argv[i + 1]) { args.server = argv[++i]; }
        else if (a === '--port' && argv[i + 1]) { args.port = parseInt(argv[++i]); }
        else if (a === '--host' && argv[i + 1]) { args.host = argv[++i]; }
        else if (a === '--help' || a === '-h') {
            console.log('사용법: node capture-samples.js [옵션]');
            console.log('  --server, -s <서버명>   특정 서버만 캡처 (예: en154, ens1)');
            console.log('  --port <포트>          CDP 포트 (기본 9222)');
            console.log('  --host <호스트>        CDP 호스트 (기본 127.0.0.1)');
            console.log('  --help, -h            도움말');
            process.exit(0);
        }
    }
    return args;
}

const ARGS = parseArgs();
const CDP_HOST = ARGS.host;
const CDP_PORT = ARGS.port;
const SERVER_FILTER = ARGS.server; // null이면 전체 캡처
const SAMPLES_DIR = path.join(__dirname, 'samples');

// 정적 자산 — 캡처 안 함
const SKIP_EXTS = new Set([
    '.css', '.js', '.mjs',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.webm', '.ogg', '.wav',
    '.map',
]);

let totalSaved = 0;
let totalSkipped = 0;
let wsFrameCount = 0;
const counters = new Map(); // dir → count

// =============================================================
// CDP HTTP API — 탭 목록
// =============================================================
function fetchTabs() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('CDP /json timeout')));
    });
}

// =============================================================
// 서버명 추출 — ens1.tribalwars.net → 'ens1'
// =============================================================
function getServerName(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const m = u.hostname.match(/^([^.]+)\.tribalwars\.net$/);
        return m ? m[1] : '_unknown';
    } catch { return '_unknown'; }
}

// =============================================================
// URL → 폴더 키 (자동 분류용, 서버별 분리)
// =============================================================
function endpointKey(rawUrl, method) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }

    if (!u.hostname.endsWith('tribalwars.net')) return null;

    // 정적 자산 스킵
    const ext = path.extname(u.pathname).toLowerCase();
    if (SKIP_EXTS.has(ext)) return null;

    const server = getServerName(rawUrl);

    // 서버 필터 — 지정된 서버 외에는 스킵
    if (SERVER_FILTER && server !== SERVER_FILTER) return null;

    // socket.io polling 별도 분류
    if (u.pathname.startsWith('/socket.io/')) {
        return `${server}/_socketio/${method}_polling`;
    }

    // /game.php?screen=...&...
    if (u.pathname === '/game.php') {
        const sp = u.searchParams;
        const parts = [method];
        const screen = sp.get('screen');
        if (screen) parts.push(screen);
        const ax = sp.get('ajax') || sp.get('ajaxaction');
        if (ax) parts.push(ax);
        const mode = sp.get('mode');
        if (mode && mode !== ax) parts.push(mode);
        const action = sp.get('action');
        if (action) parts.push('act_' + action);
        const tryp = sp.get('try');
        if (tryp) parts.push('try_' + tryp);
        return `${server}/game/${parts.join('_')}`;
    }

    // 기타 (/interface.php, /map.php, /map/village.txt 등)
    const segs = u.pathname.split('/').filter(Boolean);
    const safe = segs.map(s => s.replace(/[^a-zA-Z0-9._-]/g, '_')).join('_');
    return `${server}/misc/${method}_${safe}`;
}

// =============================================================
// 응답 저장
// =============================================================
function saveEntry(entry) {
    const key = endpointKey(entry.request.url, entry.request.method);
    if (!key) { totalSkipped++; return; }

    const dir = path.join(SAMPLES_DIR, key);
    fs.mkdirSync(dir, { recursive: true });

    let n = counters.get(dir);
    if (n === undefined) {
        // 첫 호출 시 디스크 기존 파일 갯수로 초기화 (재실행 시 덮어쓰기 방지)
        try { n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length; }
        catch { n = 0; }
    }
    n++;
    counters.set(dir, n);

    const file = path.join(dir, String(n).padStart(3, '0') + '.json');
    try {
        fs.writeFileSync(file, JSON.stringify(entry, null, 2));
        totalSaved++;
        const status = entry.response?.status ?? '?';
        const proto = entry.response?.protocol || '';
        console.log(`[${String(totalSaved).padStart(4)}] ${key}/${path.basename(file)}  ${status} ${proto}`);
    } catch (err) {
        console.log(`[저장실패] ${key}: ${err.message}`);
    }
}

// =============================================================
// WebSocket frame 저장 (서버별 분리)
// =============================================================
function saveWsFrame(serverName, direction, params) {
    // 서버 필터
    if (SERVER_FILTER && serverName !== SERVER_FILTER) return;

    const dir = path.join(SAMPLES_DIR, serverName || '_unknown', '_websocket');
    fs.mkdirSync(dir, { recursive: true });
    wsFrameCount++;
    const file = path.join(dir, String(wsFrameCount).padStart(4, '0') + '-' + direction + '.txt');
    const payload = params.response?.payloadData ?? '';
    try { fs.writeFileSync(file, payload); }
    catch { /* ignore */ }
}

// =============================================================
// 탭에 부착
// =============================================================
function attachToTab(tab) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
        let msgId = 0;
        const pending = new Map();

        function send(method, params = {}) {
            const id = ++msgId;
            return new Promise((res, rej) => {
                pending.set(id, { res, rej });
                ws.send(JSON.stringify({ id, method, params }));
                // 10초 후 미응답이면 타임아웃
                setTimeout(() => {
                    if (pending.has(id)) {
                        pending.delete(id);
                        rej(new Error('CDP send timeout: ' + method));
                    }
                }, 10000);
            });
        }

        const requests = new Map(); // requestId → entry
        const tabLabel = (tab.title || tab.url).slice(0, 60);

        ws.on('open', async () => {
            try {
                await send('Network.enable', {
                    maxResourceBufferSize: 50_000_000,
                    maxTotalBufferSize: 200_000_000,
                });
                await send('Page.enable').catch(() => {});
                console.log(`[부착] ${tabLabel}`);
                resolve(ws);
            } catch (err) { reject(err); }
        });

        ws.on('message', async (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); }
            catch { return; }

            // RPC 응답
            if (msg.id !== undefined) {
                const p = pending.get(msg.id);
                if (p) {
                    pending.delete(msg.id);
                    if (msg.error) p.rej(new Error(msg.error.message || 'CDP error'));
                    else p.res(msg.result);
                }
                return;
            }

            // 이벤트
            const { method, params } = msg;
            if (!method) return;

            try {
                if (method === 'Network.requestWillBeSent') {
                    const url = params.request.url;
                    if (!url.includes('tribalwars.net')) return;
                    requests.set(params.requestId, {
                        ts: params.wallTime
                            ? new Date(params.wallTime * 1000).toISOString()
                            : new Date().toISOString(),
                        tabUrl: tab.url,
                        request: {
                            method: params.request.method,
                            url,
                            headers: params.request.headers,
                            body: params.request.postData || null,
                            initiator: params.initiator?.type || null,
                        },
                    });
                } else if (method === 'Network.responseReceived') {
                    const e = requests.get(params.requestId);
                    if (!e) return;
                    e.response = {
                        status: params.response.status,
                        statusText: params.response.statusText,
                        headers: params.response.headers,
                        mimeType: params.response.mimeType,
                        protocol: params.response.protocol, // h2, http/1.1
                        remoteIP: params.response.remoteIPAddress,
                    };
                } else if (method === 'Network.loadingFinished') {
                    const e = requests.get(params.requestId);
                    if (!e) return;
                    requests.delete(params.requestId);
                    if (!e.response) return;
                    try {
                        const result = await send('Network.getResponseBody', { requestId: params.requestId });
                        e.response.body = result.body;
                        e.response.bodyBase64 = !!result.base64Encoded;
                    } catch (err) {
                        e.response.body = null;
                        e.response.bodyError = err.message;
                    }
                    saveEntry(e);
                } else if (method === 'Network.loadingFailed') {
                    const e = requests.get(params.requestId);
                    if (!e) return;
                    requests.delete(params.requestId);
                    e.response = {
                        status: 0,
                        error: params.errorText,
                        canceled: !!params.canceled,
                    };
                    saveEntry(e);
                } else if (method === 'Network.webSocketFrameSent') {
                    saveWsFrame(getServerName(tab.url), 'sent', params);
                } else if (method === 'Network.webSocketFrameReceived') {
                    saveWsFrame(getServerName(tab.url), 'recv', params);
                } else if (method === 'Page.frameNavigated') {
                    if (params.frame?.parentId == null && params.frame?.url) {
                        tab.url = params.frame.url;
                    }
                }
            } catch (err) {
                console.log(`[이벤트에러] ${method}: ${err.message}`);
            }
        });

        ws.on('close', () => {
            console.log(`[종료] 탭 연결 끊김: ${tabLabel}`);
        });

        ws.on('error', (err) => {
            console.log(`[WS에러] ${tabLabel}: ${err.message}`);
            reject(err);
        });
    });
}

// =============================================================
// 부착된 탭 추적 + 자동 부착
// =============================================================
const attachedTabs = new Map(); // tabId → { ws, tab }

async function ensureAttached(silent = false) {
    let tabs;
    try {
        tabs = await fetchTabs();
    } catch (err) {
        if (!silent) console.log(`[CDP에러] ${err.message}`);
        return;
    }

    let gameTabs = tabs.filter(t => t.type === 'page' && t.url.includes('tribalwars.net'));

    // 서버 필터 적용
    if (SERVER_FILTER) {
        gameTabs = gameTabs.filter(t => getServerName(t.url) === SERVER_FILTER);
    }

    // 닫힌 탭 정리
    const aliveIds = new Set(gameTabs.map(t => t.id));
    for (const id of [...attachedTabs.keys()]) {
        if (!aliveIds.has(id)) {
            attachedTabs.delete(id);
        }
    }

    // 새 탭 부착
    for (const tab of gameTabs) {
        if (attachedTabs.has(tab.id)) continue;
        try {
            const ws = await attachToTab(tab);
            attachedTabs.set(tab.id, { ws, tab });
            const server = getServerName(tab.url);
            console.log(`         → 서버: ${server}`);
            ws.on('close', () => attachedTabs.delete(tab.id));
        } catch (err) {
            if (!silent) console.log(`[부착실패] ${tab.url.slice(0, 60)}: ${err.message}`);
        }
    }
}

async function pollForNewTabs() {
    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        await ensureAttached(true);
    }
}

// =============================================================
// Main
// =============================================================
async function main() {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });

    console.log('===========================================');
    console.log(' Tribal Wars 트래픽 자동 캡처');
    console.log('===========================================');
    console.log(`[연결] CDP ${CDP_HOST}:${CDP_PORT}`);
    if (SERVER_FILTER) {
        console.log(`[필터] 서버=${SERVER_FILTER} (다른 서버는 무시)`);
    }

    // 초기 부착
    await ensureAttached(false);

    if (attachedTabs.size === 0) {
        const targetUrl = SERVER_FILTER
            ? `https://${SERVER_FILTER}.tribalwars.net`
            : 'https://www.tribalwars.net';
        console.log(`[탭없음] tribalwars 탭이 없어서 자동으로 열기: ${targetUrl}`);
        try {
            const openRes = await new Promise((resolve, reject) => {
                const body = JSON.stringify({ url: targetUrl });
                const req = http.request(`http://${CDP_HOST}:${CDP_PORT}/json/new?${targetUrl}`, { method: 'PUT' }, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
                });
                req.on('error', reject);
                req.end();
            });
            console.log(`[탭생성] 새 탭 열림, 로딩 대기 중...`);
            await new Promise(r => setTimeout(r, 5000));
            await ensureAttached(false);
        } catch (err) {
            console.error(`[탭생성실패] ${err.message}`);
        }

        if (attachedTabs.size === 0) {
            console.error('[에러] tribalwars 탭을 열 수 없습니다.');
            console.error('  Chrome이 디버그 모드로 실행 중인지 확인:');
            console.error('    chrome.exe --remote-debugging-port=9222');
            process.exit(1);
        }
    }

    console.log('');
    console.log('===========================================');
    console.log(` 캡처 시작! ${attachedTabs.size}개 탭 부착됨`);
    console.log(` 저장 위치: ${SAMPLES_DIR}`);
    console.log(' (새 탭 열면 자동으로 부착됨)');
    console.log(' 종료: Ctrl+C');
    console.log('===========================================');
    console.log('');

    // 백그라운드 폴링 (새 탭/닫힌 탭 자동 감지)
    pollForNewTabs().catch(err => console.log('[폴링에러]', err.message));

    process.on('SIGINT', () => {
        console.log('');
        console.log('===========================================');
        console.log(`[종료] 총 저장: ${totalSaved}건`);
        console.log(`       스킵(자산/외부): ${totalSkipped}건`);
        console.log(`       WS frame: ${wsFrameCount}건`);
        console.log('===========================================');
        process.exit(0);
    });
}

main().catch(err => {
    console.error('[치명적 에러]', err);
    process.exit(1);
});
