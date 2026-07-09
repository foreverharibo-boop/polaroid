# Polaroid Proxy — 설치 가이드

Polaroid 확장에서 "ST 연결 프로필 사용" 모드로 이미지까지 자동 생성하려면
이 서버 플러그인이 필요합니다. (SillyTavern이 확장 JS에는 원본 API 키를 절대
내려주지 않기 때문에, 서버 프로세스 안에서 대신 호출해주는 중계자입니다.)

## 1. 설치

1. 이 폴더(`polaroid-proxy`) 전체를 SillyTavern의 `plugins/` 폴더 안에 넣습니다.
   ```
   SillyTavern/
     plugins/
       polaroid-proxy/
         index.js
         package.json
   ```
2. `SillyTavern/config.yaml`을 열어 다음 값을 확인/수정합니다.
   ```yaml
   enableServerPlugins: true
   ```
3. SillyTavern 서버를 재시작합니다.
4. 서버 콘솔에 아래 로그가 뜨면 성공입니다.
   ```
   [polaroid-proxy] 플러그인 로드 완료 — POST /api/plugins/polaroid-proxy/generate
   ```
   브라우저에서 `https://<ST주소>/api/plugins/polaroid-proxy/probe` 를 열어
   `{"ok":true,"plugin":"polaroid-proxy"}` 가 뜨는지로도 확인 가능합니다.

## 2. Polaroid 확장 설정

1. 확장 설정 패널에서 **API 연결 방식**을 "ST 연결 프로필 사용"으로 둡니다.
2. **연결 프로필**에서 Gemini 3.1 Pro / 3.5 Flash 등 이미 만들어둔 프로필을 선택합니다.
3. **프로필 키 종류**를 선택합니다.
   - 대부분의 경우: **Google AI Studio 키** (그냥 `AIza...`로 시작하는 일반 Gemini API 키)
   - Vertex AI Express로 직접 연결한 프로필이면: **Vertex AI Express 키** 선택 후
     Project ID / Region도 입력
4. 저장하면 끝. 이제 이미지 생성까지 프로필의 키로 자동 처리됩니다.

## 3. 만약 "secretId를 찾지 못했습니다" 에러가 뜨면

`secrets.json`의 실제 경로가 이 플러그인이 기본으로 시도하는 경로들과 다른
ST 버전/설정일 수 있습니다. 서버 콘솔에 아래처럼 실제로 시도한 경로 목록이
찍히니, 그 중 진짜 파일이 있는 경로를 확인해서 `index.js`의
`candidateSecretPaths()` 함수에 한 줄 추가해주면 됩니다.

```
[polaroid-proxy] secretId "..." 를 다음 경로들에서 찾지 못함: [ '...', '...' ]
```

`secrets.json` 위치를 모르겠으면 ST 설치 폴더에서 다음처럼 찾아볼 수 있습니다.
```
find . -name "secrets.json" 2>/dev/null
```

## 보안 참고

- 이 플러그인은 `secrets.json`을 서버 프로세스 안에서만 읽고, 그 값을 응답 body에
  절대 포함시키지 않습니다 (Google API 호출에만 사용하고 버립니다).
- `/api/plugins/polaroid-proxy/generate`는 ST 서버의 인증 미들웨어를 그대로
  통과한 요청만 라우터에 도달하므로, ST 로그인 세션이 있는 사용자만 호출할 수
  있습니다 (ST 기본 플러그인 라우팅 동작).
