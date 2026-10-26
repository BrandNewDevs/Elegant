export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Gap between the Prompt and the bottom edge of the usable screen. */
const BOTTOM_MARGIN = 24;

/** Where the Prompt of the given size goes: horizontally centred at the bottom of the display's usable area. */
export function promptPosition(workArea: Rect, size: { width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - BOTTOM_MARGIN),
  };
}
