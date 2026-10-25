/**
 * The form for a spell the bundled SRD doesn't have.
 *
 * Paste the spell's text at the top and the fields fill in (lib/spellparse.js);
 * check them, fix anything, save. The record it makes uses the bundled spells'
 * field names, so once saved the spell casts through the same code as any SRD
 * spell: slots, concentration, typed damage, saves, upcasting, zones.
 *
 * SpellForm.build({ name, existing, onSave(rec), onCancel(), onDelete() })
 * returns the form element. The caller decides where it goes and where the
 * record is kept.
 */

const SpellForm = (() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  let seq = 0;

  function build({ name, existing = null, onSave, onCancel, onDelete }) {
    const id = `sf${++seq}`;
    const form = el("form", "spell-fill");
    form.setAttribute("aria-label", `Fill in ${name}`);

    const head = el("div", "spell-fill-head");
    head.appendChild(el("strong", null, existing ? `Edit ${name}` : `Fill in ${name}`));
    head.appendChild(el("span", "hint", "Saved on this computer for every character and monster that has it."));
    form.appendChild(head);

    // Paste box: fills the fields below
    const paste = document.createElement("textarea");
    paste.id = `${id}-paste`;
    paste.className = "spell-fill-paste";
    paste.placeholder = "Paste the spell's text from D&D Beyond or the book, and the fields below fill in";
    paste.rows = 3;
    const pasteNote = el("p", "hint spell-fill-note");
    form.append(paste, pasteNote);

    const grid = el("div", "spell-fill-grid");
    form.appendChild(grid);
    const inputs = {};
    const add = (key, label, control, wide = false) => {
      const wrap = el("label", `spell-edit-field${wide ? " is-wide" : ""}`);
      wrap.appendChild(el("span", "spell-edit-label", label));
      control.id = `${id}-${key}`;
      control.name = key;
      control.classList.add("spell-edit-input");
      wrap.appendChild(control);
      grid.appendChild(wrap);
      inputs[key] = control;
      return control;
    };
    const text = (placeholder = "") => {
      const i = document.createElement("input");
      i.type = "text";
      i.placeholder = placeholder;
      return i;
    };
    const select = (options) => {
      const s = document.createElement("select");
      for (const [v, t] of options) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        s.appendChild(o);
      }
      return s;
    };
    const check = (key, label) => {
      const wrap = el("label", "inline-check spell-fill-check");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.id = `${id}-${key}`;
      c.name = key;
      wrap.append(c, document.createTextNode(` ${label}`));
      grid.appendChild(wrap);
      inputs[key] = c;
      return c;
    };

    add("level", "Level", select([["0", "Cantrip"], ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), String(n)])]));
    add("school", "School", select([["", "—"], ...SpellParse.SCHOOLS.map((s) => [cap(s), cap(s)])]));
    add("casting_time", "Casting time", text("1 action"));
    add("range_text", "Range", text("60 feet, Self, Touch"));
    add("duration", "Duration", text("1 minute, Instantaneous"));
    add("components_text", "Components", text("V, S, M"));
    check("concentration", "Concentration");
    check("ritual", "Ritual");
    const lands = add("lands", "How it lands", select([["none", "No roll"], ["attack", "Spell attack"], ["save", "Saving throw"]]));
    const saveAb = add("save", "Save", select(SpellParse.ABILITIES.map((a) => [a, cap(a)])));
    const effect = add("effect", "Effect", select([["none", "No dice"], ["damage", "Damage"], ["healing", "Healing"]]));
    add("damage_roll", "Dice", text("2d6"));
    const type = add("type", "Damage type", select([["", "—"], ...SpellParse.TYPES.map((t) => [t, cap(t)])]));
    const addsMod = check("adds_mod", "Adds your spellcasting modifier");
    add("upcast_step", "Per slot level above", text("1d6"));
    add("shape_type", "Area", select([["", "None"], ["sphere", "Sphere / radius"], ["cube", "Cube"], ["cone", "Cone"], ["line", "Line"], ["cylinder", "Cylinder"]]));
    add("shape_size", "Area size (ft)", Object.assign(document.createElement("input"), { type: "number", min: "0", placeholder: "20" }));
    const desc = document.createElement("textarea");
    desc.rows = 4;
    add("desc", "Description", desc, true);

    // Fields that only matter for some choices
    const sync = () => {
      saveAb.closest("label").classList.toggle("hidden", lands.value !== "save");
      const dice = effect.value !== "none";
      for (const k of ["damage_roll", "upcast_step"]) inputs[k].closest("label").classList.toggle("hidden", !dice);
      type.closest("label").classList.toggle("hidden", effect.value !== "damage");
      addsMod.closest("label").classList.toggle("hidden", effect.value !== "healing");
      inputs.shape_size.closest("label").classList.toggle("hidden", !inputs.shape_type.value);
    };
    for (const c of [lands, effect, inputs.shape_type]) c.addEventListener("change", sync);

    /** Put a record (pasted or saved) into the fields. */
    function fill(rec) {
      const set = (k, v) => {
        if (v == null || !inputs[k]) return;
        if (inputs[k].type === "checkbox") inputs[k].checked = Boolean(v);
        else inputs[k].value = String(v);
      };
      set("level", rec.level);
      set("school", rec.school);
      set("casting_time", rec.casting_time);
      set("range_text", rec.range_text);
      set("duration", rec.duration);
      set("components_text", rec.components_text);
      set("concentration", rec.concentration);
      set("ritual", rec.ritual);
      if (rec.saving_throw_ability) {
        lands.value = "save";
        saveAb.value = rec.saving_throw_ability;
      } else if (rec.attack_roll) lands.value = "attack";
      else if ("level" in rec) lands.value = "none";
      if (rec.damage_roll) {
        effect.value = (rec.damage_types || []).length === 0 && Array.isArray(rec.damage_types) ? "healing" : "damage";
        set("damage_roll", rec.damage_roll);
        set("type", (rec.damage_types || [])[0] || "");
        set("adds_mod", rec.adds_mod);
      } else if ("level" in rec) effect.value = "none";
      set("upcast_step", rec.upcast_step);
      set("shape_type", rec.shape_type || "");
      set("shape_size", rec.shape_size);
      set("desc", rec.desc);
      sync();
    }

    paste.addEventListener("input", () => {
      const t = paste.value.trim();
      if (t.length < 20) return;
      const rec = SpellParse.parse(t, { name });
      fill({ ...rec, higher_level: rec.higher_level });
      if (rec.higher_level) form.dataset.higher = rec.higher_level;
      const found = [
        rec.level != null ? (rec.level === 0 ? "cantrip" : `level ${rec.level}`) : null,
        rec.saving_throw_ability ? `${cap(rec.saving_throw_ability)} save` : rec.attack_roll ? "spell attack" : null,
        rec.damage_roll ? `${rec.damage_roll}${rec.damage_types?.[0] ? ` ${rec.damage_types[0]}` : rec.damage_types ? " healing" : ""}` : null,
        rec.shape_size ? `${rec.shape_size} ft ${rec.shape_type}` : null,
        rec.upcast_step ? `+${rec.upcast_step} per level` : null,
      ].filter(Boolean);
      pasteNote.textContent = found.length ? `Found: ${found.join(" · ")}. Check the fields, then save.` : "Couldn't pick much out; fill the fields in by hand.";
    });

    // Defaults, then whatever was saved before
    effect.value = "none";
    lands.value = "none";
    if (existing) fill(existing);
    else sync();

    const err = el("p", "status error");
    form.appendChild(err);
    const buttons = el("div", "spell-edit-buttons");
    const save = el("button", "btn btn-small btn-primary", "Save spell");
    save.type = "submit";
    const cancel = el("button", "btn btn-small btn-ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => onCancel?.();
    buttons.append(save, cancel);
    if (existing && onDelete) {
      const del = el("button", "btn btn-small btn-ghost", "Forget it");
      del.type = "button";
      del.title = "Remove this filled-in spell from every character and monster on this computer";
      del.onclick = () => onDelete();
      buttons.appendChild(del);
    }
    form.appendChild(buttons);

    form.onsubmit = (ev) => {
      ev.preventDefault();
      const v = (k) => String(inputs[k].value || "").trim();
      const level = Number(v("level"));
      const dice = v("damage_roll").toLowerCase().replace(/\s+/g, "");
      if (effect.value !== "none" && !/^\d*d\d+(\+\d+)?$/.test(dice)) {
        err.textContent = "Dice should look like 2d6 or 1d8+2.";
        return;
      }
      const step = v("upcast_step").toLowerCase().replace(/\s+/g, "");
      if (step && !/^\d*d\d+$/.test(step)) {
        err.textContent = "Per slot level should look like 1d6.";
        return;
      }
      const rec = {
        name,
        custom: true,
        level,
        school: v("school") || null,
        casting_time: v("casting_time").toLowerCase() || "1 action",
        range_text: v("range_text") || null,
        duration: v("duration").replace(/^concentration,?\s*(up to\s*)?/i, "") || null,
        components_text: v("components_text") || null,
        concentration: inputs.concentration.checked,
        ritual: inputs.ritual.checked,
        desc: v("desc"),
        higher_level: form.dataset.higher || existing?.higher_level || null,
      };
      if (lands.value === "attack") rec.attack_roll = true;
      if (lands.value === "save") rec.saving_throw_ability = saveAb.value;
      if (effect.value !== "none") {
        rec.damage_roll = dice;
        // An empty type list is how the bundled spells say "this heals"
        rec.damage_types = effect.value === "healing" ? [] : [v("type") || ""];
        if (effect.value === "healing" && inputs.adds_mod.checked) rec.adds_mod = true;
        if (step) {
          rec.upcast_step = step;
          const base = /^(\d*d\d+)/.exec(dice)?.[1];
          rec.upcast = SpellParse.upcastTable(level, base?.startsWith("d") ? `1${base}` : base, step.startsWith("d") ? `1${step}` : step);
        }
      }
      if (inputs.shape_type.value && Number(v("shape_size")) > 0) {
        rec.shape_type = inputs.shape_type.value;
        rec.shape_size = Number(v("shape_size"));
        rec.shape_size_unit = "feet";
      }
      for (const k of Object.keys(rec)) if (rec[k] == null || rec[k] === "") delete rec[k];
      err.textContent = "";
      onSave?.(rec);
    };

    return form;
  }

  return { build };
})();

if (typeof window !== "undefined") window.SpellForm = SpellForm;
