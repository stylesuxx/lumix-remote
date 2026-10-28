// The catalogue of still-photo settings on a Lumix G7: how each is read,
// which choices it offers, how they are labelled and what changing it needs.
// Focus mode and drive mode are set by a lever and a dial on the body, and
// picture size is read-only over WiFi.
import { apertureLabel, parseApex, shutterLabel, thirdStopOptions } from './apex.js';

export class UnknownSettingError extends Error {}

const EXPOSURE_THIRDS = Array.from({ length: 31 }, (_, index) => index - 15);
const DEFAULT_LENS_RANGE = { minimumAperture: 2, maximumAperture: 9, minimumTime: -6, maximumTime: 12 };

// The camera writes exposure compensation as a fraction: "0", "-1/3", "5/3", "1".
function exposureValue(thirds) {
  return thirds % 3 === 0 ? String(thirds / 3) : `${thirds}/3`;
}

function exposureLabel(thirds) {
  if (thirds === 0) {
    return '0 EV';
  }

  const sign = thirds > 0 ? '+' : '-';
  const whole = Math.floor(Math.abs(thirds) / 3);
  const fraction = ['', '1/3', '2/3'][Math.abs(thirds) % 3];
  return `${sign}${[whole || '', fraction].filter(Boolean).join(' ')} EV`;
}

