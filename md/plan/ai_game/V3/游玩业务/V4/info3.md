# no_modify
开场白：有缘人。。。
## 章节1内容
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


# 章节二内容
```
## 萧家小辈调侃
@旁白 ：这里是斗气大陆，加玛帝国，乌坦城。
@萧炎： 该死，为什么 
@某男子 ：(扮演萧家小辈) 萧炎当前状态——斗之气三段。当年的天才成了废物。23333
## @旁白 ：萧家练武场。嘲笑声此起彼伏。

@某男子 ：“废物萧炎。”

## 旁白：你（@用户 ）可以行动了（自由活动直到进入萧家大厅）。
```
## Phase Graph
```
{
  "openingMessages": [],
  "phases": [
    {
      "id": "phase_1_萧家小辈调侃",
      "label": "萧家小辈调侃",
      "kind": "scene",
      "targetSummary": "这里是斗气大陆，加玛帝国，乌坦城。 该死，为什么 (扮演萧家小辈) 萧炎当前状态——斗之气三段。当年的天才成了废物。23333",
      "userNodeId": null,
      "allowedSpeakers": [],
      "nextPhaseIds": [
        "phase_2_旁白_萧家练武场_嘲笑声此起彼伏"
      ],
      "defaultNextPhaseId": "phase_2_旁白_萧家练武场_嘲笑声此起彼伏",
      "requiredEventIds": [],
      "completionEventIds": [],
      "advanceSignals": [
        "萧家小辈调侃",
        "这里是斗气大陆，加玛帝国，乌坦城。 该死，为什么 (扮演萧家小辈) 萧炎当前状态——斗之气三段。当年的天才成了废物。23333",
        "旁白",
        "这里是斗气大陆，加玛帝国，乌坦城。",
        "萧炎",
        "该死，为什么",
        "某男子",
        "(扮演萧家小辈) 萧炎当前状态——斗之气三段。当年的天才成了废物。23333"
      ],
      "relatedFixedEventIds": []
    },
    {
      "id": "phase_2_旁白_萧家练武场_嘲笑声此起彼伏",
      "label": "@旁白 ：萧家练武场。嘲笑声此起彼伏。",
      "kind": "scene",
      "targetSummary": "“废物萧炎。”",
      "userNodeId": null,
      "allowedSpeakers": [],
      "nextPhaseIds": [
        "phase_3_旁白_你_用户_可以行动了_自由活动直到进入萧家大厅"
      ],
      "defaultNextPhaseId": "phase_3_旁白_你_用户_可以行动了_自由活动直到进入萧家大厅",
      "requiredEventIds": [
        "phase:phase_1_萧家小辈调侃"
      ],
      "completionEventIds": [],
      "advanceSignals": [
        "@旁白 ：萧家练武场。嘲笑声此起彼伏。",
        "“废物萧炎。”",
        "某男子"
      ],
      "relatedFixedEventIds": []
    },
    {
      "id": "phase_3_旁白_你_用户_可以行动了_自由活动直到进入萧家大厅",
      "label": "旁白：你（@用户 ）可以行动了（自由活动直到进入萧家大厅）。",
      "kind": "scene",
      "targetSummary": "旁白：你（@用户 ）可以行动了（自由活动直到进入萧家大厅）。",
      "userNodeId": null,
      "allowedSpeakers": [],
      "nextPhaseIds": [],
      "defaultNextPhaseId": null,
      "requiredEventIds": [
        "phase:phase_2_旁白_萧家练武场_嘲笑声此起彼伏"
      ],
      "completionEventIds": [],
      "advanceSignals": [
        "旁白：你（@用户 ）可以行动了（自由活动直到进入萧家大厅）。"
      ],
      "relatedFixedEventIds": []
    }
  ],
  "userNodes": [],
  "fixedEvents": [
    {
      "id": "fixed_event_用户进入萧家大厅_纳兰嫣然出场",
      "label": "用户进入萧家大厅，纳兰嫣然出场",
      "requiredBeforeFinish": true,
      "conditionExpr": null
    }
  ],
  "endingRules": {
    "success": [
      "fixed_event_用户进入萧家大厅_纳兰嫣然出场"
    ],
    "failure": [],
    "nextChapterId": null
  }
}
```


## 成功条件（章节结局）：
用户进入萧家大厅，纳兰嫣然出场
