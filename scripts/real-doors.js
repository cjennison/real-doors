/**
 * Real Doors — DM-authorized, skill-gated, trappable doors for Foundry VTT (dnd5e).
 *
 * A "managed" door stores its config in wall flags under `flags['real-doors'].config`.
 * When a managed door is LOCKED, a player left-clicking it does not open it directly:
 * instead a request is sent to the primary GM, who approves / denies / force-unlocks.
 * On approval the player's character auto-rolls the configured skill vs the DC; on
 * success the GM opens the door (tokens can pass), on failure a configured trap deals
 * damage. Players (or the GM) can right-click a managed door to request a re-lock.
 */

const MODULE_ID = "real-doors";
const SOCKET = `module.${MODULE_ID}`;

/** True only on the single authoritative GM (avoids double-adjudication). */
function isActiveGM() {
  return game.users?.activeGM?.id === game.user.id;
}

/** GM-config mode: when active, a GM left-click on a door opens its config dialog. */
let configMode = false;

function emit(payload) {
  game.socket.emit(SOCKET, payload);
}

function getDoorConfig(wallDoc) {
  const f = wallDoc?.getFlag?.(MODULE_ID, "config");
  if (!f) return null;
  return {
    managed: true,
    skill: f.skill ?? "",
    dc: Number(f.dc ?? 10),
    trapFormula: f.trapFormula ?? "",
    trapType: f.trapType ?? "none",
    note: f.note ?? ""
  };
}

function isManaged(wallDoc) {
  return getDoorConfig(wallDoc) != null;
}

function userCharacter(user = game.user) {
  if (user.character) return user.character;
  return game.actors.find(a => a.type === "character" && a.testUserPermission(user, "OWNER")) ?? null;
}

function getWall(sceneId, wallId) {
  const scene = game.scenes.get(sceneId);
  return scene?.walls?.get(wallId) ?? null;
}

/** Apply trap damage to an actor across dnd5e version signatures. */
async function applyTrapDamage(actor, amount, type) {
  if (!actor || !amount) return;
  try {
    return await actor.applyDamage([{ value: amount, type: type && type !== "none" ? type : "" }]);
  } catch (e) {
    try {
      return await actor.applyDamage(amount, 1);
    } catch (e2) {
      const hp = actor.system?.attributes?.hp;
      if (hp) await actor.update({ "system.attributes.hp.value": Math.max(0, (hp.value ?? 0) - amount) });
    }
  }
}

function skillLabel(key) {
  const s = CONFIG.DND5E?.skills?.[key];
  return s?.label ?? key;
}

/* -------------------------------------------- */
/*  Player-side requests                        */
/* -------------------------------------------- */

function requestOpen(wallDoc) {
  const pc = userCharacter();
  if (!pc) {
    ui.notifications.warn("You have no assigned character to attempt this door.");
    return;
  }
  emit({
    type: "open-request",
    sceneId: wallDoc.parent.id,
    wallId: wallDoc.id,
    userId: game.user.id,
    userName: game.user.name,
    actorId: pc.id,
    actorName: pc.name
  });
  ui.notifications.info("You reach for the door… waiting for the DM.");
}

function requestRelock(wallDoc) {
  emit({
    type: "relock-request",
    sceneId: wallDoc.parent.id,
    wallId: wallDoc.id,
    userId: game.user.id,
    userName: game.user.name
  });
  ui.notifications.info("You try to secure the door… waiting for the DM.");
}

/* -------------------------------------------- */
/*  GM-side adjudication                        */
/* -------------------------------------------- */

async function handleOpenRequestAsGM(data) {
  if (!isActiveGM()) return;
  const wall = getWall(data.sceneId, data.wallId);
  if (!wall) return;
  const cfg = getDoorConfig(wall.document) ?? { skill: "", dc: 10, trapFormula: "", trapType: "none", note: "" };

  const DialogV2 = foundry.applications.api.DialogV2;
  const details = [
    `<p><strong>${data.userName}</strong> (<em>${data.actorName}</em>) is trying to open a locked door.</p>`,
    cfg.skill ? `<p><strong>Check:</strong> ${skillLabel(cfg.skill)} DC ${cfg.dc}</p>` : `<p><em>No skill check configured — approving opens it directly.</em></p>`,
    cfg.trapFormula ? `<p><strong>Trap on failure:</strong> ${cfg.trapFormula} ${cfg.trapType !== "none" ? cfg.trapType : ""} damage</p>` : "",
    cfg.note ? `<p><strong>DM note:</strong> ${cfg.note}</p>` : "",
    `<hr><label class="rd-force"><input type="checkbox" name="forceUnlock"> Force unlock (skip the skill check &amp; trap)</label>`
  ].join("");

  const decision = await DialogV2.wait({
    window: { title: "Real Doors — Open Request" },
    content: `<div class="real-doors-dialog">${details}</div>`,
    buttons: [
      {
        action: "approve",
        label: "Approve",
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => ({ approved: true, force: !!button.form.elements.forceUnlock?.checked })
      },
      {
        action: "deny",
        label: "Deny",
        icon: "fa-solid fa-ban",
        callback: () => ({ approved: false, force: false })
      }
    ],
    rejectClose: false
  }).catch(() => ({ approved: false, force: false }));

  emit({
    type: "open-decision",
    sceneId: data.sceneId,
    wallId: data.wallId,
    userId: data.userId,
    actorId: data.actorId,
    approved: decision?.approved ?? false,
    force: decision?.force ?? false
  });
}

