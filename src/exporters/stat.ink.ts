import {
  AGENT_NAME,
  S3SI_VERSION,
  SPLATNET3_STATINK_MAP,
  USERAGENT,
} from "../constant.ts";
import {
  Color,
  CoopHistoryDetail,
  CoopHistoryPlayerResult,
  CoopInfo,
  ExportResult,
  Game,
  GameExporter,
  Image,
  PlayerGear,
  StatInkAbility,
  StatInkCoopPlayer,
  StatInkCoopPostBody,
  StatInkCoopWave,
  StatInkGear,
  StatInkGears,
  StatInkPlayer,
  StatInkPostBody,
  StatInkPostResponse,
  StatInkStage,
  StatInkUuidList,
  StatInkWeapon,
  VsHistoryDetail,
  VsInfo,
  VsPlayer,
} from "../types.ts";
import { msgpack, Mutex } from "../../deps.ts";
import { APIError } from "../APIError.ts";
import {
  b64Number,
  gameId,
  nonNullable,
  s3sCoopGameId,
  s3siGameId,
  urlSimplify,
} from "../utils.ts";
import { Env } from "../env.ts";

const COOP_POINT_MAP: Record<number, number | undefined> = {
  0: -20,
  1: -10,
  2: 0,
  3: 20,
};

async function checkResponse(resp: Response) {
  // 200~299
  if (Math.floor(resp.status / 100) !== 2) {
    const json = await resp.json().catch(() => undefined);
    throw new APIError({
      response: resp,
      json,
      message: "Failed to fetch data from stat.ink",
    });
  }
}

class StatInkAPI {
  statInk = "https://stat.ink";
  FETCH_LOCK = new Mutex();
  cache: Record<string, unknown> = {};

  constructor(private statInkApiKey: string, private env: Env) {
    if (statInkApiKey.length !== 43) {
      throw new Error("Invalid stat.ink API key");
    }
  }

  requestHeaders() {
    return {
      "User-Agent": USERAGENT,
      "Authorization": `Bearer ${this.statInkApiKey}`,
    };
  }

  async uuidList(type: Game["type"]): Promise<string[]> {
    const fetch = this.env.newFetcher();
    const response = await fetch.get({
      url: type === "VsInfo"
        ? `${this.statInk}/api/v3/s3s/uuid-list`
        : `${this.statInk}/api/v3/salmon/uuid-list`,
      headers: this.requestHeaders(),
    });
    await checkResponse(response);

    const uuidResult: StatInkUuidList = await response.json();

    if (!Array.isArray(uuidResult)) {
      throw new APIError({
        response,
        json: uuidResult,
        message: uuidResult.message,
      });
    }

    return uuidResult;
  }

  async postBattle(body: StatInkPostBody) {
    const fetch = this.env.newFetcher();
    const resp = await fetch.post({
      url: `${this.statInk}/api/v3/battle`,
      headers: {
        ...this.requestHeaders(),
        "Content-Type": "application/x-msgpack",
      },
      body: msgpack.encode(body),
    });

    const json: StatInkPostResponse = await resp.json().catch(() => ({}));

    if (resp.status !== 200 && resp.status !== 201) {
      throw new APIError({
        response: resp,
        message: "Failed to export battle",
        json,
      });
    }

    if (json.error) {
      throw new APIError({
        response: resp,
        message: "Failed to export battle",
        json,
      });
    }

    return json;
  }

  async postCoop(body: StatInkCoopPostBody) {
    const fetch = this.env.newFetcher();
    const resp = await fetch.post({
      url: `${this.statInk}/api/v3/salmon`,
      headers: {
        ...this.requestHeaders(),
        "Content-Type": "application/x-msgpack",
      },
      body: msgpack.encode(body),
    });

    const json: StatInkPostResponse = await resp.json().catch(() => ({}));

    if (resp.status !== 200 && resp.status !== 201) {
      throw new APIError({
        response: resp,
        message: "Failed to export battle",
        json,
      });
    }

    if (json.error) {
      throw new APIError({
        response: resp,
        message: "Failed to export battle",
        json,
      });
    }

    return json;
  }

