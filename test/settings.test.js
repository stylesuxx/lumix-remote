import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySetting, readSettings, UnknownSettingError } from '../src/server/settings.js';
import { OK, scriptedCamera, settingValue } from './support/fake-camera.js';

const MENU =
  '<camrply><result>ok</result><menuinfo>' +
  '<item id="menu_item_id_afmode" enable="yes" value="1area" />' +
  '<item id="menu_item_id_afmode_49area" enable="yes" />' +
  '<item id="menu_item_id_afmode_1area" enable="yes" />' +
  '<item id="menu_item_id_afmode_pinpoint" enable="no" />' +
  '<item id="menu_item_id_afmode_custom_multi" enable="yes" value="horizontal" />' +
  '<item id="menu_item_id_afmode_custom_multi_horizontal" enable="yes" />' +
  '<item id="menu_item_id_whitebalance" enable="yes" value="auto" />' +
  '<item id="menu_item_id_whitebalance_auto" enable="yes" />' +
  '<item id="menu_item_id_whitebalance_halogen" enable="yes" />' +
  '<item id="menu_item_id_pctsiz" enable="yes" value="12m" />' +
  '</menuinfo></camrply>';

const SETTING_ANSWERS = {
  shtrspeed: '1963/256',
  focal: '1056/256',
  exposure: '-1/3',
  whitebalance: 'auto',
  focusmode: 'afc',
};

function cameraWith(answers) {
  return scriptedCamera((query) => {
    if (query === 'mode=getinfo&type=curmenu') {
      return MENU;
    }
    if (query === 'mode=getinfo&type=lens') {
      return 'ok,2304/256,768/256,3072/256,-1536/256,0,off';
    }
    const type = query.match(/^mode=getsetting&type=(\w+)$/)?.[1];
    if (type && type in answers) {
      return settingValue(type, answers[type]);
    }
    return type ? '<camrply><result>err_param</result></camrply>' : OK;
  });
}

function setting(result, key) {
  return result.settings.find((entry) => entry.key === key);
}

test('reads settings with labelled choices from the menu, lens and fixed lists', async () => {
  const { camera } = cameraWith(SETTING_ANSWERS);
  const result = await readSettings(camera);

  assert.equal(setting(result, 'shutter').options.find((option) => option.value === '1963/256').label, '1/200');
  assert.equal(setting(result, 'aperture').value, '1024/256');
  assert.equal(setting(result, 'exposure').value, '-1/3');
  assert.equal(setting(result, 'exposure').options.find((option) => option.value === '5/3').label, '+1 2/3 EV');
  assert.deepEqual(
    setting(result, 'afmode').options.map((option) => [option.value, option.label]),
    [['49area', '49-area'], ['1area', '1-area'], ['custom_multi', 'Custom multi']],
  );
  assert.equal(setting(result, 'whitebalance').options.find((option) => option.value === 'halogen').label, 'Incandescent');
  assert.deepEqual(
    result.readOnly.find((entry) => entry.key === 'focusmode'),
    { key: 'focusmode', label: 'Focus mode (lever)', value: 'afc', valueLabel: 'AF-C' },
  );
});

test('an unexpected value fails only its own setting', async () => {
  const { camera } = cameraWith({ ...SETTING_ANSWERS, shtrspeed: 'garbage' });
  const result = await readSettings(camera);

  assert.equal(setting(result, 'shutter').value, null);
  assert.equal(setting(result, 'shutter').isEditable, false);
  assert.equal(setting(result, 'aperture').value, '1024/256');
  assert.equal(setting(result, 'whitebalance').value, 'auto');
});

test('applying a setting writes its camera type and reports live view restarts', async () => {
  const { camera, queries } = cameraWith(SETTING_ANSWERS);

  assert.deepEqual(await applySetting(camera, 'photostyle', 'vivid'), { isLiveViewRestartNeeded: false });
  assert.deepEqual(await applySetting(camera, 'liveviewsize', 'qvga'), { isLiveViewRestartNeeded: true });
  await assert.rejects(applySetting(camera, 'brightness', '3'), UnknownSettingError);
  assert.deepEqual(queries, [
    'mode=setsetting&type=colormode&value=vivid',
    'mode=setsetting&type=liveviewsize&value=qvga',
  ]);
});
