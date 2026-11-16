import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';

const LIGHT_LIMITS_BY_FIELD = { pointLights: MAX_POINT_LIGHTS, spotLights: MAX_SPOT_LIGHTS, areaLights: MAX_AREA_LIGHTS };

const ALTERNATIVES = 'light the room with an HDRI or emissive parts, or render with backend native, which takes 256 lights';

const LIGHT_LIMIT_ADVICE = {
  pointLights: `merge nearby lights into one brighter light, ${ALTERNATIVES}`,
  spotLights: `merge nearby lights into one brighter light, ${ALTERNATIVES}`,
  areaLights: `merge neighbouring panels into one wider light, ${ALTERNATIVES}`,
};

/**
 * The tail of the error for a light list that is too long: why the cap exists and what to do instead. Light linking keeps
 * one of 32 mask bits per light (1 sun, 16 point, 8 spot, 7 area), so one kind cannot grow without taking bits from another.
 */
export function lightLimitAdvice(field) {
  return `a drawn frame takes at most ${LIGHT_LIMITS_BY_FIELD[field]} of them because light linking keeps one of 32 mask bits per light (1 sun, ${MAX_POINT_LIGHTS} point, ${MAX_SPOT_LIGHTS} spot, ${MAX_AREA_LIGHTS} area), so one kind cannot grow without taking bits from the others; ${LIGHT_LIMIT_ADVICE[field]}`;
}
