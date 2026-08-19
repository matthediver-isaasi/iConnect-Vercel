export const BAR_CHART_MARGIN = Object.freeze({
  top: 18,
  right: 10,
  left: 0,
  bottom: 8,
});

export const BAR_HEIGHT_PROPS = Object.freeze({
  short:  Object.freeze({ className: "h-32 w-full", chartHeight: 128, xAxisHeight: 60, angle: -20 }),
  medium: Object.freeze({ className: "h-44 w-full", chartHeight: 176, xAxisHeight: 80, angle: -25 }),
  tall:   Object.freeze({ className: "h-72 w-full", chartHeight: 288, xAxisHeight: 150, angle: -45 }),
  xtall:  Object.freeze({ className: "h-96 w-full", chartHeight: 384, xAxisHeight: 215, angle: -55 }),
  xxtall: Object.freeze({ className: "h-[30rem] w-full", chartHeight: 480, xAxisHeight: 280, angle: -60 }),
});

export function getBarHeightProps(height) {
  return BAR_HEIGHT_PROPS[height] || BAR_HEIGHT_PROPS.medium;
}