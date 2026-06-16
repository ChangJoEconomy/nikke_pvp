/*
 * Standalone NIKKE burst charge calculator core.
 *
 * This file intentionally has no React/UI dependencies. It loads character data
 * from data/nikke_data.json and implements the base charge event logic
 * used by nikke.top's bundled HomePage calculator.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NikkeChargeCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WeaponType = Object.freeze({
    Shotgun: "SG",
    RocketLauncher: "RL",
    SniperRifle: "SR",
    AssaultRifle: "AR",
    SubmachineGun: "SMG",
    MachineGun: "MG",
  });

  const Position = Object.freeze({ P1: 0, P2: 1, P3: 2, P4: 3, P5: 4 });
  const Side = Object.freeze({ Attacker: 0, Defender: 1 });

  const FRAME_REDUCTION_BY_CHARGE_SPEED = Object.freeze({
    0: 0,
    1: 0,
    2: 2,
    3: 2,
    4: 2,
    5: 4,
    6: 4,
    7: 4,
    8: 6,
    9: 6,
    10: 6,
    11: 8,
    12: 8,
    13: 8,
    14: 8,
    15: 10,
    16: 10,
    17: 10,
    18: 12,
    19: 12,
    20: 12,
    21: 14,
    22: 14,
    23: 14,
    24: 14,
    25: 16,
    26: 16,
    27: 16,
    28: 18,
    29: 18,
    30: 18,
    31: 20,
    32: 20,
    33: 20,
    34: 20,
    35: 22,
    36: 22,
    37: 22,
    38: 24,
    39: 24,
    40: 24,
    41: 26,
    42: 26,
    43: 26,
    44: 28,
    45: 28,
    46: 28,
  });

  const DEFAULT_CONFIG = Object.freeze({
    speed1: "0",
    speed2: "0",
    speed3: "0",
    speed4: "0",
    cube: { cubeType: "none", cubeValue: "0" },
    scarletCounterAttackEnabled: true,
    redHoodPenetrationLevel: 0,
  });

  function weaponTypeFromId(weaponId) {
    switch (Number(weaponId)) {
      case 1:
        return WeaponType.Shotgun;
      case 2:
        return WeaponType.RocketLauncher;
      case 3:
        return WeaponType.SniperRifle;
      case 4:
        return WeaponType.AssaultRifle;
      case 5:
        return WeaponType.SubmachineGun;
      case 6:
        return WeaponType.MachineGun;
      default:
        throw new Error("Unknown weapon type: " + weaponId);
    }
  }

  function normalizeCharacter(raw, serverRegion) {
    return {
      ...raw,
      serverRegion: serverRegion || raw.serverRegion || "global",
      phase: raw.burst,
      weaponType: raw.weaponType || weaponTypeFromId(raw.weapon),
      hitsPerCharacter: raw.hitsPerCharacter || 1,
      attackInterval: raw.attackInterval || 60,
      baseChargeRate: raw.baseChargeRate || 0,
      chargeMultiplier: raw.chargeMultiplier || 1,
    };
  }

  async function loadCharacters(url) {
    const dataUrl = url || "data/nikke_data.json";

    if (typeof window !== "undefined" && typeof fetch === "function") {
      const response = await fetch(dataUrl);
      if (!response.ok) {
        throw new Error("Failed to load characters: " + response.status);
      }
      const json = await response.json();
      const characters = Array.isArray(json) ? json : json.global || [];
      return characters.map((character) =>
        normalizeCharacter(character, "global")
      );
    }

    const fs = require("fs");
    const path = require("path");
    const resolved = path.resolve(process.cwd(), dataUrl);
    const json = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const characters = Array.isArray(json) ? json : json.global || [];
    return characters.map((character) => normalizeCharacter(character, "global"));
  }

  function findCharacter(characters, query) {
    const needle = String(query).toLowerCase();
    return characters.find((character) => {
      const names = Object.values(character.name || {}).map((name) =>
        String(name).toLowerCase()
      );
      return String(character.id).toLowerCase() === needle || names.includes(needle);
    });
  }

  function frameReduction(chargeSpeed) {
    const key = Math.max(0, Math.min(46, Math.floor(Number(chargeSpeed) || 0)));
    return FRAME_REDUCTION_BY_CHARGE_SPEED[key] || 0;
  }

  function liberalioFrameReduction(chargeSpeed) {
    if (chargeSpeed === 10) return 8;
    if (chargeSpeed >= 18 && chargeSpeed <= 20) return 14;
    if (chargeSpeed >= 21 && chargeSpeed <= 24) return 16;
    return frameReduction(chargeSpeed);
  }

  function totalChargeSpeed(config, extraSpeeds) {
    const source = [
      config.speed1,
      config.speed2,
      config.speed3,
      config.speed4,
      config.cube && config.cube.cubeType === "adjutant"
        ? config.cube.cubeValue
        : "0",
    ];

    if (Array.isArray(extraSpeeds)) {
      source.push(...extraSpeeds);
    }

    const totalsByValue = new Map();
    for (const value of source) {
      const parsed = parseFloat(value) || 0;
      if (parsed > 0) {
        totalsByValue.set(parsed, (totalsByValue.get(parsed) || 0) + parsed);
      }
    }

    return Array.from(totalsByValue.values())
      .map((value) => Math.round(value))
      .reduce((sum, value) => sum + value, 0);
  }

  function quantumMultiplier(config) {
    const cube = config.cube || DEFAULT_CONFIG.cube;
    return 1 + (cube.cubeType === "quantum" ? parseFloat(cube.cubeValue) || 0 : 0) / 100;
  }

  function mergeConfig(config) {
    return {
      ...DEFAULT_CONFIG,
      ...(config || {}),
      cube: { ...DEFAULT_CONFIG.cube, ...((config && config.cube) || {}) },
    };
  }

  function rocketLauncherHitDelay(character, sourcePosition, side) {
    if (character.weaponType !== WeaponType.RocketLauncher) return 0;
    if (character.id === "003") return 10;
    if (character.id === "053T" || character.id === "053") return 6;

    if (side === Side.Attacker) {
      return sourcePosition === Position.P1 || sourcePosition === Position.P2 ? 16 : 14;
    }

    if (sourcePosition === Position.P1 || sourcePosition === Position.P2) return 16;
    if (sourcePosition === Position.P3 || sourcePosition === Position.P4) return 14;
    return 12;
  }

  function targetPositions(character, side) {
    const hits = character.hitsPerCharacter || 1;
    const weapon = character.weaponType;
    const targets = [];

    if (side === Side.Attacker) {
      if (weapon === WeaponType.SniperRifle) {
        targets.push({ position: Position.P5, hitCount: hits });
      } else if (weapon === WeaponType.RocketLauncher) {
        targets.push({ position: Position.P1, hitCount: hits });
        targets.push({ position: Position.P2, hitCount: hits });
      } else if (
        weapon === WeaponType.SubmachineGun ||
        weapon === WeaponType.MachineGun ||
        weapon === WeaponType.Shotgun ||
        weapon === WeaponType.AssaultRifle
      ) {
        targets.push({ position: Position.P1, hitCount: hits });
      }
      return targets;
    }

    if (weapon === WeaponType.Shotgun) {
      targets.push({ position: Position.P5, hitCount: hits });
    } else if (weapon === WeaponType.RocketLauncher) {
      targets.push({ position: Position.P1, hitCount: hits });
      targets.push({ position: Position.P2, hitCount: hits });
    } else if (weapon === WeaponType.SniperRifle) {
      targets.push({ position: Position.P1, hitCount: hits });
    } else if (
      weapon === WeaponType.SubmachineGun ||
      weapon === WeaponType.MachineGun ||
      weapon === WeaponType.AssaultRifle
    ) {
      targets.push({ position: Position.P1, hitCount: hits });
    }

    return targets;
  }

  function extraRocketTargets(side) {
    return side === Side.Attacker
      ? [
          { position: Position.P1, hitCount: 1 },
          { position: Position.P2, hitCount: 1 },
        ]
      : [
          { position: Position.P4, hitCount: 1 },
          { position: Position.P5, hitCount: 1 },
        ];
  }

  function event(frame, charge, character, sourcePosition, targetPositions, side, weaponType) {
    return {
      frame,
      charge,
      sourcePosition,
      targetPositions,
      weaponType: weaponType || character.weaponType,
      side,
    };
  }

  function machineGunEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const base = character.baseChargeRate * multiplier;
    const events = [];
    const isModernia = character.id === "011";
    const hitMultiplier = isModernia ? 2 : 1;

    const fixedBursts = [
      { frame: 96, hits: 12 },
      { frame: 152, hits: 22 },
      { frame: 180, hits: 14 },
    ];

    for (const burst of fixedBursts) {
      if (burst.frame <= maxFrame) {
        events.push({
          frame: burst.frame,
          charge: base * burst.hits * hitMultiplier,
          sourcePosition,
          targetPositions: [{ position: Position.P1, hitCount: burst.hits * hitMultiplier }],
          weaponType: character.weaponType,
          side,
        });
      }
    }

    for (let frame = 182; frame <= maxFrame; frame += 2) {
      events.push({
        frame,
        charge: base,
        sourcePosition,
        targetPositions: [{ position: Position.P1, hitCount: hitMultiplier }],
        weaponType: character.weaponType,
        side,
      });
    }

    return events;
  }

  function calculateChargeEvents(character, config, maxFrame, sourcePosition, side) {
    const normalized = normalizeCharacter(character);
    const mergedConfig = mergeConfig(config);
    const max = Number(maxFrame) || 597;
    const position = sourcePosition == null ? Position.P1 : sourcePosition;
    const teamSide = side == null ? Side.Attacker : side;

    const special = calculateSpecialChargeEvents(
      normalized,
      mergedConfig,
      max,
      position,
      teamSide
    );
    if (special) return special;

    if (normalized.weaponType === WeaponType.MachineGun) {
      return machineGunEvents(normalized, mergedConfig, max, position, teamSide);
    }

    let interval = normalized.attackInterval;
    let turnFrame = 0;

    if (
      normalized.weaponType === WeaponType.RocketLauncher ||
      normalized.weaponType === WeaponType.SniperRifle
    ) {
      interval = Math.max(1, interval - frameReduction(totalChargeSpeed(mergedConfig)));
      turnFrame = 16;
    }

    const hitDelay = rocketLauncherHitDelay(normalized, position, teamSide);
    const charge =
      (normalized.baseChargeRate || 1) *
      (normalized.chargeMultiplier || 1) *
      quantumMultiplier(mergedConfig);
    const events = [];
    let frame = 0;

    if (
      normalized.weaponType === WeaponType.RocketLauncher ||
      normalized.weaponType === WeaponType.SniperRifle
    ) {
      frame = interval;
      if (frame + hitDelay <= max) {
        events.push({
          frame: frame + hitDelay,
          charge,
          sourcePosition: position,
          targetPositions: targetPositions(normalized, teamSide),
          weaponType: normalized.weaponType,
          side: teamSide,
        });
      }
      frame += turnFrame + interval;
    }

    for (; frame <= max; frame += interval + turnFrame) {
      events.push({
        frame: frame + hitDelay,
        charge,
        sourcePosition: position,
        targetPositions: targetPositions(normalized, teamSide),
        weaponType: normalized.weaponType,
        side: teamSide,
      });
    }

    return events.filter((event) => event.frame <= max);
  }

  function calculateSpecialChargeEvents(character, config, maxFrame, sourcePosition, side) {
    switch (character.id) {
      case "002":
        return scarletBlackShadowEvents(character, config, maxFrame, sourcePosition, side);
      case "003":
        return cinderellaEvents(character, config, maxFrame, sourcePosition, side);
      case "004T":
        return helmPlusEvents(character, config, maxFrame, sourcePosition, side);
      case "005":
        return redHoodEvents(character, config, maxFrame, sourcePosition, side);
      case "008":
        return summerAnisEvents(character, config, maxFrame, sourcePosition, side);
      case "010T":
        return drakePlusEvents(character, config, maxFrame, sourcePosition, side);
      case "027":
        return privatyUnkindMaidEvents(character, config, maxFrame, sourcePosition, side);
      case "032":
        return maidenIceRoseEvents(character, config, maxFrame, sourcePosition, side);
      case "041":
        return emiliaEvents(character, config, maxFrame, sourcePosition, side);
      case "051":
        return a2Events(character, config, maxFrame, sourcePosition, side);
      case "061":
        return harranEvents(character, config, maxFrame, sourcePosition, side);
      case "076":
        return snowWhiteInnocentDaysEvents(character, config, maxFrame, sourcePosition, side);
      case "152":
        return littleMermaidEvents(character, config, maxFrame, sourcePosition, side);
      case "159":
        return ravenEvents(character, config, maxFrame, sourcePosition, side);
      case "162":
        return vestiTacticalUpgradeEvents(character, config, maxFrame, sourcePosition, side);
      case "167":
        return liberalioEvents(character, config, maxFrame, sourcePosition, side);
      case "169":
        return snowWhiteHeavyArmsEvents(character, config, maxFrame, sourcePosition, side);
      case "174":
        return anisStarEvents(character, config, maxFrame, sourcePosition, side);
      case "175":
        return neonVisionEyeEvents(character, config, maxFrame, sourcePosition, side);
      default:
        return null;
    }
  }

  function helmPlusEvents(character, config, maxFrame, sourcePosition, side) {
    return calculateBaseChargeEvents(character, config, maxFrame, sourcePosition, side)
      .map((item) => ({ ...item, charge: item.charge + 14.31 }));
  }

  function cinderellaEvents(character, config, maxFrame, sourcePosition, side) {
    const base = 0.225 * quantumMultiplier(config);
    const hitDelay = rocketLauncherHitDelay(character, sourcePosition, side);
    const firstLoop = [4, 2, 2, 2, 4, 4];
    const laterLoop = [2, 2, 2, 2, 4, 4];
    const events = [];
    let shot = 1;
    let first = true;

    for (let frame = 60; frame <= maxFrame; frame += 22) {
      const index = (shot - 1) % 6;
      const multiplier = (first ? firstLoop : laterLoop)[index];
      events.push(event(
        frame + hitDelay,
        base * multiplier,
        character,
        sourcePosition,
        [{ position: Position.P1, hitCount: 2 }],
        side
      ));
      shot += 1;
      if (shot > 6 && first) {
        first = false;
        shot = 1;
      }
    }

    return events.filter((item) => item.frame <= maxFrame);
  }

  function scarletBlackShadowEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    return [
      { frame: 23, charge: 2.5 },
      { frame: 69, charge: 2.5 },
      { frame: 115, charge: 3.75 },
      { frame: 161, charge: 2.5 },
      { frame: 207, charge: 2.5 },
      { frame: 253, charge: 5 },
      { frame: 299, charge: 2.5 },
      { frame: 345, charge: 2.5 },
      { frame: 391, charge: 3.75 },
    ]
      .filter((item) => item.frame <= maxFrame)
      .map((item) => event(
        item.frame,
        item.charge * multiplier,
        character,
        sourcePosition,
        [{ position: Position.P1, hitCount: 1 }],
        side,
        WeaponType.RocketLauncher
      ));
  }

  function drakePlusEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const targets = targetPositions(character, side);
    const events = [event(0, 0.45 * 10 * multiplier, character, sourcePosition, targets, side)];
    let frame = 0;
    let count = 1;

    while (frame <= maxFrame) {
      frame += 42;
      if (frame > maxFrame) break;
      count += 1;
      events.push(event(frame, 0.45 * 10 * multiplier, character, sourcePosition, targets, side));
      if (count % 5 === 0 && frame + 12 <= maxFrame) {
        events.push(event(frame + 12, 0.45 * multiplier, character, sourcePosition, [], side));
      }
    }

    return events;
  }

  function privatyUnkindMaidEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const events = [];
    let frame = 0;
    let count = 0;

    while (frame <= maxFrame) {
      count += 1;
      const targets = targetPositions(character, side);
      let charge = 0.2 * 10 * multiplier;
      if (count % 3 === 0) {
        charge += 0.2 * 2 * multiplier;
        targets.push(...extraRocketTargets(side));
      }
      events.push(event(frame, charge, character, sourcePosition, targets, side));
      frame += 42;
    }

    return events;
  }

  function summerAnisEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const events = [];
    let frame = 0;

    while (frame <= maxFrame) {
      events.push(event(frame, 0.25 * 10 * multiplier, character, sourcePosition, targetPositions(character, side), side));
      for (let i = 1; i <= 4; i += 1) {
        frame += 42;
        if (frame <= maxFrame) {
          events.push(event(frame, 2.5 * multiplier, character, sourcePosition, targetPositions(character, side), side));
        }
      }
      if (frame <= maxFrame && frame + 12 <= maxFrame) {
        events.push(event(frame + 12, 0.25 * 2 * multiplier, character, sourcePosition, [], side));
      }
      frame += 84;
    }

    return events;
  }

  function harranEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const base = 2.9 * multiplier;
    const speed = totalChargeSpeed(config);
    const interval = Math.max(1, character.attackInterval - frameReduction(speed));
    const events = [];
    const hitCount = character.serverRegion === "china" ? 2 : 1;
    const firstMultiplier = character.serverRegion === "china" ? 2 : 1;
    const laterMultiplier = character.serverRegion === "china" ? 3 : 2;
    const target = side === Side.Attacker ? Position.P5 : Position.P1;
    let frame = interval;

    if (frame <= maxFrame) {
      events.push(event(frame, base * firstMultiplier, character, sourcePosition, [{ position: target, hitCount }], side));
    }
    for (frame += 16 + interval; frame <= maxFrame; frame += 16 + interval) {
      events.push(event(frame, base * laterMultiplier, character, sourcePosition, [{ position: target, hitCount }], side));
    }

    return events;
  }

  function snowWhiteInnocentDaysEvents(character, config, maxFrame, sourcePosition, side) {
    const events = calculateBaseChargeEvents(character, config, maxFrame, sourcePosition, side);
    const bonus = 0.05 * quantumMultiplier(config);
    return events.map((item, index) => ((index + 1) % 30 === 0
      ? { ...item, charge: item.charge + bonus }
      : item));
  }

  function a2Events(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const charge = 1.3 * 9 * multiplier;
    const targets = [
      { position: Position.P1, hitCount: 2 },
      { position: Position.P2, hitCount: 2 },
      { position: Position.P3, hitCount: 2 },
    ];
    const events = [];
    if (152 <= maxFrame) events.push(event(152, charge, character, sourcePosition, targets, side));
    if (228 <= maxFrame) events.push(event(228, charge, character, sourcePosition, targets, side));
    return events;
  }

  function maidenIceRoseEvents(character, config, maxFrame, sourcePosition, side) {
    return calculateBaseChargeEvents(character, config, maxFrame, sourcePosition, side)
      .map((item) => ({
        ...item,
        targetPositions: [
          { position: Position.P1, hitCount: 2 },
          { position: Position.P2, hitCount: 1 },
        ],
      }));
  }

  function littleMermaidEvents(character, config, maxFrame, sourcePosition, side) {
    const events = calculateBaseChargeEvents(character, config, maxFrame, sourcePosition, side);
    if (events.length === 0) return events;
    const bonus = 0.5 * quantumMultiplier(config);
    return events.map((item, index) => (index === 0 ? { ...item, charge: item.charge + bonus } : item));
  }

  function emiliaEvents(character, config, maxFrame, sourcePosition, side) {
    const interval = character.attackInterval;
    const turnFrame = 16;
    const charge = (character.baseChargeRate || 1) * (character.chargeMultiplier || 1) * quantumMultiplier(config);
    const hitDelay = rocketLauncherHitDelay(character, sourcePosition, side);
    const targets = [
      { position: Position.P1, hitCount: character.hitsPerCharacter },
      { position: Position.P2, hitCount: character.hitsPerCharacter },
      { position: Position.P3, hitCount: character.hitsPerCharacter },
    ];
    const events = [];
    const firstReduction = frameReduction(totalChargeSpeed(config));
    const laterReduction = frameReduction(totalChargeSpeed(config, [13.01]));
    let frame = interval - firstReduction;

    if (frame + hitDelay <= maxFrame) {
      events.push(event(frame + hitDelay, charge, character, sourcePosition, targets, side));
    }

    for (frame += turnFrame + interval - laterReduction; frame + hitDelay <= maxFrame; frame += turnFrame + interval - laterReduction) {
      events.push(event(frame + hitDelay, charge, character, sourcePosition, targets, side));
    }

    return events;
  }

  function redHoodEvents(character, config, maxFrame, sourcePosition, side) {
    const interval = character.attackInterval;
    const turnFrame = 16;
    const charge = (character.baseChargeRate || 1) * (character.chargeMultiplier || 1) * quantumMultiplier(config);
    const hitDelay = rocketLauncherHitDelay(character, sourcePosition, side);
    const events = [];
    const activeBuffs = [];
    const buffDuration = 180;
    const buffValue = 3.81;
    const maxBuffs = 10;
    const countActiveBuffs = (frame) => activeBuffs.filter((expires) => expires > frame).length;
    const addBuff = (frame) => {
      activeBuffs.push(frame + buffDuration);
      for (let i = activeBuffs.length - 1; i >= 0; i -= 1) {
        if (activeBuffs[i] <= frame) activeBuffs.splice(i, 1);
      }
      if (activeBuffs.length > maxBuffs) activeBuffs.splice(0, activeBuffs.length - maxBuffs);
    };
    const firstReduction = frameReduction(totalChargeSpeed(config));
    let frame = interval - firstReduction;

    if (frame + hitDelay <= maxFrame) {
      const target = side === Side.Attacker ? Position.P5 : Position.P1;
      events.push(event(frame + hitDelay, charge, character, sourcePosition, [{ position: target, hitCount: character.hitsPerCharacter }], side));
      addBuff(frame + hitDelay);
    }

    for (;;) {
      const active = countActiveBuffs(frame);
      const reduction = frameReduction(totalChargeSpeed(config, Array(active).fill(buffValue)));
      frame += turnFrame + interval - reduction;
      if (frame + hitDelay > maxFrame) break;
      const target = side === Side.Attacker ? Position.P5 : Position.P1;
      events.push(event(frame + hitDelay, charge, character, sourcePosition, [{ position: target, hitCount: character.hitsPerCharacter }], side));
      addBuff(frame + hitDelay);
    }

    return events;
  }

  function ravenEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const events = [];
    let frame = 78;
    let followUp = frame + 2 + 72;

    if (frame + 2 < maxFrame) {
      events.push(event(frame + 2, 1.4 * 5 * multiplier, character, sourcePosition, targetPositions(character, side), side));
      if (followUp < maxFrame) {
        events.push(event(followUp, 1.4 * multiplier, character, sourcePosition, [{ position: Position.P1, hitCount: 1 }], side));
      }
    }

    for (frame += 126; frame <= maxFrame; frame += 126) {
      if (frame + 2 <= maxFrame) {
        events.push(event(frame + 2, 1.4 * 5 * multiplier, character, sourcePosition, targetPositions(character, side), side));
      }
      followUp += 60;
      if (followUp <= maxFrame) {
        events.push(event(followUp, 1.4 * multiplier, character, sourcePosition, [{ position: Position.P1, hitCount: 1 }], side));
      }
    }

    return events;
  }

  function vestiTacticalUpgradeEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const charge = 0.65 * 12 * multiplier;
    const targets = [
      { position: Position.P1, hitCount: 2 },
      { position: Position.P2, hitCount: 2 },
      { position: Position.P3, hitCount: 2 },
    ];
    const baseFrame = 122;
    const step = 22;
    const reduction = frameReduction(totalChargeSpeed(config)) * 2;
    const interval = Math.max(1, baseFrame - reduction);
    const hitDelay = sourcePosition === Position.P1 || sourcePosition === Position.P2 ? 14 : 12;
    const events = [];
    let cursor = 0;

    for (;;) {
      const start = cursor + interval;
      if (start > maxFrame) break;
      for (let i = 0; i < 4; i += 1) {
        const frame = start + i * step + hitDelay;
        if (frame > maxFrame) break;
        events.push(event(frame, charge, character, sourcePosition, targets, side));
      }
      cursor = start + 3 * step;
      if (cursor > maxFrame) break;
    }

    return events;
  }

  function liberalioEvents(character, config, maxFrame, sourcePosition, side) {
    const speed = totalChargeSpeed(config);
    const reduction = liberalioFrameReduction(speed);
    const firstFrame = Math.max(1, 90 - reduction);
    const interval = Math.max(1, 90 - reduction);
    const charge = 2.8 * quantumMultiplier(config);
    const events = [];
    let turn = 0;

    for (;;) {
      const start = firstFrame + turn * interval;
      if (start > maxFrame) break;
      let offset = 0;
      for (let i = 0; i < 6; i += 1) {
        if (i === 1) offset += 12;
        else if (i > 1) offset += 6;
        const frame = start + offset;
        if (frame > maxFrame) break;
        events.push(event(frame, charge, character, sourcePosition, [{ position: Position.P5, hitCount: 1 }], side));
      }
      turn += 1;
    }

    return events;
  }

  function snowWhiteHeavyArmsEvents(character, config, maxFrame, sourcePosition, side) {
    const multiplier = quantumMultiplier(config);
    const offsets = [0, 6, 12, 20, 28, 36, 44];
    const multipliers = [2, 1, 5, 1, 1, 1, 1];
    const events = [];

    for (let turn = 0; ; turn += 1) {
      const start = 72 + turn * 88;
      if (start > maxFrame) break;
      for (let i = 0; i < offsets.length; i += 1) {
        const frame = start + offsets[i];
        if (frame > maxFrame) break;
        events.push(event(frame, 2.8 * multipliers[i] * multiplier, character, sourcePosition, [{ position: Position.P5, hitCount: 1 }], side));
      }
    }

    return events;
  }

  function anisStarEvents(character, config, maxFrame, sourcePosition, side) {
    const reduction = frameReduction(totalChargeSpeed(config));
    const interval = Math.max(1, 60 - reduction);
    const charge = (character.baseChargeRate || 1) * (character.chargeMultiplier || 1) * quantumMultiplier(config);
    const hitDelay = sourcePosition === Position.P1 || sourcePosition === Position.P2 ? 14 : 12;
    const targets = [
      { position: Position.P1, hitCount: 1 },
      { position: Position.P2, hitCount: 1 },
      { position: Position.P3, hitCount: 1 },
    ];
    const events = [];

    for (let frame = interval; frame <= maxFrame; frame += 4 + interval) {
      if (frame + hitDelay <= maxFrame) {
        events.push(event(frame + hitDelay, charge, character, sourcePosition, targets, side));
      }
    }

    return events;
  }

  function neonVisionEyeEvents(character, config, maxFrame, sourcePosition, side) {
    const reduction = frameReduction(totalChargeSpeed(config));
    const interval = Math.max(1, 60 - reduction);
    const charge = (character.baseChargeRate || 1) * (character.chargeMultiplier || 1) * quantumMultiplier(config);
    const hitDelay = sourcePosition === Position.P1 || sourcePosition === Position.P2 ? 14 : 12;
    const targets = [
      { position: Position.P1, hitCount: 1 },
      { position: Position.P2, hitCount: 1 },
    ];
    const events = [];

    for (let frame = interval; frame <= maxFrame; frame += 2 + interval) {
      if (frame + hitDelay <= maxFrame) {
        events.push(event(frame + hitDelay, charge, character, sourcePosition, targets, side));
      }
    }

    return events;
  }

  function calculateBaseChargeEvents(character, config, maxFrame, sourcePosition, side) {
    if (character.weaponType === WeaponType.MachineGun) {
      return machineGunEvents(character, config, maxFrame, sourcePosition, side);
    }

    let interval = character.attackInterval;
    let turnFrame = 0;

    if (
      character.weaponType === WeaponType.RocketLauncher ||
      character.weaponType === WeaponType.SniperRifle
    ) {
      interval = Math.max(1, interval - frameReduction(totalChargeSpeed(config)));
      turnFrame = 16;
    }

    const hitDelay = rocketLauncherHitDelay(character, sourcePosition, side);
    const charge =
      (character.baseChargeRate || 1) *
      (character.chargeMultiplier || 1) *
      quantumMultiplier(config);
    const events = [];
    let frame = 0;

    if (
      character.weaponType === WeaponType.RocketLauncher ||
      character.weaponType === WeaponType.SniperRifle
    ) {
      frame = interval;
      if (frame + hitDelay <= maxFrame) {
        events.push(event(frame + hitDelay, charge, character, sourcePosition, targetPositions(character, side), side));
      }
      frame += turnFrame + interval;
    }

    for (; frame <= maxFrame; frame += interval + turnFrame) {
      events.push(event(frame + hitDelay, charge, character, sourcePosition, targetPositions(character, side), side));
    }

    return events.filter((item) => item.frame <= maxFrame);
  }

  function cumulativeTimeline(events) {
    const byFrame = new Map();
    for (const event of events) {
      byFrame.set(event.frame, (byFrame.get(event.frame) || 0) + event.charge);
    }

    let total = 0;
    return Array.from(byFrame.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([frame, charge]) => {
        total = Number((total + charge).toFixed(3));
        return { frame, charge: Number(charge.toFixed(3)), totalCharge: total };
      });
  }

  function burstReadyFrame(events, threshold) {
    const target = threshold == null ? 100 : threshold;
    const timeline = cumulativeTimeline(events);
    const ready = timeline.find((point) => point.totalCharge >= target);
    return ready ? ready.frame : null;
  }

  function makeTeam(characters, options) {
    const opts = options || {};
    return {
      teamType: opts.teamType || "attack",
      characters: Array.from({ length: 5 }, (_, index) => characters[index] || null),
      linkStatus: opts.linkStatus || null,
      universalNikke: opts.universalNikke || {
        enabled: false,
        frame: 1,
        chargeValue: 0,
      },
    };
  }

  function configFor(configs, teamType, characterId) {
    if (!configs || !characterId) return DEFAULT_CONFIG;
    if (configs[characterId]) return configs[characterId];
    if (configs[teamType] && configs[teamType][characterId]) return configs[teamType][characterId];
    return DEFAULT_CONFIG;
  }

  function calculateBaseTeamEvents(team, configs, maxFrame) {
    const events = [];
    const side = team.teamType === "defense" ? Side.Defender : Side.Attacker;
    const max = maxFrame == null ? 597 : maxFrame;

    team.characters.forEach((character, index) => {
      if (!character) return;
      const config = configFor(configs, team.teamType, character.id);
      events.push(...calculateChargeEvents(character, config, max, index, side));
    });

    return events.sort((a, b) => a.frame - b.frame);
  }

  function calculateJackalLinkEvents(team, casterConfig, opponentEvents) {
    const events = [];
    if (!team.linkStatus || !team.linkStatus.casterId) return events;

    const linkedIds = [team.linkStatus.casterId, ...(team.linkStatus.targetIds || [])];
    const linkedPositions = [];
    team.characters.forEach((character, index) => {
      if (character && linkedIds.includes(character.id)) linkedPositions.push(index);
    });
    if (linkedPositions.length === 0) return events;

    let hitTotal = 0;
    const multiplier = quantumMultiplier(casterConfig);
    opponentEvents.slice().sort((a, b) => a.frame - b.frame).forEach((opponentEvent) => {
      let linkedHits = 0;
      opponentEvent.targetPositions.forEach((target) => {
        if (linkedPositions.includes(target.position)) linkedHits += target.hitCount;
      });
      if (linkedHits <= 0) return;

      const previous = hitTotal;
      hitTotal += linkedHits;
      const currentStacks = Math.floor(hitTotal / 10);
      const previousStacks = Math.floor(previous / 10);
      if (currentStacks > previousStacks) {
        events.push({
          frame: opponentEvent.frame,
          charge: 3.55 * multiplier * (currentStacks - previousStacks),
          sourcePosition: opponentEvent.sourcePosition,
          targetPositions: [],
          weaponType: opponentEvent.weaponType,
          side: opponentEvent.side === Side.Attacker ? Side.Defender : Side.Attacker,
        });
      }
    });

    return events.sort((a, b) => a.frame - b.frame);
  }

  function calculateScarletCounterEvents(team, opponentEvents, enabled) {
    const events = [];
    if (!enabled) return events;

    const scarletIndex = team.characters.findIndex((character) => character && character.id === "014");
    if (scarletIndex === -1) return events;

    const linkIncludesScarlet =
      team.linkStatus &&
      Array.isArray(team.linkStatus.targetIds) &&
      team.linkStatus.targetIds.includes("014");
    const linkedPositions = [];
    if (linkIncludesScarlet) {
      const linkedIds = [team.linkStatus.casterId, ...(team.linkStatus.targetIds || [])];
      team.characters.forEach((character, index) => {
        if (character && linkedIds.includes(character.id)) linkedPositions.push(index);
      });
    }
    const linkedSet = linkIncludesScarlet ? new Set(linkedPositions) : null;
    const byFrame = new Map();

    opponentEvents.slice().sort((a, b) => a.frame - b.frame).forEach((opponentEvent) => {
      if (!byFrame.has(opponentEvent.frame)) byFrame.set(opponentEvent.frame, []);
      byFrame.get(opponentEvent.frame).push(opponentEvent);
    });

    byFrame.forEach((frameEvents, frame) => {
      let hits = 0;
      frameEvents.forEach((opponentEvent) => {
        opponentEvent.targetPositions.forEach((target) => {
          const hitsScarlet = target.position === scarletIndex;
          const hitsLinked = linkedSet ? linkedSet.has(target.position) : false;
          if (hitsScarlet || hitsLinked) hits += target.hitCount;
        });
      });
      if (hits > 0) {
        events.push({
          frame,
          charge: 0.135 * hits,
          sourcePosition: scarletIndex,
          targetPositions: [],
          weaponType: WeaponType.AssaultRifle,
          side: Side.Attacker,
        });
      }
    });

    return events.sort((a, b) => a.frame - b.frame);
  }

  function calculateRedHoodPenetrationEvents(team, ownEvents, level) {
    const events = [];
    if (!level) return events;

    const redHoodIndex = team.characters.findIndex((character) => character && character.id === "005");
    if (redHoodIndex === -1) return events;

    let count = 0;
    ownEvents
      .filter((item) => item.sourcePosition === redHoodIndex)
      .sort((a, b) => a.frame - b.frame)
      .forEach((redHoodEvent) => {
        if (count >= level) return;
        events.push({
          frame: redHoodEvent.frame,
          charge: 2.8,
          sourcePosition: redHoodIndex,
          targetPositions: [],
          weaponType: redHoodEvent.weaponType,
          side: redHoodEvent.side,
        });
        count += 1;
      });

    return events;
  }

  function calculateUniversalNikkeEvents(team) {
    if (!team.universalNikke || !team.universalNikke.enabled) return [];
    return [{
      frame: team.universalNikke.frame,
      charge: team.universalNikke.chargeValue,
      sourcePosition: Position.P1,
      targetPositions: [],
      weaponType: WeaponType.AssaultRifle,
      side: team.teamType === "defense" ? Side.Defender : Side.Attacker,
    }];
  }

  function applyAnisStarTeamBonus(team, eventsBySource) {
    if (!team.characters.some((character) => character && character.id === "174")) return eventsBySource;

    const out = new Map();
    eventsBySource.forEach((events, sourcePosition) => {
      const character = team.characters[sourcePosition];
      const isMachineGun = character && normalizeCharacter(character).weaponType === WeaponType.MachineGun;
      const chargeMultiplier = character ? normalizeCharacter(character).chargeMultiplier || 1 : 1;
      out.set(sourcePosition, events.map((item) => {
        const bonus = isMachineGun
          ? 0.084 * item.targetPositions.reduce((sum, target) => sum + target.hitCount, 0)
          : 0.084 * chargeMultiplier;
        return { ...item, charge: item.charge + bonus };
      }));
    });
    return out;
  }

  function calculateTeamEvents(team, configs, maxFrame, opponentTeam, opponentConfigs) {
    const eventsBySource = new Map();
    const max = maxFrame == null ? 597 : maxFrame;
    const side = team.teamType === "defense" ? Side.Defender : Side.Attacker;

    team.characters.forEach((character, index) => {
      if (!character) return;
      const config = configFor(configs, team.teamType, character.id);
      eventsBySource.set(index, calculateChargeEvents(character, config, max, index, side));
    });

    const adjustedEventsBySource = applyAnisStarTeamBonus(team, eventsBySource);
    const baseEvents = [];
    adjustedEventsBySource.forEach((items) => baseEvents.push(...items));
    baseEvents.sort((a, b) => a.frame - b.frame);

    let opponentEvents = [];
    if (opponentTeam) {
      opponentEvents = calculateBaseTeamEvents(opponentTeam, opponentConfigs, max);
    }

    const specialEvents = [];
    if (team.linkStatus && team.linkStatus.casterId) {
      specialEvents.push(...calculateJackalLinkEvents(
        team,
        configFor(configs, team.teamType, team.linkStatus.casterId),
        opponentEvents
      ));
    }

    const scarletConfig = configFor(configs, team.teamType, "014");
    const scarletEnabled = scarletConfig.scarletCounterAttackEnabled ?? true;
    specialEvents.push(...calculateScarletCounterEvents(team, opponentEvents, scarletEnabled));

    const redHoodConfig = configFor(configs, team.teamType, "005");
    const redHoodLevel = redHoodConfig.redHoodPenetrationLevel || 0;
    specialEvents.push(...calculateRedHoodPenetrationEvents(team, baseEvents, redHoodLevel));
    specialEvents.push(...calculateUniversalNikkeEvents(team));

    return [...baseEvents, ...specialEvents].sort((a, b) => a.frame - b.frame);
  }

  function calculateBattleEvents(
    attackTeam,
    defenseTeam,
    configs,
    maxFrame
  ) {
    const attackConfigs = configs && (configs.attack || configs.attackTeam || configs);
    const defenseConfigs = configs && (configs.defense || configs.defenseTeam || configs);
    const attackEvents = calculateTeamEvents(
      attackTeam,
      attackConfigs,
      maxFrame,
      defenseTeam,
      defenseConfigs
    );
    const defenseEvents = calculateTeamEvents(
      defenseTeam,
      defenseConfigs,
      maxFrame,
      attackTeam,
      attackConfigs
    );
    return { attackEvents, defenseEvents };
  }

  function summarizeTeam(team, configs, maxFrame, threshold, opponentTeam, opponentConfigs) {
    const events = calculateTeamEvents(team, configs, maxFrame, opponentTeam, opponentConfigs);
    const timeline = cumulativeTimeline(events);
    return {
      events,
      timeline,
      burstReadyFrame: burstReadyFrame(events, threshold),
      totalCharge: timeline.length ? timeline[timeline.length - 1].totalCharge : 0,
    };
  }

  return {
    WeaponType,
    Position,
    Side,
    DEFAULT_CONFIG,
    loadCharacters,
    findCharacter,
    normalizeCharacter,
    frameReduction,
    totalChargeSpeed,
    liberalioFrameReduction,
    calculateChargeEvents,
    calculateTeamEvents,
    calculateBattleEvents,
    cumulativeTimeline,
    burstReadyFrame,
    makeTeam,
    summarizeTeam,
  };
});
