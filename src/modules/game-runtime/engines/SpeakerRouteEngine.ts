export interface SpeakerRouteRole {
  name: string;
  roleType: string;
  description?: string;
  sample?: string;
  parameterCardJson?: unknown;
}

export interface SpeakerModeDecision {
  mode: "template" | "fast" | "premium";
  voiceMode: "skip" | "async" | "immediate";
  memoryMode: "skip" | "async";
  reason: string;
}

function normalizeScalarText(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function sanitizeRoleType(input: unknown): "player" | "narrator" | "npc" {
  const text = normalizeScalarText(input).toLowerCase();
  if (text === "player") return "player";
  if (text === "npc") return "npc";
  return "narrator";
}

function roleActsAsWildcard(role: SpeakerRouteRole | null | undefined): boolean {
  if (!role) return false;
  const parameterCardText = typeof role.parameterCardJson === "string"
    ? role.parameterCardJson
    : JSON.stringify(role.parameterCardJson || {});
  const haystack = [
    role.name,
    role.description,
    role.sample,
    parameterCardText,
  ]
    .map((item) => normalizeScalarText(item))
    .join("\n");
  return /万能角色|万能|某男子|某男士|某女士|某女孩|某少年|某青年|某人/.test(haystack);
}

function isClearlyKeyRole(role: SpeakerRouteRole): boolean {
  const haystack = [
    role.name,
    role.description,
    typeof role.parameterCardJson === "string"
      ? role.parameterCardJson
      : JSON.stringify(role.parameterCardJson || {}),
  ]
    .map((item) => normalizeScalarText(item))
    .join("\n");
  return /萧炎|纳兰嫣然|萧薰儿|古薰儿|薰儿|小医仙|药老|主角|少宗主|重要角色|关键角色/.test(haystack);
}

function shortMotive(input: string): boolean {
  return normalizeScalarText(input).length > 0 && normalizeScalarText(input).length <= 36;
}

function isNarratorTemplateFriendly(motive: string): boolean {
  return /描述|补一句|环境|氛围|现场|局势|观察|过渡|变化|紧张感|衔接|过场|桥接|等待用户|观察时机|表态/.test(motive);
}

function isWildcardTemplateFriendly(motive: string): boolean {
  return /挑衅|嘲讽|起哄|逼迫|拱火|施压|催促|冷笑|看笑话|逼.*表态|阴阳怪气/.test(motive);
}

function isFastNpcMotive(motive: string): boolean {
  return /承接|继续|顺着|回应|回怼|施压|挑衅|追问|补一句|描述|观察|反应|冷笑|扫视|抬眼|逼.*表态|紧张|接话|短促|盯住|出声|逼近|逼问|接一句/.test(motive);
}

function isHighRiskPremiumMotive(motive: string): boolean {
  return /告白|表白|诀别|大战|生死|重伤|死亡|背叛|立誓|突破|晋级|收徒|退婚|三年之约|关系变化|身份揭露|真相|关键选择|任务完成|战斗结算|站队|表态|施压|逼迫|抉择|冲突升级|回怼|羞辱|威胁/.test(motive);
}

function isNarratorFastFriendly(motive: string): boolean {
  return /现场|局势|紧张|目光|空气|环境|变化|过场|桥接|观察|衔接|等你|等其表态/.test(motive);
}

function isTemplateNarrator(roleType: string, latestUserMessage: string, motive: string): boolean {
  return !latestUserMessage && roleType === "narrator" && isNarratorTemplateFriendly(motive);
}

function isTemplateWildcard(wildcard: boolean, latestUserMessage: string, motive: string): boolean {
  return !latestUserMessage && wildcard && isWildcardTemplateFriendly(motive);
}

// 根据当前角色和动机决定发言档位。这里优先把低风险、短承接轮次从 premium 中摘出来。
export function resolveSpeakerModeDecision(input: {
  role: SpeakerRouteRole;
  motive: string;
  latestUserMessage?: string;
}): SpeakerModeDecision {
  const motive = normalizeScalarText(input.motive);
  const latestUserMessage = normalizeScalarText(input.latestUserMessage);
  const roleType = sanitizeRoleType(input.role.roleType);
  const wildcard = roleActsAsWildcard(input.role);
  const keyRole = isClearlyKeyRole(input.role);
  const hasLatestUserInput = latestUserMessage.length > 0;

  if (keyRole) {
    return {
      mode: "premium",
      voiceMode: "async",
      memoryMode: "async",
      reason: "key_role_premium",
    };
  }

  if (hasLatestUserInput && (roleType === "npc" || roleType === "narrator")) {
    return {
      mode: "premium",
      voiceMode: "async",
      memoryMode: "async",
      reason: roleType === "narrator" ? "narrator_after_user_input" : "npc_after_user_input",
    };
  }

  if (isHighRiskPremiumMotive(motive)) {
    return {
      mode: "premium",
      voiceMode: "async",
      memoryMode: "async",
      reason: "high_risk_premium",
    };
  }

  if (isTemplateNarrator(roleType, latestUserMessage, motive)) {
    return {
      mode: "template",
      voiceMode: "async",
      memoryMode: "skip",
      reason: "narrator_template",
    };
  }

  if (isTemplateWildcard(wildcard, latestUserMessage, motive)) {
    return {
      mode: "template",
      voiceMode: "async",
      memoryMode: "skip",
      reason: "wildcard_template",
    };
  }

  if (!latestUserMessage && roleType === "narrator" && (isNarratorFastFriendly(motive) || shortMotive(motive))) {
    return {
      mode: "fast",
      voiceMode: "async",
      memoryMode: "skip",
      reason: "narrator_fast_bridge",
    };
  }

  if (!latestUserMessage && roleType === "npc" && wildcard) {
    return {
      mode: shortMotive(motive) ? "template" : "fast",
      voiceMode: "async",
      memoryMode: "skip",
      reason: shortMotive(motive) ? "wildcard_template_short_turn" : "wildcard_fast_turn",
    };
  }

  if (!latestUserMessage && roleType === "npc" && !wildcard && !keyRole && (isFastNpcMotive(motive) || shortMotive(motive))) {
    if (isHighRiskPremiumMotive(motive)) {
      return {
        mode: "premium",
        voiceMode: "async",
        memoryMode: "async",
        reason: "normal_npc_high_risk_premium",
      };
    }
    return {
      mode: "fast",
      voiceMode: "async",
      memoryMode: "skip",
      reason: "normal_npc_fast",
    };
  }

  if (roleType === "npc" && !wildcard) {
    return {
      mode: "premium",
      voiceMode: "async",
      memoryMode: "async",
      reason: keyRole ? "key_npc_premium" : "normal_npc_premium",
    };
  }

  return {
    mode: "fast",
    voiceMode: "async",
    memoryMode: "skip",
    reason: roleType === "narrator" ? "narrator_fast" : "default_fast",
  };
}

function cleanTemplateMotive(motive: string): string {
  return normalizeScalarText(motive)
    .replace(/^按当前阶段[“"].+?[”"]/, "")
    .replace(/^承接上一轮(?:的预期回合|局势)[，,]?/, "")
    .replace(/^顺着当前局势/, "")
    .replace(/^继续/, "")
    .trim();
}

// 模板直出只覆盖低风险轮次：旁白环境补句、万能角色起哄、功能性过场。
export function buildTemplateSpeakerContent(input: {
  role: SpeakerRouteRole;
  motive: string;
  latestUserMessage?: string;
}): string {
  const roleType = sanitizeRoleType(input.role.roleType);
  const motive = cleanTemplateMotive(input.motive);
  const roleName = normalizeScalarText(input.role.name) || "旁白";
  const wildcard = roleActsAsWildcard(input.role);

  if (roleType === "narrator") {
    if (/给用户观察时机|等待用户|观察时机|表态|桥接/.test(motive)) {
      return "(场上的哄笑声缓了半拍，一道道目光在你与萧炎之间来回扫动，显然都在等你的反应)";
    }
    if (/紧张|氛围|局势|现场|目光|空气|变化/.test(motive)) {
      return "(练武场上的气氛越绷越紧，四周的视线与窃笑声一并压了过来，谁都看得出这场冲突还没完)";
    }
    return "(场上的气氛仍在不断发酵，局势顺着眼前的冲突继续往前推去)";
  }

  if (wildcard) {
    if (/逼.*表态|表态|看笑话/.test(motive)) {
      return `(斜着眼朝你这边一瞥，嘴角挂着不怀好意的笑) ${roleName === "某男子" ? "新来的，别光站着看，你倒是说句话啊。" : "怎么，连你也不敢接这话了？"}`;
    }
    if (/挑衅|嘲讽|起哄|拱火|施压|逼问/.test(motive)) {
      return "(抱着胳膊嗤笑一声，故意把声音拔高了几分) 怎么，不敢接话了？";
    }
    return `(朝场中扬了扬下巴，顺着众人的哄笑继续拱火) ${roleName === "某男子" ? "这热闹可还没完呢。" : "怎么，这就想躲过去了？"}`;
  }

  return "(局势仍在向前推进)";
}