  async _getCached<T>(url: string): Promise<T> {
    const release = await this.FETCH_LOCK.acquire();
    try {
      if (this.cache[url]) {
        return this.cache[url] as T;
      }
      const fetch = this.env.newFetcher();
      const resp = await fetch.get({
        url,
        headers: this.requestHeaders(),
      });
      await checkResponse(resp);
      const json = await resp.json();
      this.cache[url] = json;
      return json;
    } finally {
      release();
    }
  }

  // Splatnet returns `14式竹筒槍‧甲`, and stat.ink returns `14式竹筒槍·甲`.
  // Maybe a typo of splatnet?
  private _getAliasName(name: string): string[] {
    const STAT_INK_DOT = "·";
    const SPLATNET_DOT = "‧";

    if (name.includes(STAT_INK_DOT)) {
      return [name, name.replaceAll(STAT_INK_DOT, SPLATNET_DOT)];
    } else {
      return [name];
    }
  }

  _salmonWeaponMap = new Map<string, string>();
  async getSalmonWeaponMap() {
    if (this._salmonWeaponMap.size === 0) {
      const weapons = await this.getSalmonWeapon();
      for (const weapon of weapons) {
        for (
          const name of Object.values(weapon.name).flatMap((n) =>
            this._getAliasName(n)
          )
        ) {
          const prevKey = this._salmonWeaponMap.get(name);
          if (prevKey !== undefined && prevKey !== weapon.key) {
            console.warn(`Duplicate weapon name: ${name}`);
          }
          this._salmonWeaponMap.set(name, weapon.key);
        }
      }
      if (this._salmonWeaponMap.size === 0) {
        throw new Error("Failed to get salmon weapon map");
      }
    }
    return this._salmonWeaponMap;
  }
  getSalmonWeapon = () =>
    this._getCached<StatInkWeapon>(
      `${this.statInk}/api/v3/salmon/weapon?full=1`,
    );
  getWeapon = () =>
    this._getCached<StatInkWeapon>(`${this.statInk}/api/v3/weapon?full=1`);
  getAbility = () =>
    this._getCached<StatInkAbility>(`${this.statInk}/api/v3/ability?full=1`);
  getStage = () =>
    this._getCached<StatInkStage>(`${this.statInk}/api/v3/stage`);
}

export type NameDict = {
  gearPower: Record<string, number | undefined>;
};

/**
 * Exporter to stat.ink.
 *
 * This is the default exporter. It will upload each battle detail to stat.ink.
 */
export class StatInkExporter implements GameExporter {
  name = "stat.ink";
  private api: StatInkAPI;
  private uploadMode: string;

