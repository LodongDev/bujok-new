// 키보드 타이핑 시뮬레이션 — 한 글자씩, 인간 속도로
// CDP Input.dispatchKeyEvent 사용 (keyDown → char → keyUp)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function gaussian(mean, std) {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// 키 코드 매핑
function getKeyInfo(char) {
    const code = char.charCodeAt(0);
    const isUpper = char >= 'A' && char <= 'Z';
    const isLetter = (char >= 'a' && char <= 'z') || isUpper;
    const isDigit = char >= '0' && char <= '9';

    let keyCode = code;
    let domCode = '';

    if (isLetter) {
        keyCode = char.toUpperCase().charCodeAt(0);
        domCode = 'Key' + char.toUpperCase();
    } else if (isDigit) {
        domCode = 'Digit' + char;
    } else {
        // 특수 문자
        const special = {
            ' ': 'Space', '.': 'Period', ',': 'Comma', '-': 'Minus',
            '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
            ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
            '\\': 'Backslash', '/': 'Slash', '@': 'Digit2',
            '!': 'Digit1', '#': 'Digit3', '$': 'Digit4',
            '_': 'Minus',
        };
        domCode = special[char] || '';
    }

    return { keyCode, domCode, isUpper };
}

// 한 글자 타이핑 (keyDown → char → keyUp)
async function typeChar(cdp, sessionId, char) {
    const info = getKeyInfo(char);

    // keyDown
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: char,
        code: info.domCode,
        text: char,
        unmodifiedText: char,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
    }, sessionId);

    // char (실제 문자 입력)
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'char',
        text: char,
        unmodifiedText: char,
        key: char,
    }, sessionId);

    // keyUp (짧은 딜레이 후)
    await sleep(rand(20, 80));
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
        code: info.domCode,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
    }, sessionId);
}

// 문자열 타이핑 — 인간처럼 한 글자씩
// 평균 120ms 간격, 가끔 느리게 (생각하는 시간), 가끔 빠르게 (연타)
async function typeText(cdp, sessionId, text) {
    for (let i = 0; i < text.length; i++) {
        await typeChar(cdp, sessionId, text[i]);

        if (i < text.length - 1) {
            // 글자 간 딜레이
            let delay;
            if (Math.random() < 0.08) {
                // 8% 확률: 긴 멈춤 (생각, 키 찾기)
                delay = rand(300, 600);
            } else if (Math.random() < 0.15) {
                // 15% 확률: 빠른 연타
                delay = rand(40, 80);
            } else {
                // 나머지: 정상 타이핑 (가우시안)
                delay = Math.max(50, gaussian(120, 40));
            }
            await sleep(delay);
        }
    }
}

// 필드 클리어 (기존 값 삭제) — Ctrl+A → Backspace
async function clearField(cdp, sessionId) {
    // Ctrl+A (전체 선택)
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA',
        modifiers: 2, // Ctrl
        windowsVirtualKeyCode: 65,
    }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        modifiers: 2,
        windowsVirtualKeyCode: 65,
    }, sessionId);

    await sleep(rand(50, 150));

    // Backspace (삭제)
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8,
    }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8,
    }, sessionId);

    await sleep(rand(100, 300));
}

module.exports = { typeChar, typeText, clearField };
