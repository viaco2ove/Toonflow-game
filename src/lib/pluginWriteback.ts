/**
 * 插件小游戏结算写回：把经验 / 金钱 / 掉落奖励写入用户参数卡，
 * 以及所有「参展角色」的参数卡。
 *
 * 需求（#野外生存）：杀怪 / 开宝箱奖励写入用户和角色的角色参数卡；
 * 地上血瓶走过去回血（回血在插件本体 plugin_state 内处理，不走这里）。
 *
 * 只写一次：调用方用 result.written 标记，避免重复累加。
 */

function asRec(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {};
}

export function applyFieldSurvivalWriteback(
  state: any,
  result: any,
  selections: any,
): void {
  const exp = Number(result?.exp || 0) || 0;
  const money = Number(result?.money || 0) || 0;
  const drops = Array.isArray(result?.drops) ? result.drops.map(String).filter(Boolean) : [];
  if (exp <= 0 && money <= 0 && drops.length === 0) return;

  const patchCard = (cardRaw: unknown) => {
    const card = asRec(cardRaw);
    card.exp = Number(card.exp || 0) + exp;
    card.money = Number(card.money || 0) + money;
    const items = Array.isArray(card.items) ? card.items : [];
    for (const d of drops) {
      const exist = items.find((i: any) => String(i?.name ?? i) === d);
      if (exist && typeof exist === "object") exist.count = Number(exist.count || 0) + 1;
      else items.push({ name: d, count: 1, heal: 20 });
    }
    card.items = items;
    return card;
  };

  // 用户卡
  if (state?.player) state.player.parameterCardJson = patchCard(state.player.parameterCardJson);
  // 参展角色卡
  const npcs = asRec(state?.npcs);
  const partIds = Array.isArray(selections?.participants)
    ? selections.participants.map(String)
    : [];
  for (const key of Object.keys(npcs)) {
    const r = asRec(npcs[key]);
    const rid = String(r.id || r.role_id || "");
    const rname = String(r.name || r.role_name || "");
    if (partIds.includes(rid) || partIds.includes(rname)) {
      npcs[key].parameterCardJson = patchCard(r.parameterCardJson);
    }
  }
}
