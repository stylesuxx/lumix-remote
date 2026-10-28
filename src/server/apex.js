// The camera reports shutter speed and aperture as APEX values in 1/256 units:
// shutter Tv = log2(1 / seconds), aperture Av = 2 * log2(f-number).

const STANDARD_SHUTTER_SECONDS = [
  60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 0.8, 0.6, 0.5, 0.4, 0.3,
  1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 13, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50,
  1 / 60, 1 / 80, 1 / 100, 1 / 125, 1 / 160, 1 / 200, 1 / 250, 1 / 320, 1 / 400, 1 / 500,
  1 / 640, 1 / 800, 1 / 1000, 1 / 1250, 1 / 1600, 1 / 2000, 1 / 2500, 1 / 3200, 1 / 4000,
  1 / 5000, 1 / 6400, 1 / 8000, 1 / 10000, 1 / 13000, 1 / 16000,
];

const STANDARD_F_NUMBERS = [
  1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11,
  13, 14, 16, 18, 20, 22, 25, 29, 32,
];

export function parseApex(text) {
  const [numerator, denominator] = String(text).split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error(`not an APEX value: ${text}`);
  }

  return numerator / denominator;
}

export function formatApex(apex) {
  return `${Math.round(apex * 256)}/256`;
}

function nearestInLogSpace(value, candidates) {
  let nearest = candidates[0];
  for (const candidate of candidates) {
    if (Math.abs(Math.log(candidate / value)) < Math.abs(Math.log(nearest / value))) {
      nearest = candidate;
    }
  }

  return nearest;
}

export function shutterLabel(timeValue) {
  const seconds = nearestInLogSpace(2 ** -timeValue, STANDARD_SHUTTER_SECONDS);
  return seconds >= 0.3 ? `${seconds}s` : `1/${Math.round(1 / seconds)}`;
}

export function apertureLabel(apertureValue) {
  return `f/${nearestInLogSpace(2 ** (apertureValue / 2), STANDARD_F_NUMBERS)}`;
}

// Third-stop options between two APEX limits, plus the option nearest the current value.
export function thirdStopOptions(minimumApex, maximumApex, labelFunction, currentApex) {
  const options = [];
  const firstThird = Math.ceil(minimumApex * 3 - 0.01);
  const lastThird = Math.floor(maximumApex * 3 + 0.01);
  for (let third = firstThird; third <= lastThird; third++) {
    options.push({ value: formatApex(third / 3), label: labelFunction(third / 3) });
  }

  let selected = null;
  if (currentApex !== null && options.length > 0) {
    selected = options.reduce((best, option) =>
      Math.abs(parseApex(option.value) - currentApex) < Math.abs(parseApex(best.value) - currentApex)
        ? option
        : best,
    ).value;
  }

  return { options, selected };
}
