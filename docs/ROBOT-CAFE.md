# 로봇 카페 시연 (studyUR 연동)

M400 스테이션 앞에 **UR5e 협동로봇**을 세워, 무인카페에서 고객이 하던 일을 로봇이 대신합니다.

```
주문 키오스크(별도 모니터 팝업) → 결제 → 컵 배출 → 🤖 컵을 제빙기로 → 얼음
→ 🤖 컵을 투출구로 → 음료 추출 → 🤖 픽업대로 전달 → 고객 수령
```

- 실행: 뷰어 상단 **🤖 로봇 카페 시연** 버튼, 플랫폼 선택에서 `M400 로봇 카페 (UR5e)`, 또는 `/?platform=m400-robot`
- 웹 데모: https://cafesim.samdori93.workers.dev/?platform=m400-robot (브라우저 안에서 실행되는 시연 전용 모드)

## 화면 구성

| 요소 | 설명 |
|---|---|
| 주문 키오스크 팝업 | 고객용 별도 모니터. 화면에 떠 있는 창이며 `⧉ 새 창`으로 실제 창으로 분리해 다른 모니터로 옮길 수 있습니다. 상단 `🖥 주문 키오스크`로 다시 엽니다 |
| 커피머신 화면 | 로봇 카페 상태판 (제조 중인 음료, 진행 단계, 로봇 동작) |
| UR5e 카드 | 로봇 상태, 관절 각도, 충돌 검사 결과, 현재 동작의 **URScript** (movej/movel/rq_move_mm). `충돌 영역`으로 장애물 박스와 로봇 캡슐을 표시 |
| 픽업 테이블 | 로봇 바로 앞(고객 쪽) 테이블. 로봇이 돌아서서 테이블 위에 컵을 놓습니다 |

## 동작 원리

1. 장비(커피머신·제빙기·컵 디스펜서·단말기)는 m400 플랫폼과 같은 가상 하드웨어·프로토콜로 동작합니다.
2. 시뮬레이터의 고객 안내(`computeGuide`)가 "컵을 제빙기에 대 주세요" 같은 **컵 이동** 단계를 내면, `RobotCell`이 그 단계를 픽앤플레이스 프로그램으로 만듭니다:
   `그리퍼 열기(컵 크기) → 통로 이동 → movel(접근·파지점) → 그리퍼 닫기 → movel(들어올림·꺼내기) → 통로 이동 → movel(놓기) → 그리퍼 열기 → movel(후퇴)`
3. 경로는 **studyUR의 `planProgram()`**(사다리꼴 속도 MoveJ, 직교 보간 MoveL + `ikClosest`)으로 계획되고, 공식 `ur_description` 메시를 단 URDF 모델로 재생됩니다.
4. 파지 순간 컵은 `robot:gripper` 슬롯으로 옮겨져(컵 센서가 비게 됨) 그리퍼를 따라 움직이고, 놓는 순간 목적지 슬롯에 놓입니다.
5. 카드 넣기·빼기, 음료 받아 가기 같은 고객 자신의 동작은 잠시 뒤 자동으로 수행됩니다.

로봇 위치·모델·TCP·속도·통로는 [`platforms/m400-robot/platform.js`](../platforms/m400-robot/platform.js)의 `layout.robot`에서 바꿉니다.

## 수평 파지와 그리퍼 폭

- 컵은 **옆에서(수평 방향)** 잡습니다: 툴 z = 접근 방향(수평), 손가락은 수평으로 닫히고 툴 y = 위쪽이라 컵이 똑바로 선 채로 옮겨집니다.
- 파지 높이는 컵 높이의 55 %, 그리퍼 폭은 그 높이의 컵 지름에 맞춥니다: 열 때 `반지름 + 9 mm`, 닫을 때 `반지름 − 1.5 mm`(HOT 컵 ≈ 69/66 mm, ICE 컵 ≈ 84/81 mm). URScript에는 `rq_move_mm(폭)`으로 나옵니다.
- 손가락 길이는 TCP 거리(0.19 m)에서 정해집니다. 긴 손가락이 손목을 장비에서 떨어뜨려 줍니다.

## 충돌 회피

- **로봇 모델**: 공식 UR 메시의 링크별 바운딩 박스에 맞춘 캡슐(upper arm, forearm, wrist 1-3) + 그리퍼 몸체·손가락 캡슐 + 들고 있는 컵 캡슐 (`packages/viewer/src/robot/collision.js`)
- **환경 모델**: 장비별 `obstacles` 박스(커피머신 헤드·호퍼·드립트레이·측벽, 제빙기 노즐·창, 컵 디스펜서 창틀 등, 컵이 들어가는 칸은 비움) + 카운터, 벽, 픽업 테이블, 로봇 받침대
- 모든 구간을 studyUR로 계획한 뒤 궤적을 샘플링해 캡슐-박스 거리(여유 8 mm)를 검사합니다. 충돌하면 다음 후보 경로로 다시 계획합니다:
  1. **전면 통로**: 장비 앞 일직선 통로(z 0.30 m, 높이 0.24 m)로 빠져나와 MoveL로 옆으로 이동한 뒤 들어감. 픽업 테이블은 통로 중앙에서 돌아섬
  2. 직접 MoveJ → 3. 후퇴·상승 경유점(2가지) → 4. 접힌 자세 경유
- 카드에 결과(`✔ 충돌 검사 통과` / `⚠ 충돌 회피 실패`)가, URScript 주석에 시도한 후보가 표시됩니다.
- 기준 배치(UR5e, 받침대 (-0.13, 0, 0.80), TCP 0.19 m, 픽업 (-0.13, 0, 1.42))에서 아이스 아메리카노(제빙기 → 1번 투출구)와 HOT 카페라떼(2번 투출구) 전체 주문이 충돌 없이 끝나는 것을 확인했습니다.

## studyUR 동기화

studyUR의 기구학 모듈과 모델 데이터·메시는 `tools/sync-studyur.mjs`로 가져옵니다 (로컬 체크아웃이 없으면 GitHub에서 다운로드).

```bash
node tools/sync-studyur.mjs --from ../studyUR           # 또는 인자 없이 (GitHub main)
node tools/sync-studyur.mjs --models ur5e,ur3e           # 다른 모델 메시도 가져오기
```

| 가져오는 것 | 위치 |
|---|---|
| `spatial.js`, `model.js`, `kinematics.js`, `urdf.js`, `trajectory.js` | `packages/viewer/src/robot/studyur/` (수정 금지, 동기화로 갱신) |
| `models.json`, `tools.json` | `packages/viewer/public/ur/` |
| UR 메시 (`visual/*.dae`, `collision/*.stl`), 라이선스 | `packages/viewer/public/ur/models/` |

UR 메시는 [Universal_Robots_ROS2_Description](https://github.com/UniversalRobots/Universal_Robots_ROS2_Description) (BSD-3-Clause) 입니다.
