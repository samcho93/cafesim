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
| UR5e 카드 | 로봇 상태, 관절 각도, 현재 동작의 **URScript** (movej/movel/set_tool_digital_out) |
| 픽업대 | 로봇 오른쪽 앞의 원형 스탠드 |

## 동작 원리

1. 장비(커피머신·제빙기·컵 디스펜서·단말기)는 m400 플랫폼과 같은 가상 하드웨어·프로토콜로 동작합니다.
2. 시뮬레이터의 고객 안내(`computeGuide`)가 "컵을 제빙기에 대 주세요" 같은 **컵 이동** 단계를 내면, `RobotCell`이 그 단계를 픽앤플레이스 프로그램으로 만듭니다:
   `movej(접근점) → movel(파지점) → 그리퍼 닫기 → movel(들어올림) → movel(후퇴) → movej(놓을 곳 접근) → movel(놓기) → 그리퍼 열기 → movel(후퇴)`
3. 경로는 **studyUR의 `planProgram()`**(사다리꼴 속도 MoveJ, 직교 보간 MoveL + `ikClosest`)으로 계획되고, 공식 `ur_description` 메시를 단 URDF 모델로 재생됩니다.
4. 파지 순간 컵은 `robot:gripper` 슬롯으로 옮겨져(컵 센서가 비게 됨) 그리퍼를 따라 움직이고, 놓는 순간 목적지 슬롯에 놓입니다.
5. 카드 넣기·빼기, 음료 받아 가기 같은 고객 자신의 동작은 잠시 뒤 자동으로 수행됩니다.

로봇 위치·모델·TCP·속도는 [`platforms/m400-robot/platform.js`](../platforms/m400-robot/platform.js)의 `layout.robot`에서 바꿉니다.
UR5e 기준 받침대 위치 (-0.10, 0, 0.70)에서 모든 정지점과 MoveL 경로가 도달 가능함을 IK로 확인했습니다.

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