async function handleRelockRequestAsGM(data) {
  if (!isActiveGM()) return;
  const wall = getWall(data.sceneId, data.wallId);
  if (!wall) return;

  const DialogV2 = foundry.applications.api.DialogV2;
  const approved = await DialogV2.confirm({
    window: { title: "Real Doors — Re-lock Request" },
    content: `<p><strong>${data.userName}</strong> wants to re-lock this door. Allow it?</p>`,
    rejectClose: false
  }).catch(() => false);

  if (approved) {
    await wall.update({ ds: CONST.WALL_DOOR_STATES.LOCKED });
    emit({ type: "notify", userId: data.userId, level: "info", message: "The DM allowed you to re-lock the door." });
  } else {
    emit({ type: "notify", userId: data.userId, level: "warn", message: "The DM did not allow you to re-lock the door." });
  }
}

async function handleSetDoorAsGM(data) {
  if (!isActiveGM()) return;
  const wall = getWall(data.sceneId, data.wallId);
  if (!wall) return;
  await wall.update({ ds: data.ds });
}

/* -------------------------------------------- */
/*  Player-side decision handling               */
/* -------------------------------------------- */

async function handleOpenDecisionAsPlayer(data) {
  if (data.userId !== game.user.id) return;
  if (!data.approved) {
    ui.notifications.warn("The DM did not allow you to open the door.");
    return;
  }

  const wall = getWall(data.sceneId, data.wallId);
  const cfg = wall ? getDoorConfig(wall.document) : null;
  const pc = game.actors.get(data.actorId) ?? userCharacter();

  const setOpen = () => emit({
    type: "set-door",
    sceneId: data.sceneId,
    wallId: data.wallId,
    ds: CONST.WALL_DOOR_STATES.OPEN
  });

  // Force-unlock or no skill check -> open directly.
  if (data.force || !cfg || !cfg.skill) {
    setOpen();
    ui.notifications.info("The door swings open.");
    return;
  }

  // Auto-roll the configured skill for the player's character.
  const mod = pc?.system?.skills?.[cfg.skill]?.total ?? 0;
  const roll = await new Roll("1d20 + @mod", { mod }).evaluate();
  const total = roll.total;
  const success = total >= cfg.dc;

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: pc }),
    flavor: `Real Doors — ${skillLabel(cfg.skill)} check (DC ${cfg.dc}) — ${success ? "Success!" : "Failure"}`
  });

  if (success) {
    setOpen();
    ui.notifications.info("Success! The door opens.");
    return;
  }

  // Failure -> spring the trap (if any).
  ui.notifications.warn("You failed to open the door.");
  if (cfg.trapFormula) {
    const dmg = await new Roll(cfg.trapFormula).evaluate();
    await dmg.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: pc }),
      flavor: `Real Doors — Trap! ${cfg.trapType !== "none" ? cfg.trapType : ""} damage`
    });
    await applyTrapDamage(pc, dmg.total, cfg.trapType);
  }
}

function handleNotify(data) {
  if (data.userId !== game.user.id) return;
  const level = data.level === "warn" ? "warn" : "info";
  ui.notifications[level](data.message);
}

/* -------------------------------------------- */
/*  Socket router                               */
/* -------------------------------------------- */

function onSocket(data) {
  switch (data?.type) {
    case "open-request": return handleOpenRequestAsGM(data);
    case "relock-request": return handleRelockRequestAsGM(data);
    case "set-door": return handleSetDoorAsGM(data);
    case "open-decision": return handleOpenDecisionAsPlayer(data);
    case "notify": return handleNotify(data);
  }
}

/* -------------------------------------------- */
/*  GM door configuration UI                    */
/* -------------------------------------------- */