  constructor(
    { statInkApiKey, uploadMode, env }: {
      statInkApiKey: string;
      uploadMode: string;
      env: Env;
    },
  ) {
    this.api = new StatInkAPI(statInkApiKey, env);
    this.uploadMode = uploadMode;
  }
  isTriColor({ vsMode }: VsHistoryDetail): boolean {
    return vsMode.mode === "FEST" && b64Number(vsMode.id) === 8;
  }
  async exportGame(game: Game): Promise<ExportResult> {
    if (game.type === "VsInfo") {
      const body = await this.mapBattle(game);
      const { url } = await this.api.postBattle(body);

      return {
        status: "success",
        url,
      };
    } else {
      const body = await this.mapCoop(game);
      const { url } = await this.api.postCoop(body);

      return {
        status: "success",
        url,
      };
    }
  }
  async notExported(
    { type, list }: { list: string[]; type: Game["type"] },
  ): Promise<string[]> {
    const uuid = await this.api.uuidList(type);

    const out: string[] = [];

    for (const id of list) {
      const s3sId = await gameId(id);
      const s3siId = await s3siGameId(id);
      const s3sCoopId = await s3sCoopGameId(id);

      if (
        !uuid.includes(s3sId) && !uuid.includes(s3siId) &&
        !uuid.includes(s3sCoopId)
      ) {
        out.push(id);
      }
    }

    return out;
  }
  mapLobby(vsDetail: VsHistoryDetail): StatInkPostBody["lobby"] {
    const { mode: vsMode } = vsDetail.vsMode;
    if (vsMode === "REGULAR") {
      return "regular";
    } else if (vsMode === "BANKARA") {
      const { mode } = vsDetail.bankaraMatch ?? { mode: "UNKNOWN" };
      const map = {
        OPEN: "bankara_open",
        CHALLENGE: "bankara_challenge",
        UNKNOWN: "",
      } as const;
      const result = map[mode];
      if (result) {
        return result;
      }
    } else if (vsMode === "PRIVATE") {
      return "private";
    } else if (vsMode === "FEST") {
      const modeId = b64Number(vsDetail.vsMode.id);
      if (modeId === 6) {
        return "splatfest_open";
      } else if (modeId === 7) {
        return "splatfest_challenge";
      } else if (modeId === 8) {
        return "splatfest_open";
      }
    } else if (vsMode === "X_MATCH") {
      return "xmatch";
    }

    throw new TypeError(`Unknown vsMode ${vsMode}`);
  }
  async mapStage({ vsStage }: VsHistoryDetail): Promise<string> {
    const id = b64Number(vsStage.id).toString();
    const stage = await this.api.getStage();

    const result = stage.find((s) => s.aliases.includes(id));

    if (!result) {
      throw new Error("Unknown stage: " + vsStage.name);
    }

    return result.key;
  }
  async mapGears(
    { headGear, clothingGear, shoesGear }: VsPlayer,
  ): Promise<StatInkGears> {
    const amap = (await this.api.getAbility()).map((i) => ({
      ...i,
      names: Object.values(i.name),
    }));
    const mapAbility = ({ name }: { name: string }): string | null => {
      const result = amap.find((a) => a.names.includes(name));
      if (!result) {
        return null;
      }
      return result.key;
    };
    const mapGear = (
      { primaryGearPower, additionalGearPowers }: PlayerGear,
    ): StatInkGear => {
      const primary = mapAbility(primaryGearPower);
      if (!primary) {
        throw new Error("Unknown ability: " + primaryGearPower.name);
      }
      return {
        primary_ability: primary,
        secondary_abilities: additionalGearPowers.map(mapAbility),
      };
    };
    return {
      headgear: mapGear(headGear),
      clothing: mapGear(clothingGear),
      shoes: mapGear(shoesGear),
    };
  }
  mapPlayer = async (
    player: VsPlayer,
    index: number,
  ): Promise<StatInkPlayer> => {
    const result: StatInkPlayer = {
      me: player.isMyself ? "yes" : "no",
      rank_in_team: index + 1,
      name: player.name,
      number: player.nameId ?? undefined,
      splashtag_title: player.byname,
      weapon: b64Number(player.weapon.id).toString(),
      inked: player.paint,
      gears: await this.mapGears(player),
      crown: player.crown ? "yes" : "no",
      disconnected: player.result ? "no" : "yes",
    };
    if (player.result) {
      result.kill_or_assist = player.result.kill;
      result.assist = player.result.assist;
      result.kill = result.kill_or_assist - result.assist;
      result.death = player.result.death;
      result.signal = player.result.noroshiTry ?? undefined;
      result.special = player.result.special;
    }
    return result;
  };
  async mapBattle(
    {
      groupInfo,
      challengeProgress,
      bankaraMatchChallenge,
      listNode,
      detail: vsDetail,
      rankBeforeState,
      rankState,
    }: VsInfo,
  ): Promise<StatInkPostBody> {
    const {
      knockout,
      vsRule: { rule },
      myTeam,
      otherTeams,
      bankaraMatch,
      festMatch,
      playedTime,
    } = vsDetail;

    const self = vsDetail.myTeam.players.find((i) => i.isMyself);
    if (!self) {
      throw new Error("Self not found");
    }
    const startedAt = Math.floor(new Date(playedTime).getTime() / 1000);

    if (otherTeams.length === 0) {
      throw new Error(`Other teams is empty`);
    }

    const result: StatInkPostBody = {
      uuid: await gameId(vsDetail.id),
      lobby: this.mapLobby(vsDetail),
      rule: SPLATNET3_STATINK_MAP.RULE[vsDetail.vsRule.rule],
      stage: await this.mapStage(vsDetail),
      result: SPLATNET3_STATINK_MAP.RESULT[vsDetail.judgement],

      weapon: b64Number(self.weapon.id).toString(),
      inked: self.paint,
      rank_in_team: vsDetail.myTeam.players.indexOf(self) + 1,

      medals: vsDetail.awards.map((i) => i.name),

      our_team_players: await Promise.all(myTeam.players.map(this.mapPlayer)),
      their_team_players: await Promise.all(
        otherTeams[0].players.map(
          this.mapPlayer,
        ),
      ),

      agent: AGENT_NAME,
      agent_version: S3SI_VERSION,
      agent_variables: {
        "Upload Mode": this.uploadMode,
      },
      automated: "yes",
      start_at: startedAt,
      end_at: startedAt + vsDetail.duration,
    };

    if (self.result) {
      result.kill_or_assist = self.result.kill;
      result.assist = self.result.assist;
      result.kill = result.kill_or_assist - result.assist;
      result.death = self.result.death;
      result.signal = self.result.noroshiTry ?? undefined;
      result.special = self.result.special;
    }

    result.our_team_color = this.mapColor(myTeam.color);
    result.their_team_color = this.mapColor(otherTeams[0].color);
    if (otherTeams.length === 2) {
      result.third_team_color = this.mapColor(otherTeams[1].color);
    }

    if (festMatch) {
      result.fest_dragon =
        SPLATNET3_STATINK_MAP.DRAGON[festMatch.dragonMatchType];
      result.clout_change = festMatch.contribution;
      result.fest_power = festMatch.myFestPower ?? undefined;
    }
    if (rule === "TURF_WAR" || rule === "TRI_COLOR") {
      result.our_team_percent = (myTeam?.result?.paintRatio ?? 0) * 100;
      result.their_team_percent = (otherTeams?.[0]?.result?.paintRatio ?? 0) *
        100;
      result.our_team_inked = myTeam.players.reduce(
        (acc, i) => acc + i.paint,
        0,
      );
      result.their_team_inked = otherTeams?.[0].players.reduce(
        (acc, i) => acc + i.paint,
        0,
      );

      if (myTeam.festTeamName) {
        result.our_team_theme = myTeam.festTeamName;
      }
      if (myTeam.tricolorRole) {
        result.our_team_role = myTeam.tricolorRole === "DEFENSE"
          ? "defender"
          : "attacker";
      }
      if (otherTeams[0].festTeamName) {
        result.their_team_theme = otherTeams[0].festTeamName;
      }
      if (otherTeams[0].tricolorRole) {
        result.their_team_role = otherTeams[0].tricolorRole === "DEFENSE"
          ? "defender"
          : "attacker";
      }

      if (otherTeams.length === 2) {
        result.third_team_players = await Promise.all(
          otherTeams[1].players.map(
            this.mapPlayer,
          ),
        );
        result.third_team_percent = (otherTeams[1]?.result?.paintRatio ?? 0) *
          100;
        result.third_team_inked = otherTeams[1].players.reduce(
          (acc, i) => acc + i.paint,
          0,
        );
        if (otherTeams[1].festTeamName) {
          result.third_team_theme = otherTeams[1].festTeamName;
        }
        if (otherTeams[1].tricolorRole) {
          result.third_team_role = otherTeams[1].tricolorRole === "DEFENSE"
            ? "defender"
            : "attacker";
        }
      }
    }
    if (knockout) {
      result.knockout = knockout === "NEITHER" ? "no" : "yes";
    }
    result.our_team_count = myTeam?.result?.score ?? undefined;
    result.their_team_count = otherTeams?.[0]?.result?.score ?? undefined;
    result.rank_exp_change = bankaraMatch?.earnedUdemaePoint ?? undefined;
    if (listNode?.udemae) {
      [result.rank_before, result.rank_before_s_plus] = parseUdemae(
        listNode.udemae,
      );
    }
    if (bankaraMatchChallenge && challengeProgress) {
      result.rank_up_battle = bankaraMatchChallenge.isPromo ? "yes" : "no";

      if (challengeProgress.index === 0 && bankaraMatchChallenge.udemaeAfter) {
        [result.rank_after, result.rank_after_s_plus] = parseUdemae(
          bankaraMatchChallenge.udemaeAfter,
        );
        result.rank_exp_change = bankaraMatchChallenge.earnedUdemaePoint ??
          undefined;
      } else {
        result.rank_after = result.rank_before;
        result.rank_after_s_plus = result.rank_before_s_plus;
      }
    }

    if (challengeProgress) {
      result.challenge_win = challengeProgress.winCount;
      result.challenge_lose = challengeProgress.loseCount;
    }

    if (vsDetail.xMatch) {
      result.x_power_before = result.x_power_after = vsDetail.xMatch.lastXPower;

      if (
        groupInfo?.xMatchMeasurement &&
        groupInfo?.xMatchMeasurement.state === "COMPLETED" &&
        challengeProgress?.index === 0
      ) {
        result.x_power_after = groupInfo.xMatchMeasurement.xPowerAfter;
      }
    }

    if (rankBeforeState && rankState) {
      result.rank_before_exp = rankBeforeState.rankPoint;
      result.rank_after_exp = rankState.rankPoint;

      // splatnet returns null, so we need to calculate it.
      // don't calculate if it's a promotion battle.
      if (
        !bankaraMatchChallenge?.isUdemaeUp &&
        result.rank_exp_change === undefined
      ) {
        result.rank_exp_change = result.rank_after_exp - result.rank_before_exp;
      }

      if (!result.rank_after) {
        [result.rank_after, result.rank_after_s_plus] = parseUdemae(
          rankState.rank,
        );
      }
    }

    return result;
  }
  mapColor(color: Color): string | undefined {
    const float2hex = (i: number) =>
      Math.round(i * 255).toString(16).padStart(2, "0");
    // rgba
    const nums = [color.r, color.g, color.b, color.a];
    return nums.map(float2hex).join("");
  }
  isRandom(image: Image | null): boolean {
    // question mark
    const RANDOM_FILENAME =
      "473fffb2442075078d8bb7125744905abdeae651b6a5b7453ae295582e45f7d1";
    // file exporter will replace url to { pathname: string } | string
    const url = image?.url as ReturnType<typeof urlSimplify> | undefined | null;
    if (typeof url === "string") {
      return url.includes(RANDOM_FILENAME);
    } else if (url === undefined || url === null) {
      return false;
    } else {
      return url.pathname.includes(RANDOM_FILENAME);
    }
  }
  async mapCoopWeapon(
    { name, image }: { name: string; image: Image | null },
  ): Promise<string | null> {
    const weaponMap = await this.api.getSalmonWeaponMap();
    const weapon = weaponMap.get(name);

    if (!weapon) {
      if (this.isRandom(image)) {
        return null;
      }
      throw new Error(`Weapon not found: ${name}`);
    }

    return weapon;
  }
  mapSpecial({ name, image }: {
    image: Image;
    name: string;
  }): Promise<string | undefined> {
    const { url } = image;
    const imageName = typeof url === "object" ? url.pathname : url ?? "";
    const hash = /\/(\w+)_0\.\w+/.exec(imageName)?.[1] ?? "";
    const special = SPLATNET3_STATINK_MAP.COOP_SPECIAL_MAP[hash];

    if (!special) {
      if (this.isRandom(image)) {
        return Promise.resolve(undefined);
      }
      throw new Error(`Special not found: ${name} (${imageName})`);
    }

    return Promise.resolve(special);
  }
  async mapCoopPlayer(isMyself: boolean, {
    player,
    weapons,
    specialWeapon,
    defeatEnemyCount,
    deliverCount,
    goldenAssistCount,
    goldenDeliverCount,
    rescueCount,
    rescuedCount,
  }: CoopHistoryPlayerResult): Promise<StatInkCoopPlayer> {
    const disconnected = [
      goldenDeliverCount,
      deliverCount,
      rescueCount,
      rescuedCount,
      defeatEnemyCount,
    ].every((v) => v === 0) || !specialWeapon;

    return {
      me: isMyself ? "yes" : "no",
      name: player.name,
      number: player.nameId,
      splashtag_title: player.byname,
      uniform: b64Number(player.uniform.id).toString(),
      special: specialWeapon ? await this.mapSpecial(specialWeapon) : undefined,
      weapons: await Promise.all(weapons.map((w) => this.mapCoopWeapon(w))),
      golden_eggs: goldenDeliverCount,
      golden_assist: goldenAssistCount,
      power_eggs: deliverCount,
      rescue: rescueCount,
      rescued: rescuedCount,
      defeat_boss: defeatEnemyCount,
      disconnected: disconnected ? "yes" : "no",
    };
  }
  mapKing(id?: string) {
    if (!id) {
      return undefined;
    }
    const nid = b64Number(id).toString();

    return nid;
  }
  async mapWave(
    wave: CoopHistoryDetail["waveResults"]["0"],
  ): Promise<StatInkCoopWave> {
    const event = wave.eventWave
      ? SPLATNET3_STATINK_MAP.COOP_EVENT_MAP[b64Number(wave.eventWave.id)]
      : undefined;
    const special_uses = (await Promise.all(
      wave.specialWeapons.map((w) => this.mapSpecial(w)),
    ))
      .flatMap((key) => key ? [key] : [])
      .reduce((p, key) => ({
        ...p,
        [key]: (p[key] ?? 0) + 1,
      }), {} as Record<string, number | undefined>) as Record<string, number>;

    return {
      tide: SPLATNET3_STATINK_MAP.WATER_LEVEL_MAP[wave.waterLevel],
      event,
      golden_quota: wave.deliverNorm,
      golden_appearances: wave.goldenPopCount,
      golden_delivered: wave.teamDeliverCount,
      special_uses,
      // fill it later
      danger_rate: null,
    };
  }
  async mapCoop(
    {
      gradeBefore,
      groupInfo,
      detail,
    }: CoopInfo,
  ): Promise<StatInkCoopPostBody> {
    const {
      dangerRate,
      resultWave,
      bossResult,
      myResult,
      memberResults,
      scale,
      playedTime,
      enemyResults,
      smellMeter,
      waveResults,
    } = detail;

    const startedAt = Math.floor(new Date(playedTime).getTime() / 1000);
    const golden_eggs = waveResults.reduce(
      (prev, i) => prev + i.teamDeliverCount,
      0,
    );
    const power_eggs = myResult.deliverCount +
      memberResults.reduce((p, i) => p + i.deliverCount, 0);
    const bosses = Object.fromEntries(
      enemyResults.map((
        i,
      ) => [b64Number(i.enemy.id), {
        appearances: i.popCount,
        defeated: i.teamDefeatCount,
        defeated_by_me: i.defeatCount,
      }]),
    );
    const title_after = detail.afterGrade
      ? b64Number(detail.afterGrade.id).toString()
      : undefined;
    const title_exp_after = detail.afterGradePoint;

    const maxWaves = detail.rule === "TEAM_CONTEST" ? 5 : 3;
    let clear_waves: number;
    if (waveResults.length > 0) {
      // when cleared, resultWave === 0, so we need to add 1.
      clear_waves = waveResults.filter((i) =>
        i.waveNumber < maxWaves + 1
      ).length -
        1 + (resultWave === 0 ? 1 : 0);
    } else {
      clear_waves = 0;
    }

    let title_before: string | undefined = undefined;
    let title_exp_before: number | undefined = undefined;

    if (gradeBefore) {
      title_before = b64Number(gradeBefore.grade.id).toString();
      title_exp_before = gradeBefore.gradePoint;
    } else {
      const expDiff = COOP_POINT_MAP[clear_waves];

      if (
        nonNullable(title_after) && nonNullable(title_exp_after) &&
        nonNullable(expDiff)
      ) {
        if (title_exp_after === 40 && expDiff === 20) {
          // 20 -> 40 or ?(rank up) -> 40
        } else if (
          title_exp_after === 40 && expDiff < 0 && title_after !== "8"
        ) {
          // 60,50 -> 40 or ?(rank down) to 40
        } else if (title_exp_after === 999 && expDiff !== 0) {
          // 980,990 -> 999
          title_before = title_after;
        } else {
          if (title_exp_after - expDiff >= 0) {
            title_before = title_after;
            title_exp_before = title_exp_after - expDiff;
          } else {
            title_before = (parseInt(title_after) - 1).toString();
          }
        }
      }
    }

    let fail_reason: StatInkCoopPostBody["fail_reason"] = null;
    // failed
    if (clear_waves !== maxWaves && waveResults.length > 0) {
      const lastWave = waveResults[waveResults.length - 1];
      if (lastWave.teamDeliverCount >= lastWave.deliverNorm) {
        fail_reason = "wipe_out";
      }
    }

    const result: StatInkCoopPostBody = {
      uuid: await gameId(detail.id),
      private: groupInfo?.mode === "PRIVATE_CUSTOM" ? "yes" : "no",
      big_run: detail.rule === "BIG_RUN" ? "yes" : "no",
      eggstra_work: detail.rule === "TEAM_CONTEST" ? "yes" : "no",
      stage: b64Number(detail.coopStage.id).toString(),
      danger_rate: detail.rule === "TEAM_CONTEST" ? null : dangerRate * 100,
      clear_waves,
      fail_reason,
      king_smell: smellMeter,
      king_salmonid: this.mapKing(detail.bossResult?.boss.id),
      clear_extra: bossResult?.hasDefeatBoss ? "yes" : "no",
      title_before,
      title_exp_before,
      title_after,
      title_exp_after,
      golden_eggs,
      power_eggs,
      gold_scale: scale?.gold,
      silver_scale: scale?.silver,
      bronze_scale: scale?.bronze,
      job_point: detail.jobPoint,
      job_score: detail.jobScore,
      job_rate: detail.jobRate,
      job_bonus: detail.jobBonus,
      waves: await Promise.all(waveResults.map((w) => this.mapWave(w))),
      players: await Promise.all([
        this.mapCoopPlayer(true, myResult),
        ...memberResults.map((p) => this.mapCoopPlayer(false, p)),
      ]),
      bosses,
      agent: AGENT_NAME,
      agent_version: S3SI_VERSION,
      agent_variables: {
        "Upload Mode": this.uploadMode,
      },
      automated: "yes",
      start_at: startedAt,
    };
    // caculate wave danger_rate.
    // translated from here: https://github.com/frozenpandaman/s3s/commit/d46ece00e5a7706688eaf025f18c5a8ea1c54c0f#diff-819571ec7b067d2398cd1f9dbc737160312efc4128ba4a2f0e165c70225dea0eR1050
    if (detail.rule === "TEAM_CONTEST") {
      let lastWave: StatInkCoopWave | undefined;
      for (
        const [wave] of result.waves
          .map((p, i) => [p, i] as const)
      ) {
        let haz_level: number;
        if (!lastWave) {
          haz_level = 60;
        } else {
          const num_players = result.players.length;
          const quota = lastWave.golden_quota; // last wave, most recent one added to the list
          const delivered = lastWave.golden_delivered;
          let added_percent = 0; // default, no increase if less than 1.5x quota delivered
          if (num_players == 4) {
            if (delivered >= quota * 2) {
              added_percent = 60;
            } else if (delivered >= quota * 1.5) {
              added_percent = 30;
            }
          } else if (num_players == 3) {
            if (delivered >= quota * 2) {
              added_percent = 40;
            } else if (delivered >= quota * 1.5) {
              added_percent = 20;
            }
          } else if (num_players == 2) {
            if (delivered >= quota * 2) {
              added_percent = 20;
            } else if (delivered >= quota * 1.5) {
              added_percent = 10;
              added_percent = 5;
            }
          } else if (num_players == 1) {
            if (delivered >= quota * 2) {
              added_percent = 10;
            } else if (delivered >= quota * 1.5) {
              added_percent = 5;
            }
          }

          const prev_percent = lastWave.danger_rate!;

          haz_level = prev_percent + added_percent;
        }
        wave.danger_rate = haz_level;
        lastWave = wave;
      }
    }
    return result;
  }
}

function parseUdemae(udemae: string): [string, number | undefined] {
  const [rank, rankNum] = udemae.split(/([0-9]+)/);
  return [
    rank.toLowerCase(),
    rankNum === undefined ? undefined : parseInt(rankNum),
  ];
}
