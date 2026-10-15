# People Count Monitor

Windows에서 **왼쪽 카메라 웹 뷰어 · 오른쪽 YouTube · 아래 LS PLC `%MW0`**를 함께 보는 데스크톱 프로그램입니다.

## 실행

Node.js 22 이상을 설치하고 이 폴더에서:

```powershell
npm ci
npm start
```

배포용 Windows EXE는 Windows PC에서 다음 명령으로 만듭니다.

```powershell
npm run dist:win
```

결과: `dist/People-Count-Monitor-1.0.0.exe`. 수신 PC에는 Node.js가 필요 없습니다. EXE는 코드 서명되지 않습니다.

## 사용 방법

1. 카메라·PLC가 연결된 Windows PC에서 실행합니다.
2. 왼쪽에서 카메라에 로그인합니다. 기본 주소는 스크린샷의 WiseAI 피플카운팅 페이지입니다. 모델/펌웨어에 따라 이 경로가 없으면 주소를 `http://192.168.1.100/`으로 바꾸세요. 비밀번호를 주소에 넣지 마세요.
3. 오른쪽에서 YouTube 영상을 검색하거나 영상 URL을 붙여 넣고 **열기**를 누릅니다. iframe이 아니라 독립 Chromium 화면을 사용합니다. 일부 영상의 DRM·코덱·Google 로그인 정책은 Electron에서 제한될 수 있습니다.
4. **연결 설정**에서 PLC IP·포트·워드·주기를 확인합니다. **PLC 연결**을 누르면 읽기가 시작됩니다. 연결 실패 시 자동으로 다시 조회하며 이전 값을 지웁니다. **연결 중지**로 멈춥니다.
5. 가운데 경계를 드래그해 좌우 비율을 바꿉니다. 키보드로는 경계에 포커스한 뒤 좌우 방향키를 사용합니다. 카메라 상단의 `− / ＋`는 페이지 크기를 조절합니다.

기본 PLC 설정은 기존 `insurance-ai-marketing` 저장소의 `plc.go`, `settings.go`에서 확인한 **LS XGT Ethernet / 192.168.1.2:2004 / %MW0 / 500ms**입니다. 실제 장비가 이 설정을 사용한다는 확인은 별도로 필요합니다. Modbus TCP용 프로그램은 아닙니다. unsigned 16-bit WORD 원시값(0~65535)을 표시합니다. PLC 내부 값의 의미와 카메라 IN/OUT 집계의 대응은 현장 로직에 따라 달라집니다.

**PLC 쓰기·리셋 명령은 구현하지 않았습니다.** 카메라 IN/OUT 값은 카메라 페이지에서 확인합니다. 자동 추출·정확도 판정 기능은 없습니다. PLC 읽기는 앱을 시작할 때 자동 연결하지 않으며 사용자가 연결 버튼을 누릅니다.

## 설정과 로그인

Electron 사용자 데이터 폴더(`app.getPath('userData')`)의 `settings.json`에 주소·PLC 설정만 저장합니다. Windows 기본 경로는 `%APPDATA%\People Count Monitor\`입니다. 카메라와 YouTube의 쿠키·로그인 세션은 별도의 로컬 브라우저 프로필에 보관합니다. 카메라 비밀번호를 앱 설정에 저장하지 않습니다. 카메라 또는 YouTube 사이트 내 로그아웃을 사용하세요. 인증서 오류를 우회하지 않습니다.

## 검증

```powershell
npm test
```

외부 장비에 연결하지 않는 로컬 모의 XGT 서버로 읽기 패킷, 분할 응답, 0/65535, 호출 ID 불일치, PLC 오류, 잘못된 길이·블록·워드 크기, 중간 연결 종료, 타임아웃을 검증합니다.

실제 Windows GUI, 카메라 영상·로그인, YouTube 영상 재생, 실제 PLC 값의 일치는 현장 PC에서 확인해야 합니다. 카메라와 PLC 사설 IP에 클라우드에서 연결을 시도하지 않습니다.

## 저장소 이름

- 이 프로젝트의 권장 GitHub 이름: `people-count-monitor` (현재 체크아웃 이름: `1`).
- 기존 `insurance-ai-marketing`: 실제 내용은 Go 기반 Windows 네이티브 PeopleCounter와 LS XGT 통신이므로 `people-counter-native` 권장.

GitHub 원격 이름 변경은 별도 관리 API 권한이 필요합니다. 변경이 완료되지 않았다면 각 저장소의 **Settings → General → Repository name → Rename**에서 위 이름을 적용할 수 있습니다. 로컬 폴더 이름만 바꾸는 것으로 GitHub 저장소 이름이 바뀌지는 않습니다.