async function openDoorConfig(wallDoc) {
  if (!game.user.isGM) return;
  const DialogV2 = foundry.applications.api.DialogV2;
  const cfg = getDoorConfig(wallDoc) ?? { skill: "prc", dc: 12, trapFormula: "", trapType: "none", note: "" };
  const managed = isManaged(wallDoc);
  const locked = wallDoc.ds === CONST.WALL_DOOR_STATES.LOCKED;

  const skills = CONFIG.DND5E?.skills ?? {};
  const skillOptions = ['<option value="">— none —</option>']
    .concat(Object.entries(skills).map(([k, v]) =>
      `<option value="${k}" ${k === cfg.skill ? "selected" : ""}>${v.label}</option>`))
    .join("");

  const dmgTypes = CONFIG.DND5E?.damageTypes ?? {};
  const typeOptions = ['<option value="none">— none —</option>']
    .concat(Object.entries(dmgTypes).map(([k, v]) => {
      const label = typeof v === "string" ? v : (v.label ?? k);
      return `<option value="${k}" ${k === cfg.trapType ? "selected" : ""}>${label}</option>`;
    }))
    .join("");

  const content = `
    <div class="real-doors-dialog">
      <div class="form-group">
        <label><input type="checkbox" name="managed" ${managed ? "checked" : ""}> Managed by Real Doors</label>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="locked" ${locked ? "checked" : ""}> Start locked</label>
      </div>
      <div class="form-group">
        <label>Skill check</label>
        <select name="skill">${skillOptions}</select>
      </div>
      <div class="form-group">
        <label>DC</label>
        <input type="number" name="dc" value="${cfg.dc}">
      </div>
      <div class="form-group">
        <label>Trap damage formula (blank = none)</label>
        <input type="text" name="trapFormula" value="${cfg.trapFormula}" placeholder="e.g. 1d6">
      </div>
      <div class="form-group">
        <label>Trap damage type</label>
        <select name="trapType">${typeOptions}</select>
      </div>
      <div class="form-group">
        <label>DM note (shown on approval)</label>
        <input type="text" name="note" value="${cfg.note}" placeholder="e.g. Rusty iron lock, poison needle">
      </div>
    </div>`;

  const result = await DialogV2.wait({
    window: { title: "Real Doors — Configure Door" },
    content,
    buttons: [
      {
        action: "save",
        label: "Save",
        icon: "fa-solid fa-floppy-disk",
        default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          return {
            managed: !!f.managed.checked,
            locked: !!f.locked.checked,
            skill: f.skill.value,
            dc: Number(f.dc.value || 10),
            trapFormula: f.trapFormula.value.trim(),
            trapType: f.trapType.value,
            note: f.note.value.trim()
          };
        }
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => null }
    ],
    rejectClose: false
  }).catch(() => null);

  if (!result) return;

  if (!result.managed) {
    await wallDoc.unsetFlag(MODULE_ID, "config");
    ui.notifications.info("Door is no longer managed by Real Doors.");
    return;
  }

  await wallDoc.setFlag(MODULE_ID, "config", {
    skill: result.skill,
    dc: result.dc,
    trapFormula: result.trapFormula,
    trapType: result.trapType,
    note: result.note
  });
  await wallDoc.update({
    ds: result.locked ? CONST.WALL_DOOR_STATES.LOCKED : CONST.WALL_DOOR_STATES.CLOSED
  });
  ui.notifications.info(`Real Door configured${result.locked ? " (locked)" : ""}.`);
}

/* -------------------------------------------- */
/*  DoorControl interception                    */
/* -------------------------------------------- */

function installDoorControl() {
  const Base = CONFIG.Canvas.doorControlClass
    ?? foundry.canvas?.containers?.DoorControl
    ?? globalThis.DoorControl;
  if (!Base) return;

  class RealDoorControl extends Base {
    _onMouseDown(event) {
      const wallDoc = this.wall?.document;
      const S = CONST.WALL_DOOR_STATES;

      // GM in config mode: clicking a door opens its config dialog.
      if (game.user.isGM && configMode && wallDoc) {
        event?.stopPropagation?.();
        openDoorConfig(wallDoc);
        return false;
      }

      // Player clicking a managed, locked door: request DM approval.
      if (!game.user.isGM && wallDoc && isManaged(wallDoc) && wallDoc.ds === S.LOCKED) {
        event?.stopPropagation?.();
        requestOpen(wallDoc);
        return false;
      }

      return super._onMouseDown(event);
    }

    _onRightDown(event) {
      const wallDoc = this.wall?.document;
      const S = CONST.WALL_DOOR_STATES;

      // Player right-clicking a managed, currently-unlocked door: request re-lock.
      if (!game.user.isGM && wallDoc && isManaged(wallDoc) && wallDoc.ds !== S.LOCKED) {
        event?.stopPropagation?.();
        requestRelock(wallDoc);
        return false;
      }

      return super._onRightDown(event);
    }
  }

  CONFIG.Canvas.doorControlClass = RealDoorControl;
}

/* -------------------------------------------- */
/*  Scene control toggle (GM config mode)       */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tool = {
    name: "real-doors-config",
    title: "Configure Real Door (click a door)",
    icon: "fa-solid fa-door-closed",
    toggle: true,
    active: configMode,
    order: 99,
    onChange: (event, active) => { configMode = active ?? !configMode; },
    onClick: (active) => { configMode = active ?? !configMode; }
  };

  if (Array.isArray(controls)) {
    const walls = controls.find(c => c.name === "walls" || c.name === "wall");
    walls?.tools?.push(tool);
  } else {
    const walls = controls.walls ?? controls.wall;
    if (walls?.tools) walls.tools["real-doors-config"] = tool;
  }
});

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

Hooks.once("setup", () => {
  installDoorControl();
});

Hooks.once("ready", () => {
  // Re-assert in case another module replaced the class after setup.
  installDoorControl();
  game.socket.on(SOCKET, onSocket);

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      configureDoor: (wallDoc) => openDoorConfig(wallDoc),
      getDoorConfig,
      setConfigMode: (v) => { configMode = !!v; }
    };
  }
  console.log(`${MODULE_ID} | ready`);
});
