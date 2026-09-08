export function emptySpeakerAwardConfig() {
  return { enabled: false, default: { voucher_value: "", voucher_expiry: "", badge_id: null }, overrides: {} };
}

export function configToFormState(raw) {
  if (!raw || typeof raw !== "object") return emptySpeakerAwardConfig();
  const def = raw.default || {};
  const overrides = {};
  Object.entries(raw.overrides || {}).forEach(([id, o]) => {
    if (!o || typeof o !== "object") return;
    overrides[id] = o.excluded === true
      ? { excluded: true }
      : {
          voucher_value: o.voucher_value != null ? String(o.voucher_value) : "",
          voucher_expiry: o.voucher_expiry ? String(o.voucher_expiry).slice(0, 10) : "",
          badge_id: o.badge_id || null,
        };
  });
  return {
    enabled: raw.enabled === true,
    default: {
      voucher_value: def.voucher_value != null ? String(def.voucher_value) : "",
      voucher_expiry: def.voucher_expiry ? String(def.voucher_expiry).slice(0, 10) : "",
      badge_id: def.badge_id || null,
    },
    overrides,
  };
}

export function formStateToConfig(state) {
  if (!state || state.enabled !== true) return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const overrides = {};
  Object.entries(state.overrides || {}).forEach(([id, o]) => {
    if (!o) return;
    if (o.excluded === true) {
      overrides[id] = { excluded: true };
      return;
    }
    const entry = {
      voucher_value: num(o.voucher_value),
      voucher_expiry: o.voucher_expiry || null,
      badge_id: o.badge_id || null,
    };
    if (entry.voucher_value || entry.voucher_expiry || entry.badge_id) overrides[id] = entry;
  });
  return {
    enabled: true,
    default: {
      voucher_value: num(state.default?.voucher_value),
      voucher_expiry: state.default?.voucher_expiry || null,
      badge_id: state.default?.badge_id || null,
    },
    overrides,
  };
}

export function resolveSpeakerAwardFormValue(state, speakerId) {
  const override = state.overrides?.[speakerId];
  if (override?.excluded) return { excluded: true };
  return {
    voucher_value: (override && override.voucher_value !== "" && override.voucher_value != null)
      ? override.voucher_value : state.default?.voucher_value,
    voucher_expiry: (override && override.voucher_expiry)
      ? override.voucher_expiry : state.default?.voucher_expiry,
    badge_id: (override && override.badge_id) ? override.badge_id : state.default?.badge_id,
  };
}