function humanize(value) {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Enabled choices of a menu setting, in menu order. Children whose remaining
// id starts with one of excludedPrefixes belong to a nested submenu.
export function menuOptions(menu, menuId, excludedPrefixes = []) {
  const options = [];
  for (const [itemId, item] of menu) {
    if (!itemId.startsWith(`${menuId}_`) || !item.isEnabled) {
      continue;
    }

    const option = itemId.slice(menuId.length + 1);
    if (excludedPrefixes.some((prefix) => option.startsWith(prefix))) {
      continue;
    }

    options.push(option);
  }

  return options;
}

// Each entry: key (the app's name), label, type (the camera's setsetting and
// getsetting name), and how its choices are found:
//   source 'apex-shutter' / 'apex-aperture': third stops within the lens range
//   menu: the curmenu item listing the enabled choices
//   options: a fixed list
// Optional: labels for camera values, excludedOptions (submenu prefixes),
// isReadFromMenu (no getsetting support), isLiveViewRestartNeeded.
const SETTINGS = [
  { key: 'shutter', label: 'Shutter', type: 'shtrspeed', source: 'apex-shutter' },
  { key: 'aperture', label: 'Aperture', type: 'focal', source: 'apex-aperture' },
  {
    key: 'iso',
    label: 'ISO',
    type: 'iso',
    menu: 'sensitivity',
    excludedOptions: ['i_iso', 'db'],
    labels: { auto: 'Auto' },
  },
  {
    key: 'exposure',
    label: 'Exposure comp.',
    type: 'exposure',
    options: EXPOSURE_THIRDS.map((thirds) => ({ value: exposureValue(thirds), label: exposureLabel(thirds) })),
  },
  {
    key: 'whitebalance',
    label: 'White balance',
    type: 'whitebalance',
    menu: 'whitebalance',
    labels: {
      auto: 'Auto', daylight: 'Daylight', cloudy: 'Cloudy', shade: 'Shade', halogen: 'Incandescent',
      flash: 'Flash', white_set1: 'White set 1', white_set2: 'White set 2', white_set3: 'White set 3',
      white_set4: 'White set 4', color_temp: 'Color temperature',
    },
  },
  {
    key: 'lightmetering',
    label: 'Metering',
    type: 'lightmetering',
    menu: 'lightmet',
    labels: { multi: 'Multiple', center: 'Center weighted', spot: 'Spot' },
  },
  {
    key: 'afmode',
    label: 'AF mode',
    type: 'afmode',
    menu: 'afmode',
    excludedOptions: ['custom_multi_'],
    isReadFromMenu: true,
    labels: {
      facedetection: 'Face/eye detection', aftracking: 'Tracking', '49area': '49-area', '23area': '23-area',
      '1area': '1-area', pinpoint: 'Pinpoint', touch_af: 'Touch AF', touch_shut: 'Touch shutter',
      custom_multi: 'Custom multi',
    },
  },
  {
    key: 'photostyle',
    label: 'Photo style',
    type: 'colormode',
    menu: 'ph_sty',
    labels: {
      standard: 'Standard', vivid: 'Vivid', natural: 'Natural', bw: 'Monochrome',
      scenery: 'Scenery', portrait: 'Portrait', custom: 'Custom',
    },
  },
  {
    key: 'quality',
    label: 'Quality',
    type: 'quality',
    menu: 'quality',
    labels: {
      fine: 'JPEG fine', standard: 'JPEG standard', raw_fine: 'RAW + JPEG fine',
      raw_standard: 'RAW + JPEG standard', raw: 'RAW only',
    },
  },
  { key: 'aspectratio', label: 'Aspect ratio', type: 'aspectratio', menu: 'asprat' },
  {
    key: 'peaking',
    label: 'Focus peaking',
    type: 'peaking',
    menu: 'peaking',
    labels: { off: 'Off', low: 'Low', high: 'High' },
  },
  // The mode the built-in flash uses once it is popped up; a closed flash never fires.
  {
    key: 'flash',
    label: 'Flash (when up)',
    type: 'flash',
    menu: 'flash',
    labels: { forcedflashon: 'Forced on', forced_on_redeye: 'Forced on, red-eye' },
  },
  {
    key: 'liveviewsize',
    label: 'Live view size',
    type: 'liveviewsize',
    options: [
      { value: 'vga', label: '640x360' },
      { value: 'qvga', label: '320x180 (weak WiFi)' },
    ],
    isLiveViewRestartNeeded: true,
  },
];

const READ_ONLY_SETTINGS = [
  { key: 'focusmode', label: 'Focus mode (lever)', type: 'focusmode', labels: { afs: 'AF-S', aff: 'AF-F', afc: 'AF-C', mf: 'MF' } },
  { key: 'drivemode', label: 'Drive mode (dial)', type: 'drivemode' },
  { key: 'picturesize', label: 'Picture size', menu: 'pctsiz' },
];

function labelFor(setting, value) {
  return setting.labels?.[value] ?? humanize(value);
}

async function readOrNull(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

function apexChoices(setting, rawValue, lensRange) {
  const currentApex = rawValue === null ? null : parseApex(rawValue);
  return setting.source === 'apex-shutter'
    ? thirdStopOptions(lensRange.minimumTime, lensRange.maximumTime, shutterLabel, currentApex)
    : thirdStopOptions(lensRange.minimumAperture, lensRange.maximumAperture, apertureLabel, currentApex);
}

async function readSetting(camera, setting, menu, lensRange) {
  const menuItem = setting.menu ? menu.get(setting.menu) : null;
  const rawValue = setting.isReadFromMenu
    ? (menuItem?.value ?? null)
    : await readOrNull(() => camera.getSetting(setting.type));

  let value = rawValue;
  let options;
  if (setting.source) {
    ({ options, selected: value } = apexChoices(setting, rawValue, lensRange));
  } else if (setting.menu) {
    options = menuOptions(menu, setting.menu, setting.excludedOptions).map((option) => ({
      value: option,
      label: labelFor(setting, option),
    }));
  } else {
    options = setting.options;
  }

  if (value !== null && !options.some((option) => option.value === value)) {
    options = [{ value, label: labelFor(setting, value) }, ...options];
  }

  return {
    key: setting.key,
    label: setting.label,
    value,
    options,
    isEditable: value !== null && options.length > 1 && (menuItem?.isEnabled ?? true),
  };
}

// Reads every setting. A setting the camera does not answer, or answers with
// an unexpected value, comes back with value null and the others still read.
export async function readSettings(camera) {
  const menu = (await readOrNull(() => camera.getMenu())) ?? new Map();
  const lensRange = (await readOrNull(() => camera.getLensRange())) ?? DEFAULT_LENS_RANGE;

  const settings = [];
  for (const setting of SETTINGS) {
    const fallback = { key: setting.key, label: setting.label, value: null, options: [], isEditable: false };
    settings.push((await readOrNull(() => readSetting(camera, setting, menu, lensRange))) ?? fallback);
  }

  const readOnly = [];
  for (const setting of READ_ONLY_SETTINGS) {
    const value = setting.type
      ? await readOrNull(() => camera.getSetting(setting.type))
      : (menu.get(setting.menu)?.value ?? null);
    readOnly.push({ key: setting.key, label: setting.label, value, valueLabel: value === null ? null : labelFor(setting, value) });
  }

  return { settings, readOnly };
}

// Writes one setting. Resolves to what the change requires of the caller.
export async function applySetting(camera, key, value) {
  const setting = SETTINGS.find((candidate) => candidate.key === key);
  if (!setting) {
    throw new UnknownSettingError(`unknown setting ${key}`);
  }

  await camera.setSetting(setting.type, String(value));
  return { isLiveViewRestartNeeded: setting.isLiveViewRestartNeeded === true };
}
