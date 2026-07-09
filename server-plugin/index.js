/**
 * polaroid-proxy — SillyTavern 서버 플러그인
 *
 * 하는 일: Polaroid 확장이 "연결 프로필 모드"로 이미지를 생성할 때, 프론트엔드(브라우저)는
 * 원본 API 키를 절대 볼 수 없다 (/api/secrets/view가 확장 요청엔 403을 돌려주기 때문).
 * 이 플러그인은 ST 서버 프로세스 "안"에서 돌아가므로 그 제약이 없다 — secrets.json을
 * 직접 읽어서, 대신 Google Generative Language API / Vertex AI generateContent를 호출하고
 * 결과(이미지 inlineData 포함)만 브라우저로 돌려준다. 키 값 자체는 응답에 포함되지 않는다.
 *
 * 설치:
 *   1. 이 폴더(polaroid-proxy) 전체를 SillyTavern 설치 폴더의 `plugins/` 안에 넣는다.
 *      최종 경로 예: SillyTavern/plugins/polaroid-proxy/index.js
 *   2. SillyTavern/config.yaml 에서 `enableServerPlugins: true` 로 설정.
 *   3. SillyTavern 서버 재시작.
 *   4. 콘솔에 `[polaroid-proxy] 플러그인 로드 완료` 가 뜨면 성공.
 *
 * 확인이 필요한 부분 (환경마다 다를 수 있음):
 *   - secrets.json 위치. candidateSecretPaths()에서 흔한 경로들을 순서대로 시도하지만,
 *     본인 ST 설치가 멀티유저 모드거나 커스텀 dataRoot를 쓴다면 경로가 다를 수 있다.
 *     서버 콘솔에 찍히는 경고 로그를 보고 실제 경로를 candidateSecretPaths()에 추가하면 된다.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'polaroid-proxy';

// ── secrets.json 후보 경로 ───────────────────────────────────
// ST 버전 / 멀티유저 설정에 따라 위치가 달라질 수 있어 여러 개를 순서대로 시도한다.
function candidateSecretPaths(req) {
    const paths = [];

    // 최신 ST(특히 멀티유저 모드)는 인증된 요청에 사용자별 디렉토리 정보를 실어준다.
    // (버전에 따라 필드명이 다를 수 있어 몇 가지를 함께 시도)
    const dirs = req?.user?.directories;
    if (dirs?.secrets) paths.push(dirs.secrets);
    if (dirs?.root) paths.push(path.join(dirs.root, 'secrets.json'));

    // 흔한 기본 위치들 (싱글유저 기본 설치 기준)
    paths.push(path.join(process.cwd(), 'data', 'default-user', 'secrets.json'));
    paths.push(path.join(process.cwd(), 'data', 'secrets.json'));

    // 중복 제거
    return [...new Set(paths.filter(Boolean))];
}

function readSecretValue(req, secretId) {
    const tried = [];
    for (const p of candidateSecretPaths(req)) {
        tried.push(p);
        try {
            if (!fs.existsSync(p)) continue;
            const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (json[secretId]) return { value: json[secretId], foundAt: p };
        } catch (e) {
            console.warn(`[${PLUGIN_ID}] ${p} 읽기 실패:`, e.message);
        }
    }
    console.warn(`[${PLUGIN_ID}] secretId "${secretId}" 를 다음 경로들에서 찾지 못함:`, tried);
    return null;
}

// ── Google API 호출 ──────────────────────────────────────────
async function callGoogle({ apiKey, provider, model, projectId, region, body }) {
    if (provider === 'vertex') {
        const r = region || 'global';
        const base = r === 'global'
            ? 'https://aiplatform.googleapis.com/v1'
            : `https://${r}-aiplatform.googleapis.com/v1`;
        if (!projectId) throw new Error('Vertex 모드에는 projectId가 필요합니다.');
        const url = `${base}/projects/${projectId}/locations/${r}/publishers/google/models/${model}:generateContent`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
        });
        return { ok: res.ok, status: res.status, payload: res.ok ? await res.json() : await res.text() };
    }

    // 기본값: Google AI Studio (Generative Language API) — ST 연결 프로필 대부분이 이쪽 키를 씀
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, payload: res.ok ? await res.json() : await res.text() };
}

async function init(router) {
    // 헬스체크 (플러그인이 실제로 로드됐는지 확장 쪽에서 확인용)
    router.get('/probe', (req, res) => res.json({ ok: true, plugin: PLUGIN_ID }));

    router.post('/generate', async (req, res) => {
        try {
            const { secretId, provider, model, projectId, region, body } = req.body || {};
            if (!secretId || !model || !body) {
                return res.status(400).json({ error: 'secretId, model, body는 필수 항목입니다.' });
            }

            const found = readSecretValue(req, secretId);
            if (!found) {
                return res.status(404).json({
                    error: `secretId "${secretId}"에 해당하는 키를 secrets.json에서 찾지 못했습니다.`,
                    hint: '서버 콘솔의 경고 로그에 실제 시도한 경로들이 찍힙니다. 필요하면 index.js의 candidateSecretPaths()에 실제 경로를 추가해주세요.',
                });
            }

            const result = await callGoogle({
                apiKey: found.value,
                provider: provider === 'vertex' ? 'vertex' : 'aistudio',
                model, projectId, region, body,
            });

            if (!result.ok) {
                return res.status(result.status).json({ error: 'Google API 오류', detail: result.payload });
            }
            return res.json(result.payload);
        } catch (e) {
            console.error(`[${PLUGIN_ID}] /generate 오류:`, e);
            return res.status(500).json({ error: e.message || String(e) });
        }
    });

    console.log(`[${PLUGIN_ID}] 플러그인 로드 완료 — POST /api/plugins/${PLUGIN_ID}/generate`);
}

async function exit() {
    console.log(`[${PLUGIN_ID}] 종료`);
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Polaroid Proxy',
        description: '연결 프로필의 시크릿을 서버에서 읽어 Gemini/Vertex generateContent(이미지 포함)를 대신 호출합니다.',
    },
};
