# no_modify
开场白：有缘人。。。
## 章节内容
```
## 日程空间戒指
@旁白：（饰演日程空间戒指）戒指内部空间辽阔，但是目前基本啥也没有，只有炼炎决（炎帝的早期功法），一把灭魔尺，一本灭魔尺法，灭魔步，10颗五行回复丹。100个斗气石，1个中阶魔核。
## @旁白 ：请输入你的姓名，性别，年龄进行绑定
```
### 
成功条件（章节结局）：
```
用户输入了姓名，性别，年龄。
```

## 生成的Phase Graph
```
{
  "openingMessages": [
    {
      "role": "旁白",
      "roleType": "narrator",
      "content": "有缘人。。。"
    }
  ],
  "phases": [
    {
      "id": "phase_1_日程空间戒指",
      "label": "日程空间戒指",
      "kind": "scene",
      "targetSummary": "（饰演日程空间戒指）戒指内部空间辽阔，但是目前基本啥也没有，只有炼炎决（炎帝的早期功法），一把灭魔尺，一本灭魔尺法，灭魔步，10颗五行回复丹。100个斗气石，1",
      "userNodeId": null,
      "allowedSpeakers": [],
      "nextPhaseIds": [
        "phase_2_旁白_请输入你的姓名_性别_年龄进行绑定"
      ],
      "defaultNextPhaseId": "phase_2_旁白_请输入你的姓名_性别_年龄进行绑定",
      "requiredEventIds": [],
      "completionEventIds": [],
      "advanceSignals": [
        "日程空间戒指",
        "（饰演日程空间戒指）戒指内部空间辽阔，但是目前基本啥也没有，只有炼炎决（炎帝的早期功法），一把灭魔尺，一本灭魔尺法，灭魔步，10颗五行回复丹。100个斗气石，1"
      ],
      "relatedFixedEventIds": []
    },
    {
      "id": "phase_2_旁白_请输入你的姓名_性别_年龄进行绑定",
      "label": "@旁白 ：请输入你的姓名，性别，年龄进行绑定",
      "kind": "scene",
      "targetSummary": "@旁白 ：请输入你的姓名，性别，年龄进行绑定",
      "userNodeId": null,
      "allowedSpeakers": [],
      "nextPhaseIds": [],
      "defaultNextPhaseId": null,
      "requiredEventIds": [
        "phase:phase_1_日程空间戒指"
      ],
      "completionEventIds": [],
      "advanceSignals": [
        "@旁白 ：请输入你的姓名，性别，年龄进行绑定"
      ],
      "relatedFixedEventIds": []
    }
  ],
  "userNodes": [],
  "fixedEvents": [
    {
      "id": "fixed_event_用户输入了姓名_性别_年龄",
      "label": "用户输入了姓名，性别，年龄。",
      "requiredBeforeFinish": true,
      "conditionExpr": {
        "type": "equals",
        "field": "state.player.identity_bound",
        "value": true
      }
    }
  ],
  "endingRules": {
    "success": [
      "fixed_event_用户输入了姓名_性别_年龄"
    ],
    "failure": [],
    "nextChapterId": null
  }
}
```

发给编排师的事件信息
```
  "current_phase": {
    "label": "日程空间戒指",
    "goal": "饰演日程空间戒指：戒指内部空间辽阔，但是目前基本啥也没有，只有炼炎决（炎帝的早期功法），一把灭魔尺，一本灭魔尺法，灭魔步，10颗五行回复丹。10...",
    "allowed_speakers": []
  },
  "current_event": {
    "index": 1,
    "kind": "scene",
    "flow": "chapter_content",
    "status": "idle",
    "summary": "饰演日程空间戒指：戒指内部空间辽阔，但是目前基本啥也没有，只有炼炎决（炎帝的早期功法），一把灭魔尺，一本灭魔尺法，灭魔步，10颗五行回复丹。10...",
    "facts": [],
    "memory_summary": "",
    "memory_facts": []
  },
```


# 严重问题
吞掉了重要信息 ：“@旁白：” 导致了编排混乱！！！！