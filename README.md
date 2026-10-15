# People Count Monitor

Windows에서 **왼쪽 카메라 웹 뷰어 · 오른쪽 YouTube · 아래 LS PLC `%MW0`**를 함께 보는 데스크톱 프로그램입니다.

## 실행

**일반 사용자는 [Windows 다운로드 페이지](https://github.com/seoljaegeun3-svg/people-count-monitor/releases/latest)의 Assets에서 `People-Count-Monitor-1.0.1.exe`를 받아 더블클릭하세요. Node.js 설치는 필요 없습니다.** Source code ZIP은 실행 파일이 아닙니다.

아래 명령은 소스 코드를 개발하거나 직접 빌드할 때만 사용합니다.

Node.js 22 이상을 설치하고 이 폴더에서:

```powershell
npm ci
npm start
```

배포용 Windows EXE는 Windows PC에서 다음 명령으로 만듭니다.

```powershell
npm run dist:win
```

결과: `dist/People-Count-Monitor-1.0.1.exe`. 수신 PC에는 Node.js가 필요 없습니다. EXE는 코드 서명되지 않습니다.

GitHub의 **Actions → Build Windows download → Run workflow**로도 Windows 빌드·모의 PLC 테스트·EXE 배포를 실행할 수 있습니다. 실패한 빌드는 새 다운로드를 게시하지 않습니다.

## 사용 방법

1. 카메라·PLC가 연결된 Windows PC에서 실행합니다.
2. 기본 주소 `http://192.168.1.100/`에서 시작합니다. 카메라가 HTTP Basic/Digest 인증을 요구하면 앱의 **카메라 로그인** 창에 카메라 아이디·비밀번호를 입력합니다. 웹 로그인 화면이 나오면 그 화면에서 로그인합니다. 로그인 후 왼쪽 상단 **피플카운팅**을 누르면 스크린샷의 WiseAI 페이지를 엽니다. **로그인 / 홈**은 카메라 로그인 시작 화면으로 돌아갑니다. 비밀번호를 주소에 넣지 마세요.
3. 오른쪽에서 YouTube 영상을 검색하거나 영상 URL을 붙여 넣고 **열기**를 누릅니다. iframe이 아니라 독립 Chromium 화면을 사용합니다. 일부 영상의 DRM·코덱·Google 로그인 정책은 Electron에서 제한될 수 있습니다.
4. **연결 설정**에서 PLC IP·포트·워드·주기를 확인합니다. **PLC 연결**을 누르면 읽기가 시작됩니다. 연결 실패 시 자동으로 다시 조회하며 이전 값을 지웁니다. **연결 중지**로 멈춥니다.
5. 가운데 경계를 드래그해 좌우 비율을 바꿉니다. 키보드로는 경계에 포커스한 뒤 좌우 방향키를 사용합니다. 카메라 상단의 `− / ＋`는 페이지 크기를 조절합니다.

기본 PLC 설정은 기존 [people-counter-native](https://github.com/seoljaegeun3-svg/people-counter-native) 저장소의 `plc.go`, `settings.go`에서 확인한 **LS XGT Ethernet / 192.168.1.2:2004 / %MW0 / 500ms**입니다. 실제 장비가 이 설정을 사용한다는 확인은 별도로 필요합니다. Modbus TCP용 프로그램은 아닙니다. unsigned 16-bit WORD 원시값(0~65535)을 표시합니다. PLC 내부 값의 의미와 카메라 IN/OUT 집계의 대응은 현장 로직에 따라 달라집니다.

**PLC 쓰기·리셋 명령은 구현하지 않았습니다.** 카메라 IN/OUT 값은 카메라 페이지에서 확인합니다. 자동 추출·정확도 판정 기능은 없습니다. PLC 읽기는 앱을 시작할 때 자동 연결하지 않으며 사용자가 연결 버튼을 누릅니다.

## 설정과 로그인

Electron 사용자 데이터 폴더(`app.getPath('userData')`)의 `settings.json`에 주소·PLC 설정만 저장합니다. Windows 기본 경로는 `%APPDATA%\People Count Monitor\`입니다. 카메라와 YouTube의 쿠키·로그인 세션은 별도의 로컬 브라우저 프로필에 보관합니다. 카메라 비밀번호를 앱 설정에 저장하지 않습니다. 카메라 또는 YouTube 사이트 내 로그아웃을 사용하세요. 인증서 오류를 우회하지 않습니다.

앱 로그인 창은 사용자가 연 카메라 주소와 같은 출처의 Basic/Digest 요청에만 표시됩니다. 다른 서버나 프록시 인증에는 카메라 계정을 전달하지 않습니다. HTTP 인증 정보는 현재 Chromium 세션에 사용되며 앱이 평문 설정 파일에 저장하지 않습니다. HTTP 인증으로 로그인한 경우 프로그램을 종료하면 해당 세션이 끝납니다. 이전 버전의 기본 WiseAI 주소가 저장돼 있으면 새 버전은 카메라 홈부터 시작합니다. `401`은 **로그인 필요**, 다른 HTTP 오류는 **페이지 연결 실패**로 표시합니다.

## 검증

```powershell
npm test
npm run test:camera
```

외부 장비에 연결하지 않는 로컬 모의 XGT 서버로 읽기 패킷, 분할 응답, 0/65535, 호출 ID 불일치, PLC 오류, 잘못된 길이·블록·워드 크기, 중간 연결 종료, 타임아웃을 검증합니다.

`test:camera`는 실제 Electron/Chromium에서 loopback 모의 서버의 Basic/Digest 로그인, 잘못된 비밀번호 재입력, 취소, 다른 출처 인증 거부, HTTP 401/403 상태, 홈/피플카운팅 바로가기, 설정 파일 비밀번호 미저장을 검증합니다. Windows 데스크톱 또는 가상 디스플레이가 필요하며 외부 사이트 요청은 차단합니다. Windows 배포 workflow는 이 테스트가 통과해야 EXE를 게시합니다.

실제 Windows GUI, 카메라 영상·로그인, YouTube 영상 재생, 실제 PLC 값의 일치는 현장 PC에서 확인해야 합니다. 카메라와 PLC 사설 IP에 클라우드에서 연결을 시도하지 않습니다.

## 저장소 이름

- [people-count-monitor](https://github.com/seoljaegeun3-svg/people-count-monitor): 카메라·YouTube·PLC 통합 모니터. 이전 GitHub 이름은 `1`입니다.
- [people-counter-native](https://github.com/seoljaegeun3-svg/people-counter-native): Go 기반 Windows 네이티브 PeopleCounter와 LS XGT 통신. 이전 GitHub 이름은 `insurance-ai-marketing`입니다.

두 원격 저장소의 이름 변경을 완료했습니다. 클라우드 체크아웃 경로는 `/workspace/1`이며, Git origin은 새 `people-count-monitor` 주소를 사용합니다.

클라우드의 GitHub 인증 전달 경로 때문에 관리 토큰이 적용되지 않는 경우 **Settings → Secrets and variables → Actions → New repository secret**에 `REPO_ADMIN_TOKEN`으로 기존 관리 토큰을 등록하고 **Actions → Rename project repositories → Run workflow**를 실행합니다. workflow는 등록한 GitHub Secret을 사용해 GitHub runner에서 위 두 저장소를 변경합니다. 누락된 Secret·접근 실패·이름 충돌은 변경 전에 중단하고, 완료된 이름 변경은 다시 실행해도 건너뜁니다. 토큰 값을 채팅이나 workflow 입력값에 넣지 마세요.
